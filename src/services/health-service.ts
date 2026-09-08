import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadApprovals } from "../config/approvals.js";
import { loadGlobalConfig } from "../config/global-config.js";
import type { AppPaths } from "../config/paths.js";
import { assertSafeProfilePath } from "../config/profile-safety.js";
import { loadRegistry } from "../config/registry.js";
import type { GlobalConfig } from "../config/schema.js";
import { verifyPrivatePath } from "../config/storage.js";
import { readDescriptor } from "../broker/broker-descriptor.js";
import { deriveBindingFingerprint, SUPPORTED_BROWSER_ADAPTER_IDS } from "../domain/agent.js";
import { asDomainError, DomainError } from "../domain/errors.js";
import { BROKER_PROTOCOL } from "../ipc/protocol.js";
import type {
  LocalStatePreparer,
  TransportBrowserDescription,
  TransportDevMode,
  TransportHealth
} from "../transports/transport.js";
import type { TransportRouter } from "../transports/transport-router.js";
import { ApprovalService } from "./approval-service.js";
import { assertSupportedTopology, WorkspaceService } from "./workspace-service.js";

export type HealthDependencies = {
  paths: AppPaths;
  /** The transport that owns its local on-disk state (the dedicated browser profile). Injected
   * as the LocalStatePreparer contract, never as a concrete ProfileManager. Required for the
   * profile check; the broker, which only answers broker.health, does not supply one. */
  preparer?: LocalStatePreparer;
  /** Present in the broker (for `broker.health`); absent in the CLI, which asks a live broker. */
  router?: TransportRouter;
  instanceId?: string;
  environment?: NodeJS.ProcessEnv;
  workspaces?: WorkspaceService;
  /** Maps a thrown value into the shape the caller reports failures in (doctor passes its own
   * ToolError mapper). Defaults to the DomainError application-error shape. */
  toFailure?: (value: unknown) => unknown;
};

export type BrokerHealth = {
  instanceId: string;
  protocolMajor: number;
  protocolMinor: number;
  browserStarted: boolean;
  transport: TransportHealth;
  /** Always present: both false is the production configuration. */
  devMode: TransportDevMode;
  /** Present only when the transport can describe what it launches (metadata only). */
  browser?: TransportBrowserDescription;
};
export type DescriptorState = { descriptorPresent: boolean; staleDescriptor: boolean };
export type AssignmentStatus =
  | "ready"
  | "approval-required"
  | "unresolved"
  | "binding-mismatch"
  | "unverified"
  | "disabled"
  | "policy-blocked"
  | "unsupported-entrypoint";
/** The local half of the doctor report: `checks` is the ordered check map, `topologyReady` says
 * whether the optional browser-backed checks may be attempted at all. */
export type LocalHealthReport = { topologyReady: boolean; checks: Record<string, unknown> };
export type BrowserChannel = GlobalConfig["browser"]["channel"];

/**
 * §29.6/§30.5. The single implementation of every health/prerequisite check, shared by the
 * broker's `broker.health` method and the CLI's `doctor` command. It never submits an agent
 * message and never starts a browser: the authentication and adapter/identity checks are the
 * caller's, performed only when explicitly requested.
 */
export class HealthService {
  private readonly workspaces: WorkspaceService;
  constructor(private readonly deps: HealthDependencies) {
    this.workspaces = deps.workspaces ?? new WorkspaceService();
  }

  /**
   * `broker.health`: liveness, negotiated protocol version, transport state, the development
   * relaxations in effect, and a metadata-only description of the browser the transport launches.
   * `devMode` is always reported (both flags false when the transport does not say otherwise), so
   * a panel never has to treat "absent" and "off" as the same thing.
   */
  async broker(): Promise<BrokerHealth> {
    const { router, instanceId } = this.deps;
    if (!router || !instanceId) throw new DomainError("BROKER_UNAVAILABLE", "The broker is not started.");
    const browser = router.get("browser");
    const transport: TransportHealth = browser
      ? await browser.healthCheck()
      : { healthy: false, details: "No browser transport is registered." };
    return {
      instanceId,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      browserStarted: browser?.isBrowserRunning?.() ?? false,
      transport,
      devMode: transport.devMode ?? { insecureLoopback: false, devAppUrl: false },
      ...(transport.browser ? { browser: transport.browser } : {})
    };
  }

  /** Descriptor (and therefore stale-broker) state, read before any connection attempt so a
   * connection that cleans up a stale descriptor cannot hide that it was there. */
  async descriptorState(): Promise<DescriptorState> {
    const descriptor = await readDescriptor(this.deps.paths);
    return { descriptorPresent: !!descriptor, staleDescriptor: !!descriptor };
  }

