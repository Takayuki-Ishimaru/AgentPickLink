import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { IpcClient } from "../ipc/client.js";
import type { ProgressEvent, ProgressSink } from "../domain/progress.js";
import { DomainError } from "../domain/errors.js";
import {
  AliasSchema,
  deriveBindingFingerprint,
  type AgentKind,
  type BrowserAgentDefinition,
  type CapabilityClass
} from "../domain/agent.js";
import { WorkspaceConfigSchema } from "../domain/workspace.js";
import { slug } from "../domain/text.js";
import type { AppPaths } from "../config/paths.js";
import { loadRegistry, saveRegistry, updateRegistry } from "../config/registry.js";
import { loadGlobalConfig, saveGlobalConfig } from "../config/global-config.js";
import { loadApprovals, saveApprovals } from "../config/approvals.js";
import { atomicWrite } from "../config/storage.js";
import { initializeLocalState } from "../config/init.js";
import { GlobalConfigSchema, type GlobalConfig } from "../config/schema.js";
import { assertSupportedTopology, WorkspaceService } from "./workspace-service.js";
import { HealthService } from "./health-service.js";
import { ApprovalService } from "./approval-service.js";
import type { Incident } from "../observability/incidents.js";
// Type-only: see docs/ux-redesign.md §2.5 -- SetupService is bundled into the VS Code extension
// host and must never pull in anything under src/transports/browser (which transitively imports
// playwright-core). A `import type` is erased at compile time, so this carries no runtime import.
import type {
  CapturedAgent,
  DiscoveredAgent,
  DiscoveryResult,
  LocalStatePreparer
} from "../transports/transport.js";
import type { ToolError } from "../frontend/schemas.js";
import { toToolError } from "../cli/ui/formatter.js";
import { BROKER_STOP_TIMEOUT_MS, waitForDescriptorGone } from "../broker/broker-lifecycle.js";
import { readDescriptor } from "../broker/broker-descriptor.js";

/** Whole-run budget for `agent.discover`: the store pass is card by card. */
const DISCOVERY_TIMEOUT_MS = 900_000;
/** Keep the setup panel informed while local state, broker connection, or auth checks are slow. */
const SETUP_PROGRESS_HEARTBEAT_MS = 5_000;

type SetupProgressReporter = {
  emitConnecting(message: string): void;
  forward(event: ProgressEvent): void;
  dispose(): void;
};

/**
 * Adds setup-owned progress around the operations that happen before broker progress exists.
 * The sink is caller/UI code, so a sink failure must never fail setup itself.  A timer is only
 * created when a sink was supplied; this keeps ordinary callers free of a background handle.
 */
function createSetupProgressReporter(onProgress?: ProgressSink): SetupProgressReporter {
  if (!onProgress) {
    return {
      emitConnecting: () => undefined,
      forward: () => undefined,
      dispose: () => undefined
    };
  }

  const startedAt = Date.now();
  let latestEvent: ProgressEvent = { phase: "connecting", message: "Working" };
  const emitSafely = (event: ProgressEvent): void => {
    try {
      onProgress(event);
    } catch {
      // Progress is advisory; a UI sink must not interrupt setup or leave its timer running.
    }
  };
  const emitConnecting = (message: string): void => {
    latestEvent = { phase: "connecting", message, elapsedMs: Date.now() - startedAt };
    emitSafely(latestEvent);
  };
  const forward = (event: ProgressEvent): void => {
    latestEvent = event;
    emitSafely(event);
  };
  const timer = setInterval(() => {
    emitSafely({
      ...latestEvent,
      message: `${latestEvent.message ?? latestEvent.phase} (still working)`,
      elapsedMs: Date.now() - startedAt
    });
  }, SETUP_PROGRESS_HEARTBEAT_MS);
  timer.unref?.();

  return {
    emitConnecting,
    forward,
    dispose: () => clearInterval(timer)
  };
}

export type BrowserDetection = {
  channel: string;
  installed: boolean;
  executable?: string;
  alternatives: Array<{ channel: string; installed: boolean }>;
};
export type EnsureBrowserChannelResult = {
  /** True when the configured channel was replaced by an installed alternative. */
  changed: boolean;
  /** The channel now in effect. */
  channel: string;
  /** The channel that was configured before (only when `changed`). */
  previous?: string;
  /** True when the broker must be restarted for the change to take effect. */
  restartRequired: boolean;
};
/** Preference order when the configured browser is missing: the production default first. */
const CHANNEL_PREFERENCE = ["msedge", "chrome", "chromium"] as const;

export type SetupDeps = {
  paths: AppPaths;
  /** Connect-or-start the broker. The CLI wires this to `connectOrStartDefaultBroker`; a VS
   * Code extension wires it to `connectOrStartBroker(paths, <its own spawn>, timeoutMs)` (see
   * src/broker/broker-lifecycle.ts). */
  connect: () => Promise<IpcClient>;
  /** Best-effort existing-broker probe used only by `status()`, which must never start a broker.
   * Absent (or throwing) is treated the same as "no broker": `broker.live` is reported false. */
  connectExisting?: () => Promise<IpcClient | undefined>;
  preparer: LocalStatePreparer;
  clock?: () => Date;
  root: () => string;
  /** Browser detection seam (defaults to HealthService.browser); injected so tests stay deterministic. */
  detectBrowser?: (channel: string) => Promise<BrowserDetection>;
};

export type AgentCandidate = {
  key: string; // stableAgentId ?? url
  url: string;
  displayName: string;
  stableAgentId?: string;
  surface: "m365-copilot" | "teams-web";
  description?: string;
  source: DiscoveredAgent["source"] | "registry";
  registered?: {
    alias: string;
    verified: boolean;
    enabled: boolean;
    kind: AgentKind;
    capabilityClass: CapabilityClass;
    description?: string;
    usageHint?: string;
  };
  assigned: boolean; // present in this workspace's .m365-agents.json
  /** The workspace report's per-alias status (`ready`, `approval-required`, `binding-mismatch`,
   * ...; see HealthService.workspaceReport's AssignmentStatus) -- present only when `assigned` is
   * true. Lets the panel show something more useful than a plain "assigned" badge. */
  assignmentStatus?: string;
};

export type SetupStatus = {
  platform: { os: string; supported: boolean; note?: string };
  browser: {
    channel: string;
    installed: boolean;
    alternatives: Array<{ channel: string; installed: boolean }>;
  };
  broker: { live: boolean; authState?: { state: string; checkedAt: string }; incidents: Incident[] };
  config: {
    headless: boolean;
    appHosts: string[];
    downloadHosts: string[];
    acceptDownloads: boolean;
    allowedCapabilityClasses: string[];
    /** G5: shown (and editable) in the panel's "Advanced" section via `updateConfig()`. */
    attachmentRetentionHours: number;
    attachmentQuotaBytes: number;
  };
  workspace: { root: string; configured: boolean; approvalStatus: string; assignments: unknown[] };
  registry: AgentCandidate[]; // registered agents as candidates (source "registry")
};