  /** Every check that needs neither a running broker nor a browser, in report order. */
  async localReport(root: string): Promise<LocalHealthReport> {
    const fail = this.deps.toFailure ?? ((value: unknown) => asDomainError(value).toResult("unused").error);
    const checks: Record<string, unknown> = {};
    let topologyReady = false;
    try {
      const topology = this.topology();
      topologyReady = topology.supported;
      checks.topology = topology;
    } catch (value) {
      checks.topology = fail(value);
    }
    checks.node = this.node();
    checks.edge = await this.edge();
    checks.browser = await this.browser(await this.resolveConfiguredChannel());
    try {
      await this.appData();
      checks.appData = { protected: true, writable: true };
    } catch (value) {
      checks.appData = fail(value);
    }
    try {
      const config = await this.globalConfig();
      checks.globalConfig = { valid: true };
      await this.profile(config.browser.profilePath);
      checks.profile = { safe: true, owned: true, writable: true };
    } catch (value) {
      checks.globalConfig ??= fail(value);
      checks.profile = { safe: false, error: fail(value) };
    }
    try {
      checks.registry = await this.registry();
    } catch (value) {
      checks.registry = fail(value);
    }
    try {
      checks.approvals = await this.approvals();
    } catch (value) {
      checks.approvals = fail(value);
    }
    try {
      checks.workspace = await this.workspaceReport(root);
    } catch (value) {
      checks.workspace = fail(value);
    }
    return { topologyReady, checks };
  }

  /** Supported OS and local (single-root, non-remote) topology. Throws when unsupported. */
  topology(): { supported: boolean; platform: string; singleRoot: boolean; note?: string } {
    assertSupportedTopology(this.deps.environment ?? process.env);
    const supported = process.platform === "win32" || process.platform === "darwin";
    const note =
      process.platform === "darwin"
        ? "macOS is supported for development and verification; Windows 11 is the production target."
        : supported
          ? undefined
          : "Non-Windows execution is supported only for development/tests.";
    return { supported, platform: process.platform, singleRoot: true, note };
  }

  node(): { version: string; supported: boolean; validatedMajors: number[]; recommendedMajor: number } {
    return {
      version: process.versions.node,
      supported: Number(process.versions.node.split(".")[0]) >= 22,
      validatedMajors: [22, 24],
      recommendedMajor: 24
    };
  }

  /** Compatibility check kept for older callers/tests: `installed` of the msedge channel only,
   * via {@link browser}. Superseded by `browser("msedge")`, which also reports the executable
   * path and the other channels' installation state. */
  async edge(): Promise<{ installed: boolean; remediation?: string }> {
    const detection = await this.browser("msedge");
    return {
      installed: detection.installed,
      ...(!detection.installed && process.platform === "win32"
        ? { remediation: "Install or repair Microsoft Edge; AgentPickLink uses Playwright's msedge channel." }
        : {})
    };
  }

  /** Detects whether the given browser channel (and, for context, every other supported channel)
   * is installed on this machine. Checks well-known install locations on win32/darwin; the
   * `chromium` channel is instead detected via Playwright's own browser cache, since it has no
   * fixed application install path. */
  async browser(channel: BrowserChannel = "msedge"): Promise<{
    channel: BrowserChannel;
    installed: boolean;
    executable?: string;
    alternatives: Array<{ channel: BrowserChannel; installed: boolean }>;
  }> {
    const channels: readonly BrowserChannel[] = ["msedge", "chrome", "chromium"];
    const detections = new Map(
      await Promise.all(channels.map(async (c) => [c, await detectBrowserChannel(c)] as const))
    );
    const primary = detections.get(channel)!;
    return {
      channel,
      installed: primary.installed,
      ...(primary.executable ? { executable: primary.executable } : {}),
      alternatives: channels
        .filter((c) => c !== channel)
        .map((c) => ({ channel: c, installed: detections.get(c)!.installed }))
    };
  }

  /** Best-effort configured channel for the `browser` check in `localReport`, where a missing or
   * invalid global config must not block reporting (the config check below reports that on its
   * own): falls back to the "msedge" default when the config cannot be loaded. */
  private async resolveConfiguredChannel(): Promise<BrowserChannel> {
    try {
      return (await loadGlobalConfig(this.deps.paths)).browser.channel;
    } catch {
      return "msedge";
    }
  }

  /** Application-data root and its private subdirectories: existence, ACL protection, writability. */
  async appData(): Promise<void> {
    await verifyPrivatePath(this.deps.paths.root, true);
    await Promise.all(
      [
        this.deps.paths.broker,
        this.deps.paths.logs,
        this.deps.paths.diagnostics,
        this.deps.paths.attachments
      ].map((directory) => verifyPrivatePath(directory, true))
    );
  }

  /** Global configuration file: protected on disk and schema-valid. */
  async globalConfig(): Promise<GlobalConfig> {
    await verifyPrivatePath(this.deps.paths.config);
    return loadGlobalConfig(this.deps.paths);
  }