export type ApplyPlanAgent = {
  url: string;
  alias?: string;
  displayName: string;
  description?: string;
  usageHint?: string;
  kind?: AgentKind;
  capabilityClass?: Exclude<CapabilityClass, "unknown">;
};

export type ApplyPlan = {
  agents: ApplyPlanAgent[];
  downloadHosts?: string[];
  acceptDownloads?: boolean;
};

export type ApplyResult = {
  registered: Array<{ alias: string; displayName: string; verified: boolean; error?: ToolError }>;
  workspaceFile: string;
  approved: boolean;
  approvedBindings: unknown[];
  /** Whether the broker must be restarted for this call's config changes to take effect (see
   * `computeBrokerScopedConfigChanges` below): the broker reads `GlobalConfig` once at `start()`
   * and never re-reads it while running. */
  restartRequired: boolean;
  /** Dotted broker-scoped config paths that changed (`browser.acceptDownloads`,
   * `navigation.downloadHosts`, `security.allowedCapabilityClasses`, ...), for logging only -- never
   * values, which could carry a locally configured host list a caller might consider sensitive. */
  changedKeys: string[];
};

/** Returned by `updateConfig()`, mirroring `ApplyResult`'s restart-signaling fields. */
export type UpdateConfigResult = {
  restartRequired: boolean;
  changedKeys: string[];
};

/** G3: `updateAgentMetadata()`'s patch. Every field is optional -- an absent field leaves the
 * existing registry value untouched, an empty string clears an optional one (`description`/
 * `usageHint`), and `capabilityClass` never accepts `"unknown"` (there is nothing sensible to set
 * it back to from the panel). */
export type AgentMetadataPatch = {
  displayName?: string;
  description?: string;
  usageHint?: string;
  capabilityClass?: Exclude<CapabilityClass, "unknown">;
};

/** A sha256 placeholder overwritten immediately after the definition it belongs to is fully
 * built (deriveBindingFingerprint needs the finished object as input) -- same convention as
 * src/cli/commands/agent-add.ts. */
const PLACEHOLDER_FINGERPRINT = `sha256:${"0".repeat(64)}`;

/**
 * §2.5. Everything the VS Code extension's "Set up environment" panel needs, expressed without
 * any dependency on the browser layer: file stores (config/registry/approvals/workspace) plus an
 * IPC client the caller supplies (connect-or-start). This lets the same class run inside the CLI
 * process and inside the extension host, where importing src/transports/browser (and therefore
 * playwright-core) is not allowed -- see the module-level `import type` note above.
 */
export class SetupService {
  private readonly workspaces = new WorkspaceService();
  private readonly clock: () => Date;
  /** Set by `cancelSignIn()` and consulted by `ensureSignedIn()`'s `browser.login` catch clause
   * only -- see both methods' doc comments. Reset before and after every interactive login
   * attempt so a stale cancellation can never leak into a later, unrelated one. */
  private cancelRequested = false;
  private discoveryOperation?: { id: string; cancelled: boolean };

  constructor(private readonly deps: SetupDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Read-only report: never starts the broker or the browser. `broker.live` is false whenever
   * `connectExisting` is absent, throws, or resolves to no client. */
  async status(): Promise<SetupStatus> {
    const health = new HealthService({
      paths: this.deps.paths,
      preparer: this.deps.preparer,
      workspaces: this.workspaces
    });

    let platform: SetupStatus["platform"];
    try {
      const topology = health.topology();
      platform = { os: topology.platform, supported: topology.supported, note: topology.note };
    } catch (error) {
      platform = {
        os: process.platform,
        supported: false,
        note: error instanceof DomainError ? error.message : "The local topology could not be checked."
      };
    }

    const config = await loadGlobalConfig(this.deps.paths);
    const browserDetection = await health.browser(config.browser.channel);

    let brokerLive = false;
    let authState: { state: string; checkedAt: string } | undefined;
    let incidents: Incident[] = [];
    if (this.deps.connectExisting) {
      let client: IpcClient | undefined;
      try {
        client = await this.deps.connectExisting();
      } catch {
        client = undefined;
      }
      if (client) {
        try {
          const brokerHealth = (await client.call("broker.health", {})) as {
            authState?: { state: string; checkedAt: string };
            incidents?: Incident[];
          };
          brokerLive = true;
          authState = brokerHealth.authState;
          incidents = brokerHealth.incidents ?? [];
        } finally {
          client.close();
        }
      }
    }

    const root = this.deps.root();
    let configured = true;
    let approvalStatus = "not-configured";
    let assignments: Array<{ alias: string; status?: string }> = [];
    try {
      const report = (await health.workspaceReport(root)) as {
        approvalStatus: string;
        assignments: Array<{ alias: string; status?: string }>;
      };
      approvalStatus = report.approvalStatus;
      assignments = report.assignments;
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "WORKSPACE_NOT_CONFIGURED") throw error;
      configured = false;
    }
    const assignedAliases = new Set(assignments.map((item) => item.alias));
    const assignmentStatusByAlias = new Map(assignments.map((item) => [item.alias, item.status]));

    const registry = await loadRegistry(this.deps.paths);

    return {
      platform,
      browser: {
        channel: browserDetection.channel,
        installed: browserDetection.installed,
        alternatives: browserDetection.alternatives
      },
      broker: { live: brokerLive, ...(authState ? { authState } : {}), incidents },
      config: {
        headless: true,
        appHosts: [...config.navigation.appHosts],
        downloadHosts: [...config.navigation.downloadHosts],
        acceptDownloads: config.browser.acceptDownloads,
        allowedCapabilityClasses: [...config.security.allowedCapabilityClasses],
        attachmentRetentionHours: config.security.attachmentRetentionHours,
        attachmentQuotaBytes: config.security.attachmentQuotaBytes
      },
      workspace: { root, configured, approvalStatus, assignments },
      registry: registry.agents.map((agent) =>
        this.toRegistryCandidate(agent, assignedAliases, assignmentStatusByAlias)
      )
    };
  }

  /** Checks `browser.authState` first; only opens the interactive sign-in window (`browser.login`)
   * when the caller allows it and the account is not already signed in. When `cancelSignIn()` is
   * called while the `browser.login` round trip is in flight, whatever error the broker settles
   * that call with is replaced with a single clean `AUTH_FAILED` carrying `details.cancelled` (see
   * `isSignInCancelledError`), so the caller never has to guess whether a given `AUTH_FAILED` was a
   * real failure or a deliberate cancellation. */
  async ensureSignedIn(opts: {
    interactive: boolean;
    timeoutMs?: number;
    onProgress?: ProgressSink;
    /** Show instructions before opening a visible window. False cancels without launching it. */
    beforeInteractiveLogin?: () => Promise<boolean>;
  }): Promise<{ state: string }> {
    const progress = createSetupProgressReporter(opts.onProgress);
    try {
      progress.emitConnecting("Preparing local state");
      await this.prepare();
      progress.emitConnecting("Connecting to broker");
      const client = await this.deps.connect();
      try {
        progress.emitConnecting("Checking sign-in status");
        const current = (await client.call("browser.authState", {})) as { state: string };
        if (current.state === "authenticated") return { state: current.state };
        if (!opts.interactive) throw new DomainError("AUTH_REQUIRED", "Microsoft 365 sign-in is required.");
        this.cancelRequested = false;
        if (opts.beforeInteractiveLogin) {
          progress.emitConnecting("Waiting for sign-in confirmation");
          if (!(await opts.beforeInteractiveLogin())) throw signInCancelledError();
        }
        if (this.cancelRequested) throw signInCancelledError();
        let result: { authenticated: boolean; state: string };
        try {
          result = (await client.call(
            "browser.login",
            { timeoutMs: opts.timeoutMs ?? 300_000 },
            undefined,
            undefined,
            opts.onProgress ? { onProgress: progress.forward } : undefined
          )) as { authenticated: boolean; state: string };
        } catch (error) {
          if (this.cancelRequested) throw signInCancelledError();
          throw error;
        }
        return { state: result.state };
      } finally {
        client.close();
        this.cancelRequested = false;
      }
    } finally {
      progress.dispose();
    }
  }

  /**
   * G1: interrupts an in-flight `ensureSignedIn({ interactive: true })` call by asking the broker
   * to cancel the pending `browser.login` (a separate IPC connection, since the one running
   * `ensureSignedIn` is blocked awaiting that call's result). Never starts a broker just to cancel a
   * sign-in that cannot be happening if none is running -- prefers `connectExisting` and reports
   * `{ cancelled: false }` rather than failing when no broker is reachable at all.
   */
  async cancelSignIn(): Promise<{ cancelled: boolean }> {
    this.cancelRequested = true;
    let client: IpcClient | undefined;
    try {
      client = this.deps.connectExisting ? await this.deps.connectExisting() : await this.deps.connect();
    } catch {
      client = undefined;
    }
    if (!client) return { cancelled: false };
    try {
      return (await client.call("browser.cancelLogin", {})) as { cancelled: boolean };
    } finally {
      client.close();
    }
  }

  /** Enumerates agents visible to the signed-in account and merges them with the local registry
   * (see docs/ux-redesign.md §2.5): a discovered agent that matches a registry entry by
   * `stableAgentId` or canonical URL becomes one candidate carrying `registered`; every other
   * registry entry (not seen by discovery this time) is still returned, with `source: "registry"`. */
  async cancelDiscovery(): Promise<{ cancelled: boolean }> {
    const operation = this.discoveryOperation;
    if (!operation) return { cancelled: false };
    operation.cancelled = true;
    const client = await this.deps.connectExisting?.();
    if (!client) return { cancelled: true };
    try {
      await client.call("agent.cancelDiscovery", { operationId: operation.id });
    } finally {
      client.close();
    }
    return { cancelled: true };
  }

  async discover(onProgress?: ProgressSink): Promise<{
    candidates: AgentCandidate[];
    warnings: string[];
    /** Hostnames the broker observed on the landing page that look like file/download hosts (see
     * `DiscoveryResult.suggestedDownloadHosts`), forwarded unchanged for the panel to offer as a
     * pre-fill (G4) -- never applied to config here. Omitted when there is nothing to suggest. */
    suggestedDownloadHosts?: string[];
  }> {
    const operation = { id: randomUUID(), cancelled: false };
    this.discoveryOperation = operation;
    const progress = createSetupProgressReporter(onProgress);
    try {
      progress.emitConnecting("Preparing local state");
      await this.prepare();
      progress.emitConnecting("Connecting to broker");
      const client = await this.deps.connect();
      let result: DiscoveryResult;
      try {
        progress.emitConnecting("Starting agent discovery");
        // Strategy D resolves the agent store card by card (each card gets a few seconds), so the
        // budget is the IPC schema's maximum minus a margin; progress events keep the panel informed.
        if (operation.cancelled) result = { agents: [], warnings: ["discovery-cancelled"] };
        else
          result = (await client.call(
            "agent.discover",
            { timeoutMs: DISCOVERY_TIMEOUT_MS, operationId: operation.id },
            undefined,
            undefined,
            onProgress ? { onProgress: progress.forward } : undefined
          )) as DiscoveryResult;
      } finally {
        client.close();
      }

      // Only descriptions actually read from Microsoft 365 replace stored metadata. Missing text
      // can mean a partial discovery and must not erase a cached description for MCP clients.
      const registry = await updateRegistry(this.deps.paths, (current) => {
        let changed = false;
        for (const agent of current.agents) {
          const discovered = result.agents.find((entry) => matchesDiscoveredAgent(agent, entry));
          if (discovered?.description !== undefined && agent.description !== discovered.description) {
            agent.description = discovered.description;
            changed = true;
          }
        }
        return changed;
      });
      const root = this.deps.root();
      const { assignedAliases, assignmentStatusByAlias } = await this.workspaceAssignmentState(root);

      const matchedIndexes = new Set<number>();
      const discoveredCandidates: AgentCandidate[] = result.agents.map((discovered) => {
        const matchIndex = registry.agents.findIndex(
          (entry, index) => !matchedIndexes.has(index) && matchesDiscoveredAgent(entry, discovered)
        );
        const match = matchIndex >= 0 ? registry.agents[matchIndex] : undefined;
        if (match) matchedIndexes.add(matchIndex);
        const assigned = match ? assignedAliases.has(match.alias) : false;
        return {
          key: discovered.stableAgentId ?? discovered.url,
          url: discovered.url,
          displayName: discovered.displayName,
          stableAgentId: discovered.stableAgentId,
          surface: discovered.surface,
          description: discovered.description,
          source: discovered.source,
          registered: match ? this.toRegistered(match) : undefined,
          assigned,
          assignmentStatus: match && assigned ? assignmentStatusByAlias.get(match.alias) : undefined
        };
      });

      const unmatchedRegistryCandidates = registry.agents
        .filter((_, index) => !matchedIndexes.has(index))
        .map((agent) => this.toRegistryCandidate(agent, assignedAliases, assignmentStatusByAlias));

      return {
        candidates: [...discoveredCandidates, ...unmatchedRegistryCandidates],
        warnings: result.warnings,
        ...(result.suggestedDownloadHosts && result.suggestedDownloadHosts.length > 0
          ? { suggestedDownloadHosts: result.suggestedDownloadHosts }
          : {})
      };
    } finally {
      if (this.discoveryOperation === operation) this.discoveryOperation = undefined;
      progress.dispose();
    }
  }