  /** Profile path safety, transport ownership, and writability. Ownership is verified through the
   * LocalStatePreparer contract, so this service never depends on a concrete profile manager. */
  async profile(profilePath: string): Promise<void> {
    if (!this.deps.preparer)
      throw new DomainError("INTERNAL_ERROR", "No local-state preparer is registered for the profile check.");
    await assertSafeProfilePath(profilePath);
    await this.deps.preparer.verifyLocalState(profilePath);
    await verifyPrivatePath(profilePath, true);
  }

  async registry(): Promise<{ valid: true; protected: true; count: number }> {
    await verifyPrivatePath(this.deps.paths.registry);
    return { valid: true, protected: true, count: (await loadRegistry(this.deps.paths)).agents.length };
  }

  async approvals(): Promise<{ valid: true; protected: true }> {
    await verifyPrivatePath(this.deps.paths.approvals);
    await loadApprovals(this.deps.paths);
    return { valid: true, protected: true };
  }

  /** Workspace config validity, per-assignment binding resolution, and local approval state.
   * Shared with `m365-agent workspace validate`; it reports the detailed local status that the
   * MCP roster deliberately collapses. */
  async workspaceReport(root: string): Promise<Record<string, unknown>> {
    const workspace = await this.workspaces.load(root);
    const [registry, approvalStore, config] = await Promise.all([
      loadRegistry(this.deps.paths),
      loadApprovals(this.deps.paths),
      loadGlobalConfig(this.deps.paths)
    ]);
    const approval = new ApprovalService(approvalStore, config.security.allowedCapabilityClasses);
    const assignments = workspace.config.agents.map((requested) => {
      const candidate = registry.agents.find((agent) => agent.alias === requested.alias);
      let status: AssignmentStatus = "unresolved";
      if (candidate) {
        if (!candidate.enabled) status = "disabled";
        else if (candidate.verification.status !== "verified") status = "unverified";
        else if (deriveBindingFingerprint(candidate) !== candidate.verification.bindingFingerprint)
          status = "binding-mismatch";
        else if (!SUPPORTED_BROWSER_ADAPTER_IDS.has(candidate.verification.adapterId))
          status = "unsupported-entrypoint";
        else if (
          !config.security.allowedCapabilityClasses.some(
            (capability) => capability === candidate.capabilityClass
          )
        )
          status = "policy-blocked";
        else if (
          requested.bindingFingerprint &&
          requested.bindingFingerprint !== candidate.verification.bindingFingerprint
        )
          status = "binding-mismatch";
        else {
          try {
            approval.assertApproved(workspace, candidate);
            status = "ready";
          } catch (value) {
            status =
              value instanceof DomainError && value.code === "AGENT_BINDING_MISMATCH"
                ? "binding-mismatch"
                : "approval-required";
          }
        }
      }
      return {
        alias: requested.alias,
        status,
        ...(candidate
          ? {
              name: candidate.displayName,
              kind: candidate.kind,
              capabilityClass: candidate.capabilityClass,
              verificationStatus: candidate.verification.status,
              bindingFingerprint: candidate.verification.bindingFingerprint
            }
          : {}),
        locallyBound: !requested.bindingFingerprint
      };
    });
    return {
      workspaceKey: workspace.workspaceKey,
      approvalStatus: approval.status(
        workspace,
        new Map(registry.agents.map((agent) => [agent.alias, agent]))
      ),
      assignments
    };
  }
}

/** Detects one browser channel's installation state on this machine (see HealthService.browser). */
async function detectBrowserChannel(
  channel: BrowserChannel
): Promise<{ installed: boolean; executable?: string }> {
  if (channel === "chromium") return { installed: await chromiumCacheHasBrowser() };
  for (const candidate of executableCandidates(channel)) {
    try {
      await access(candidate);
      return { installed: true, executable: candidate };
    } catch {
      /* continue */
    }
  }
  return { installed: false };
}

/** Well-known Edge/Chrome install locations on the two supported desktop platforms. */
function executableCandidates(channel: "msedge" | "chrome"): string[] {
  if (process.platform === "win32") {
    const bases = [
      process.env["PROGRAMFILES(X86)"],
      process.env.PROGRAMFILES,
      process.env.LOCALAPPDATA
    ].filter((value): value is string => !!value);
    const segments =
      channel === "msedge"
        ? ["Microsoft", "Edge", "Application", "msedge.exe"]
        : ["Google", "Chrome", "Application", "chrome.exe"];
    return bases.map((base) => path.join(base, ...segments));
  }
  if (process.platform === "darwin") {
    return [
      channel === "msedge"
        ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ];
  }
  return [];
}

/** The `chromium` channel has no fixed application path; it is Playwright's own downloaded
 * browser, so installation is inferred from Playwright's browser cache directory instead. */
async function chromiumCacheHasBrowser(): Promise<boolean> {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    const entries = await readdir(base);
    return entries.some((entry) => /^chromium/i.test(entry));
  } catch {
    return false;
  }
}