  /**
   * Verifies (or reuses) each requested agent, writes the registry, applies the download-host and
   * capability-class policy implications, writes `.m365-agents.json`, and approves it locally. A
   * single failing agent is reported in `registered[].error` and left out of the workspace file
   * rather than aborting the whole call; if every requested agent fails, the first error is thrown.
   */
  async apply(plan: ApplyPlan, onProgress?: ProgressSink): Promise<ApplyResult> {
    await this.prepare();

    const registry = await loadRegistry(this.deps.paths);
    const config = await loadGlobalConfig(this.deps.paths);
    const takenAliases = new Set(registry.agents.map((agent) => agent.alias));
    const registered: ApplyResult["registered"] = [];
    const finalAgents: BrowserAgentDefinition[] = [];
    let firstError: unknown;
    const total = plan.agents.length;

    let client: IpcClient | undefined;
    try {
      for (let index = 0; index < total; index += 1) {
        const planAgent = plan.agents[index];
        onProgress?.({ phase: "verifying", current: index + 1, total, message: planAgent.displayName });
        try {
          const reused = findReusableEntry(registry.agents, planAgent);
          let finalEntry: BrowserAgentDefinition;
          if (reused) {
            finalEntry = applyReuse(reused, planAgent);
            // A registry entry can predate a discovery fix and carry a UI control label as its
            // verified display name. Re-check only when the current discovery name disagrees;
            // matching names retain the cheap reuse path. The browser's inspect result is the
            // authority, never the plan (which may contain a stale webview value).
            if (
              normalizeAgentName(planAgent.displayName) !==
              normalizeAgentName(reused.verification.expectedDisplayName)
            ) {
              client ??= await this.deps.connect();
              const captured = (await client.call("agent.inspectUrl", {
                url: planAgent.url
              })) as CapturedAgent;
              finalEntry = repairReusedEntry(reused, finalEntry, captured, this.clock);
            }
          } else {
            client ??= await this.deps.connect();
            const captured = (await client.call("agent.inspectUrl", { url: planAgent.url })) as CapturedAgent;
            finalEntry = buildNewEntry(planAgent, captured, takenAliases, this.clock);
            takenAliases.add(finalEntry.alias);
          }
          finalAgents.push(finalEntry);
          registered.push({ alias: finalEntry.alias, displayName: finalEntry.displayName, verified: true });
        } catch (error) {
          firstError ??= error;
          registered.push({
            alias: fallbackAlias(planAgent),
            displayName: planAgent.displayName,
            verified: false,
            error: toToolError(error)
          });
        }
      }
    } finally {
      client?.close();
    }
    onProgress?.({ phase: "done" });

    if (total > 0 && finalAgents.length === 0) throw firstError;

    const allowedCapabilityClasses = new Set(config.security.allowedCapabilityClasses);
    if (finalAgents.some((agent) => agent.capabilityClass === "actions-possible"))
      allowedCapabilityClasses.add("actions-possible");
    const configCandidate: unknown = {
      ...config,
      security: { ...config.security, allowedCapabilityClasses: [...allowedCapabilityClasses] },
      browser: { ...config.browser, acceptDownloads: plan.acceptDownloads ?? config.browser.acceptDownloads },
      navigation: {
        ...config.navigation,
        downloadHosts: plan.downloadHosts ?? config.navigation.downloadHosts
      }
    };
    const parsedConfig = GlobalConfigSchema.safeParse(configCandidate);
    if (!parsedConfig.success)
      throw new DomainError(
        "INVALID_ARGUMENT",
        parsedConfig.error.issues[0]?.message ?? "The configuration patch is invalid."
      );
    const changedKeys = computeBrokerScopedConfigChanges(config, parsedConfig.data);
    await saveGlobalConfig(this.deps.paths, parsedConfig.data);

    const byAlias = new Map(finalAgents.map((agent) => [agent.alias, agent]));
    registry.agents = [...registry.agents.filter((agent) => !byAlias.has(agent.alias)), ...finalAgents].sort(
      (a, b) => a.alias.localeCompare(b.alias)
    );
    await saveRegistry(this.deps.paths, registry);

    const root = this.deps.root();
    const workspaceFilePath = path.join(root, ".m365-agents.json");
    let workspaceFileExists = await fileExists(workspaceFilePath);
    if (finalAgents.length > 0) {
      const workspaceConfig = WorkspaceConfigSchema.parse({
        version: 1,
        agents: finalAgents
          .map((agent) => ({ alias: agent.alias, bindingFingerprint: agent.verification.bindingFingerprint }))
          .sort((a, b) => a.alias.localeCompare(b.alias))
      });
      await atomicWrite(workspaceFilePath, `${JSON.stringify(workspaceConfig, null, 2)}\n`);
      workspaceFileExists = true;
    }

    let approved = false;
    let approvedBindings: unknown[] = [];
    if (workspaceFileExists) {
      const workspace = await this.workspaces.load(root);
      const approvalStore = await loadApprovals(this.deps.paths);
      const approvalService = new ApprovalService(
        approvalStore,
        parsedConfig.data.security.allowedCapabilityClasses
      );
      const approval = approvalService.approve(workspace, registry.agents);
      await saveApprovals(this.deps.paths, approvalStore);
      approved = true;
      approvedBindings = approval.approvedBindings;
    }

    return {
      registered,
      workspaceFile: workspaceFilePath,
      approved,
      approvedBindings,
      restartRequired: changedKeys.length > 0,
      changedKeys
    };
  }

  /**
   * G3: deletes `alias` from the local registry. When it is also assigned to this workspace, it is
   * dropped from `.m365-agents.json` too and the remaining roster is re-approved (so the agents the
   * user did not touch stay approved rather than falling back to "approval-required" because the
   * approval's binding list no longer matches the now-shorter workspace file). A registry-only
   * agent (never assigned here) only ever touches the registry.
   */
  async removeAgent(alias: string): Promise<SetupStatus> {
    await this.prepare();
    const parsedAlias = AliasSchema.safeParse(alias);
    if (!parsedAlias.success)
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Agent alias must be lowercase alphanumeric with optional hyphens."
      );
    const registry = await loadRegistry(this.deps.paths);
    if (!registry.agents.some((agent) => agent.alias === parsedAlias.data))
      throw new DomainError("AGENT_NOT_FOUND", `Agent ${parsedAlias.data} is not in the local registry.`);
    registry.agents = registry.agents.filter((agent) => agent.alias !== parsedAlias.data);
    await saveRegistry(this.deps.paths, registry);

    const root = this.deps.root();
    const workspaceFilePath = path.join(root, ".m365-agents.json");
    if (await fileExists(workspaceFilePath)) {
      const workspace = await this.workspaces.load(root);
      if (workspace.config.agents.some((entry) => entry.alias === parsedAlias.data)) {
        const nextConfig = WorkspaceConfigSchema.parse({
          version: 1,
          agents: workspace.config.agents.filter((entry) => entry.alias !== parsedAlias.data)
        });
        await atomicWrite(workspaceFilePath, `${JSON.stringify(nextConfig, null, 2)}\n`);
        // Re-load so `approve()` sees the just-written (shorter) agent list rather than the
        // in-memory `workspace` captured before the write.
        const reloaded = await this.workspaces.load(root);
        const approvalStore = await loadApprovals(this.deps.paths);
        const config = await loadGlobalConfig(this.deps.paths);
        const approvalService = new ApprovalService(approvalStore, config.security.allowedCapabilityClasses);
        approvalService.approve(reloaded, registry.agents);
        await saveApprovals(this.deps.paths, approvalStore);
      }
    }
    return this.status();
  }

  /** G3: removes this workspace's local approval only -- `.m365-agents.json` is left untouched, so
   * the next Save (or `m365-agent workspace approve`) can re-approve the same roster without
   * rediscovering or re-verifying anything. Best-effort closes any open conversations for this
   * workspace on a reachable broker; a broker that is not running has nothing to close. */
  async revokeWorkspace(): Promise<SetupStatus> {
    await this.prepare();
    const root = this.deps.root();
    const workspace = await this.workspaces.load(root);
    const approvalStore = await loadApprovals(this.deps.paths);
    new ApprovalService(approvalStore).revoke(workspace.workspaceKey);
    await saveApprovals(this.deps.paths, approvalStore);

    let client: IpcClient | undefined;
    try {
      client = await this.deps.connectExisting?.();
    } catch {
      client = undefined;
    }
    if (client) {
      try {
        await client.call("conversation.closeAllForWorkspace", { root: workspace.root });
      } catch {
        /* the local approval is already revoked regardless of whether this best-effort call lands */
      } finally {
        client.close();
      }
    }
    return this.status();
  }

  /**
   * G3: edits display metadata (and optionally the capability class) of an already-registered
   * agent. The binding fingerprint is intentionally left untouched: it is derived only from
   * transport/entryPoint/verification (see domain/agent.ts's canonicalBindingIdentity), never from
   * displayName/description/usageHint/capabilityClass, so none of this call's fields can ever make
   * the stored fingerprint stale. When `capabilityClass` actually changes on an agent that is both
   * assigned to this workspace and already locally approved, the workspace is re-approved so the
   * approval's recorded capability class stays in sync (widening
   * `security.allowedCapabilityClasses` first if the new class needs it, the same policy
   * implication `apply()` applies when it introduces an actions-possible agent). An agent that is
   * not both assigned and approved is left with its existing approval state untouched -- editing
   * metadata must never itself grant an approval the user never gave.
   */
  async updateAgentMetadata(alias: string, patch: AgentMetadataPatch): Promise<SetupStatus> {
    await this.prepare();
    const parsedAlias = AliasSchema.safeParse(alias);
    if (!parsedAlias.success)
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Agent alias must be lowercase alphanumeric with optional hyphens."
      );
    const registry = await loadRegistry(this.deps.paths);
    const index = registry.agents.findIndex((agent) => agent.alias === parsedAlias.data);
    if (index < 0)
      throw new DomainError("AGENT_NOT_FOUND", `Agent ${parsedAlias.data} is not in the local registry.`);
    const existing = registry.agents[index];
    const capabilityChanged =
      patch.capabilityClass !== undefined && patch.capabilityClass !== existing.capabilityClass;
    const next: BrowserAgentDefinition = {
      ...existing,
      displayName: patch.displayName?.trim() || existing.displayName,
      description:
        patch.description !== undefined ? patch.description.trim() || undefined : existing.description,
      usageHint: patch.usageHint !== undefined ? patch.usageHint.trim() || undefined : existing.usageHint,
      capabilityClass: patch.capabilityClass ?? existing.capabilityClass
    };
    registry.agents = [...registry.agents.slice(0, index), next, ...registry.agents.slice(index + 1)];
    await saveRegistry(this.deps.paths, registry);

    if (capabilityChanged) await this.reapproveIfAssignedAndApproved(parsedAlias.data, registry.agents);
    return this.status();
  }

  /** Resets the dedicated automation profile and stops the broker. Does not claim to revoke any
   * Microsoft 365 session globally -- only the local automation profile is signed out. */
  async signOut(): Promise<void> {
    await this.prepare();
    const client = await this.deps.connect();
    // Capture the owner after connect-or-start has settled, before shutdown can be observed as a
    // descriptor replacement. Waiting for this exact instance avoids blocking on a successor.
    const owner = await readDescriptor(this.deps.paths).catch(() => undefined);
    let shutdownError: unknown;
    let shutdownRequested = false;
    try {
      await client.call("browser.resetProfile", {});
      try {
        shutdownRequested = true;
        await client.call("broker.shutdown", {});
      } catch (error) {
        shutdownError = error;
      }
    } finally {
      client.close();
    }
    if (
      shutdownRequested &&
      !(await waitForDescriptorGone(this.deps.paths, owner?.instanceId, BROKER_STOP_TIMEOUT_MS))
    )
      throw (
        shutdownError ??
        new DomainError("BROKER_UNAVAILABLE", "The broker did not finish stopping before the timeout.", true)
      );
  }

  /**
   * Stops a reachable broker and waits for its descriptor to disappear (polling
   * `connectExisting` -- `undefined` means fully gone; a resolved client means it is still
   * answering normally; a thrown `BROKER_UNAVAILABLE` means the descriptor is present but the pipe
   * is not accepting connections, i.e. "live but unreachable" -- both of the latter keep the loop
   * going), then connects (starting a fresh one if needed). If the previous process never releases
   * its endpoint before the deadline, throws `BROKER_UNAVAILABLE` with a manual-recovery
   * remediation rather than starting a second broker alongside a wedged one. Mirrors `m365-agent
   * broker restart` (src/cli/commands/broker.ts), using the shared descriptor state marker to grant
   * a graceful current broker the full bounded drain budget while retaining a short fallback for
   * older descriptors.
   */
  async restartBroker(): Promise<void> {
    await this.prepare();
    const initialDescriptor = await readDescriptor(this.deps.paths).catch(() => undefined);
    const previousInstanceId = initialDescriptor?.instanceId;
    let existing: IpcClient | undefined;
    try {
      existing = await this.deps.connectExisting?.();
    } catch {
      existing = undefined;
    }
    let shutdownError: unknown;
    if (existing) {
      try {
        await existing.call("broker.shutdown", {});
      } catch (error) {
        // The listener may close before the shutdown response reaches this client. Keep waiting
        // on descriptor ownership; only surface this error if the owner fails to disappear.
        shutdownError = error;
      } finally {
        existing.close();
      }
    }
    const stoppingDescriptor = await readDescriptor(this.deps.paths).catch(() => undefined);
    // New brokers publish `state: stopping` before closing IPC and may drain a full browser
    // response budget. Older descriptors have no state marker, so retain the short bounded
    // fallback rather than waiting indefinitely on a wedged installed broker.
    const deadline =
      Date.now() + (stoppingDescriptor?.state === "stopping" ? BROKER_STOP_TIMEOUT_MS : 10_000);
    let gone = false;
    while (Date.now() < deadline) {
      let probe: IpcClient | undefined;
      try {
        probe = await this.deps.connectExisting?.();
      } catch {
        // Live but unreachable: the descriptor is still there and the previous process has not
        // finished shutting down. Keep waiting rather than treating this as "gone".
        await delay(50);
        continue;
      }
      const currentDescriptor = await readDescriptor(this.deps.paths).catch(() => undefined);
      probe?.close();
      if (
        !currentDescriptor ||
        (previousInstanceId !== undefined && currentDescriptor.instanceId !== previousInstanceId)
      ) {
        gone = true;
        break;
      }
      await delay(50);
    }
    if (!gone)
      throw shutdownError instanceof DomainError
        ? shutdownError
        : new DomainError(
            "BROKER_UNAVAILABLE",
            "The previous broker process did not release its endpoint before the timeout.",
            true,
            { remediation: "run: m365-agent broker restart" }
          );
    const next = await this.deps.connect();
    next.close();
  }

  /**
   * G5: also accepts `attachmentRetentionHours`/`attachmentQuotaBytes` (docs/ux-redesign.md's
   * upcoming `security.*` config keys). Those two are spread onto `config.security` only when the
   * caller actually supplies a value -- `security` is a `.strict()` zod object, so introducing the
   * key at all before the schema declares it would fail validation; omitting it when absent instead
   * tolerates the field's absence at the type level (`GlobalConfig["security"]` may not yet declare
   * it) without ever depending on its current shape.
   */
  /**
   * Makes the configured browser channel usable before anything tries to launch it: when the
   * configured channel is not installed but an alternative is, switch the config to the first
   * installed alternative (msedge > chrome > chromium) and report the change so the caller can
   * restart the broker and tell the user. When nothing is installed, fail with BROWSER_START_FAILED
   * and a remediation that names what to install -- before a confusing launch error can happen.
   */
  async ensureBrowserChannel(): Promise<EnsureBrowserChannelResult> {
    const config = await loadGlobalConfig(this.deps.paths);
    const detect =
      this.deps.detectBrowser ??
      ((channel: string) =>
        new HealthService({ paths: this.deps.paths, preparer: this.deps.preparer }).browser(
          channel as GlobalConfig["browser"]["channel"]
        ));
    const detection = await detect(config.browser.channel);
    if (detection.installed)
      return { changed: false, channel: config.browser.channel, restartRequired: false };
    const installed = new Set(
      detection.alternatives.filter((item) => item.installed).map((item) => item.channel)
    );
    const replacement = CHANNEL_PREFERENCE.find((channel) => installed.has(channel));
    if (!replacement)
      throw new DomainError(
        "BROWSER_START_FAILED",
        `The configured browser (${config.browser.channel}) is not installed and no supported alternative was found.`,
        false,
        {
          remediation:
            "Install Microsoft Edge (or Google Chrome), then run the setup again. The browser channel can be changed in the AgentPickLink panel's Advanced settings."
        }
      );
    const result = await this.updateConfig({ channel: replacement });
    return {
      changed: true,
      channel: replacement,
      previous: config.browser.channel,
      restartRequired: result.restartRequired
    };
  }

  async updateConfig(patch: {
    downloadHosts?: string[];
    acceptDownloads?: boolean;
    channel?: string;
    headless?: boolean;
    attachmentRetentionHours?: number;
    attachmentQuotaBytes?: number;
  }): Promise<UpdateConfigResult> {
    const config = await loadGlobalConfig(this.deps.paths);
    const candidate: unknown = {
      ...config,
      browser: {
        ...config.browser,
        channel: patch.channel ?? config.browser.channel,
        headless: patch.headless ?? config.browser.headless,
        acceptDownloads: patch.acceptDownloads ?? config.browser.acceptDownloads
      },
      navigation: {
        ...config.navigation,
        downloadHosts: patch.downloadHosts ?? config.navigation.downloadHosts
      },
      security: {
        ...config.security,
        ...(patch.attachmentRetentionHours !== undefined
          ? { attachmentRetentionHours: patch.attachmentRetentionHours }
          : {}),
        ...(patch.attachmentQuotaBytes !== undefined
          ? { attachmentQuotaBytes: patch.attachmentQuotaBytes }
          : {})
      }
    };
    const parsed = GlobalConfigSchema.safeParse(candidate);
    if (!parsed.success)
      throw new DomainError("INVALID_ARGUMENT", parsed.error.issues[0]?.message ?? "Invalid configuration.");
    const changedKeys = computeBrokerScopedConfigChanges(config, parsed.data);
    await saveGlobalConfig(this.deps.paths, parsed.data);
    return { restartRequired: changedKeys.length > 0, changedKeys };
  }

  private async prepare(): Promise<void> {
    assertSupportedTopology();
    await initializeLocalState(this.deps.paths, this.deps.preparer);
  }

  /** Shared by `status()`/`discover()`: this workspace's assigned aliases and, for each, its
   * `HealthService.workspaceReport` status (see `AgentCandidate.assignmentStatus`). An unconfigured
   * workspace (no `.m365-agents.json` yet) is reported as "nothing assigned" rather than thrown. */
  private async workspaceAssignmentState(
    root: string
  ): Promise<{ assignedAliases: Set<string>; assignmentStatusByAlias: Map<string, string> }> {
    try {
      const health = new HealthService({
        paths: this.deps.paths,
        preparer: this.deps.preparer,
        workspaces: this.workspaces
      });
      const report = (await health.workspaceReport(root)) as {
        assignments: Array<{ alias: string; status: string }>;
      };
      return {
        assignedAliases: new Set(report.assignments.map((item) => item.alias)),
        assignmentStatusByAlias: new Map(report.assignments.map((item) => [item.alias, item.status]))
      };
    } catch {
      return { assignedAliases: new Set(), assignmentStatusByAlias: new Map() };
    }
  }

  /** Shared tail of `updateAgentMetadata()`: re-approves the current registry roster for this
   * workspace, but only when `alias` is both assigned here and already locally approved -- see that
   * method's doc comment for why. */
  private async reapproveIfAssignedAndApproved(
    alias: string,
    agents: BrowserAgentDefinition[]
  ): Promise<void> {
    const root = this.deps.root();
    if (!(await fileExists(path.join(root, ".m365-agents.json")))) return;
    const workspace = await this.workspaces.load(root);
    if (!workspace.config.agents.some((entry) => entry.alias === alias)) return;
    const approvalStore = await loadApprovals(this.deps.paths);
    const approval = approvalStore.approvals.find((entry) => entry.workspaceKey === workspace.workspaceKey);
    if (!approval?.approvedBindings.some((binding) => binding.alias === alias)) return;

    let config = await loadGlobalConfig(this.deps.paths);
    const updated = agents.find((agent) => agent.alias === alias);
    if (
      updated?.capabilityClass === "actions-possible" &&
      !config.security.allowedCapabilityClasses.includes("actions-possible")
    ) {
      const candidate: unknown = {
        ...config,
        security: {
          ...config.security,
          allowedCapabilityClasses: [...config.security.allowedCapabilityClasses, "actions-possible"]
        }
      };
      const parsed = GlobalConfigSchema.safeParse(candidate);
      if (parsed.success) {
        await saveGlobalConfig(this.deps.paths, parsed.data);
        config = parsed.data;
      }
    }
    const approvalService = new ApprovalService(approvalStore, config.security.allowedCapabilityClasses);
    approvalService.approve(workspace, agents);
    await saveApprovals(this.deps.paths, approvalStore);
  }

  private toRegistered(agent: BrowserAgentDefinition): NonNullable<AgentCandidate["registered"]> {
    return {
      alias: agent.alias,
      verified: agent.verification.status === "verified",
      enabled: agent.enabled,
      kind: agent.kind,
      capabilityClass: agent.capabilityClass,
      description: agent.description,
      usageHint: agent.usageHint
    };
  }

  private toRegistryCandidate(
    agent: BrowserAgentDefinition,
    assignedAliases: Set<string>,
    assignmentStatusByAlias: ReadonlyMap<string, string | undefined> = new Map()
  ): AgentCandidate {
    const assigned = assignedAliases.has(agent.alias);
    return {
      key: agent.verification.expectedStableAgentId ?? agent.entryPoint.url,
      url: agent.entryPoint.url,
      displayName: agent.displayName,
      stableAgentId: agent.verification.expectedStableAgentId,
      surface: agent.entryPoint.surface,
      description: agent.description,
      source: "registry",
      registered: this.toRegistered(agent),
      assigned,
      assignmentStatus: assigned ? assignmentStatusByAlias.get(agent.alias) : undefined
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** G1: the shape `ensureSignedIn()` tags its cancellation `AUTH_FAILED` with. `DomainError`'s own
 * `options` bag (see domain/errors.ts's `ApplicationError`) has no generic "extra details" field
 * and this module must not add one there (out of scope for WP-D), so the marker is instead a plain
 * property bolted onto the thrown `DomainError` instance itself -- safe because this error is
 * thrown and caught entirely in-process (never serialized across the IPC boundary that
 * `ApplicationError`'s shape has to satisfy). */
type SignInCancelledDetails = { cancelled: true };

function signInCancelledError(): DomainError {
  return Object.assign(new DomainError("AUTH_FAILED", "Sign-in was cancelled.", false), {
    details: { cancelled: true } satisfies SignInCancelledDetails
  });
}

/** True when `error` is the `AUTH_FAILED` `ensureSignedIn()` throws after `cancelSignIn()`
 * interrupted an in-flight `browser.login` -- see both methods' doc comments. Exported so the panel
 * (src/extension/setup-view.ts) can render this as a neutral "sign-in cancelled" notice instead of
 * the red error banner. */
export function isSignInCancelledError(error: unknown): boolean {
  return (
    error instanceof DomainError &&
    error.code === "AUTH_FAILED" &&
    (error as DomainError & { details?: Partial<SignInCancelledDetails> }).details?.cancelled === true
  );
}

/** The `GlobalConfig` top-level sections the broker only ever reads once, in `start()`
 * (`src/broker/broker-server.ts`): a change under any of them needs a broker restart to take
 * effect on an already-running broker. */
const BROKER_SCOPED_SECTIONS = ["browser", "navigation", "conversations", "invocation"] as const;

/**
 * The broker-scoped config keys (dotted paths, e.g. `browser.headless`,
 * `navigation.downloadHosts`, `security.allowedCapabilityClasses`) that differ between two loaded
 * `GlobalConfig`s. Deliberately generic -- it diffs every key of `browser`/`navigation`/
 * `conversations`/`invocation` by value rather than naming them, so a config field a concurrent
 * change adds under one of those sections (see docs/ux-redesign.md) is covered without this file
 * needing to know its name. `security.*` is otherwise broker-agnostic policy the broker re-checks
 * per call (see PolicyService), so only `allowedCapabilityClasses` -- which gates which agents can
 * even be invoked -- is compared there.
 */
export function computeBrokerScopedConfigChanges(before: GlobalConfig, after: GlobalConfig): string[] {
  const changed: string[] = [];
  for (const section of BROKER_SCOPED_SECTIONS) {
    const beforeSection = before[section] as Record<string, unknown>;
    const afterSection = after[section] as Record<string, unknown>;
    const keys = new Set([...Object.keys(beforeSection), ...Object.keys(afterSection)]);
    for (const key of keys)
      if (JSON.stringify(beforeSection[key]) !== JSON.stringify(afterSection[key]))
        changed.push(`${section}.${key}`);
  }
  const beforeClasses = [...before.security.allowedCapabilityClasses].sort();
  const afterClasses = [...after.security.allowedCapabilityClasses].sort();
  if (JSON.stringify(beforeClasses) !== JSON.stringify(afterClasses))
    changed.push("security.allowedCapabilityClasses");
  return changed;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Normalizes a URL for candidate-matching purposes only (case-insensitive host, no fragment,
 * sorted query, no trailing slash). Not the same canonicalization the registry's binding
 * fingerprint uses (domain/agent.ts's canonicalBindingIdentity, which also strips
 * conversation/tracking query noise) -- this one only has to recognize "the same discovery/plan
 * URL", not derive a security-relevant identity. */
function canonicalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.searchParams.sort();
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.hostname.toLocaleLowerCase()}${url.port ? `:${url.port}` : ""}${pathname}${url.search}`;
  } catch {
    return value;
  }
}

function matchesDiscoveredAgent(entry: BrowserAgentDefinition, discovered: DiscoveredAgent): boolean {
  if (discovered.stableAgentId && entry.verification.expectedStableAgentId)
    return discovered.stableAgentId === entry.verification.expectedStableAgentId;
  return canonicalizeUrl(entry.entryPoint.url) === canonicalizeUrl(discovered.url);
}

/** An `ApplyPlanAgent` carries no `stableAgentId` (unlike `DiscoveredAgent`), so reuse can only
 * match by URL; a registry entry must also be enabled and already verified to be reusable. */
function findReusableEntry(
  agents: BrowserAgentDefinition[],
  planAgent: ApplyPlanAgent
): BrowserAgentDefinition | undefined {
  return agents.find(
    (agent) =>
      agent.enabled &&
      agent.verification.status === "verified" &&
      canonicalizeUrl(agent.entryPoint.url) === canonicalizeUrl(planAgent.url)
  );
}

function applyReuse(existing: BrowserAgentDefinition, planAgent: ApplyPlanAgent): BrowserAgentDefinition {
  const capabilityClass = planAgent.capabilityClass ?? existing.capabilityClass;
  if (capabilityClass === "unknown")
    throw new DomainError(
      "AGENT_CAPABILITY_BLOCKED",
      `Agent ${existing.alias} has no capability classification; provide one to continue.`
    );
  const next: BrowserAgentDefinition = {
    ...existing,
    description: planAgent.description ?? existing.description,
    usageHint: planAgent.usageHint ?? existing.usageHint,
    capabilityClass
  };
  // description/usageHint/capabilityClass never enter the fingerprint (see
  // domain/agent.ts's canonicalBindingIdentity), so this recomputes to the same value; it is
  // still done explicitly so a future change to that identity can never silently go stale here.
  next.verification = { ...next.verification, bindingFingerprint: deriveBindingFingerprint(next) };
  return next;
}

function normalizeAgentName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

/** Repairs stale display metadata without silently rebinding a verified URL to another agent. */
function repairReusedEntry(
  existing: BrowserAgentDefinition,
  reused: BrowserAgentDefinition,
  captured: CapturedAgent,
  clock: () => Date
): BrowserAgentDefinition {
  const capturedBinding = {
    ...existing,
    entryPoint: { ...existing.entryPoint, url: captured.url, surface: captured.surface },
    verification: {
      ...existing.verification,
      expectedStableAgentId: captured.stableAgentId,
      expectedSurface: captured.surface
    }
  };
  const sameIdentity =
    deriveBindingFingerprint(capturedBinding) === existing.verification.bindingFingerprint &&
    resolveAdapterId(captured.surface, existing.kind) === existing.verification.adapterId &&
    captured.surface === existing.verification.expectedSurface;
  const nameChanged =
    normalizeAgentName(captured.displayName) !==
    normalizeAgentName(existing.verification.expectedDisplayName);
  if (!sameIdentity)
    throw new DomainError(
      "AGENT_IDENTITY_UNVERIFIED",
      `The verified identity for ${existing.alias} changed; register the agent again before using it.`
    );
  if (nameChanged && !(captured.stableAgentId && existing.verification.expectedStableAgentId))
    throw new DomainError(
      "AGENT_IDENTITY_UNVERIFIED",
      `The verified identity for ${existing.alias} has no stable ID; register the agent again before using it.`
    );
  const repaired: BrowserAgentDefinition = {
    ...reused,
    verification: {
      ...reused.verification,
      expectedDisplayName: captured.displayName,
      validatedAt: clock().toISOString()
    }
  };
  if (deriveBindingFingerprint(repaired) !== existing.verification.bindingFingerprint)
    throw new DomainError(
      "AGENT_IDENTITY_UNVERIFIED",
      `The verified identity for ${existing.alias} changed; register the agent again before using it.`
    );
  repaired.verification.bindingFingerprint = existing.verification.bindingFingerprint;
  return repaired;
}

function buildNewEntry(
  planAgent: ApplyPlanAgent,
  captured: CapturedAgent,
  takenAliases: ReadonlySet<string>,
  clock: () => Date
): BrowserAgentDefinition {
  const kind = planAgent.kind ?? "m365-agent-builder";
  const capabilityClass = planAgent.capabilityClass ?? "knowledge-only";
  const alias = resolveUniqueAlias(planAgent.alias, planAgent.displayName, takenAliases);
  const provisional: BrowserAgentDefinition = {
    alias,
    displayName: planAgent.displayName,
    kind,
    transport: "browser",
    entryPoint: { mode: "direct-chat", url: captured.url, surface: captured.surface },
    description: planAgent.description,
    usageHint: planAgent.usageHint,
    enabled: true,
    capabilityClass,
    uiActionPolicy: "never-click",
    verification: {
      status: "verified",
      adapterId: resolveAdapterId(captured.surface, kind),
      expectedDisplayName: captured.displayName,
      expectedStableAgentId: captured.stableAgentId,
      expectedSurface: captured.surface,
      validatedUrlPattern: captured.validatedUrlPattern,
      bindingFingerprint: PLACEHOLDER_FINGERPRINT,
      validatedAt: clock().toISOString()
    }
  };
  provisional.verification.bindingFingerprint = deriveBindingFingerprint(provisional);
  return provisional;
}

/**
 * Mirrors `adapterIdFor()` in src/transports/browser/adapters/index.ts (kind-specific adapter
 * wins over a surface's generic fallback; surface always wins over kind). Duplicated rather than
 * imported: SetupService is bundled into the VS Code extension host and must never import
 * anything under src/transports/browser, which transitively pulls in playwright-core (see
 * docs/ux-redesign.md §2.5). Keep in sync with SUPPORTED_BROWSER_ADAPTER_IDS in domain/agent.ts.
 */
function resolveAdapterId(surface: "m365-copilot" | "teams-web", kind: AgentKind): string {
  if (surface === "teams-web") return "teams-web-agent-chat@1";
  if (kind === "m365-agent-builder") return "agent-builder-chat@1";
  if (kind === "copilot-studio") return "copilot-studio-m365-chat@1";
  return "m365-copilot-chat@1";
}

/** A provided alias must be valid and not already taken (an explicit choice colliding with an
 * existing agent is a per-agent error, reported in `registered[].error`, not silently renamed).
 * An alias derived from the display name is auto-uniquified with a `-2`, `-3`, ... suffix, since
 * collisions between machine-derived slugs are expected and not a user mistake. */
function resolveUniqueAlias(
  providedAlias: string | undefined,
  displayName: string,
  taken: ReadonlySet<string>
): string {
  if (providedAlias) {
    const parsed = AliasSchema.safeParse(providedAlias);
    if (!parsed.success)
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Agent alias must be lowercase alphanumeric with optional hyphens."
      );
    if (taken.has(parsed.data))
      throw new DomainError("INVALID_ARGUMENT", `Alias ${parsed.data} already exists.`);
    return parsed.data;
  }
  const base = slug(displayName);
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function fallbackAlias(planAgent: ApplyPlanAgent): string {
  return planAgent.alias ?? slug(planAgent.displayName);
}

// Re-exported so callers can type onProgress handlers without importing domain/progress.js
// themselves purely for this.
export type { ProgressEvent, ProgressSink };
