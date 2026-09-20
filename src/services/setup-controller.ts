/**
 * The host-agnostic setup state machine: everything the `agentpicklink.setup` panel does, minus
 * the VS Code API calls. Extracted from `src/extension/setup-view.ts` (WP-A, section 4.1 of
 * docs/extension-less-onboarding.md) so the webview host and the terminal setup wizard the CLI
 * gains in WP-B drive exactly the same code.
 *
 * The host owns dialogs, notifications, the clipboard, the log sink, workspace trust, the
 * integration flags, the MCP client refresh and the health poller (`SetupHost` below). Everything
 * else -- phases, discovery, interactive sign-in, the whole Save tail, auto-connect, cancellation,
 * status classification and localisation -- lives here.
 *
 * Security notes (unchanged from the panel):
 * - The host only ever receives data (`PanelState`); URLs and descriptions are resolved here.
 * - Save always goes through `host.confirm()` naming every agent, and then through
 *   `SetupService.apply()`, which is what writes the registry, `.m365-agents.json` and the local
 *   approval. Nothing here adds a shortcut around that.
 * - Nothing logged or copied from here contains prompt or response text.
 */
import type { AppPaths } from "../config/paths.js";
import { splitDiscoveryWarnings } from "../domain/discovery-warnings.js";
import { DomainError } from "../domain/errors.js";
import type { ProgressEvent } from "../domain/progress.js";
import type { Incident } from "../observability/incidents.js";
import { restartBrokerIfStale } from "./broker-staleness.js";
import { applyIntegrations, type IntegrationDefinition, type IntegrationVariables } from "./integrations.js";
import { describeErrorCode, translator } from "./localize.js";
import { buildApplyPlan, mergeDownloadHostSuggestions, previewAlias } from "./setup-plan.js";
import type {
  HostMessage,
  IntegrationFlags,
  Locale,
  PanelError,
  PanelState,
  SavePlanInput,
  UpdateConfigPatchInput
} from "./setup-protocol.js";
import {
  isSignInCancelledError,
  type AgentCandidate,
  type ApplyResult,
  type SetupService,
  type SetupStatus
} from "./setup-service.js";
import {
  classifyStatus,
  isDevMode,
  isWorkspaceSetUp,
  shouldNotifySignIn,
  type SignInNotifyInputs,
  type StatusKind
} from "./setup-status.js";

/**
 * The slice of `SetupService` the controller calls. Declared structurally so a test can hand
 * `SetupController` a fake without constructing the real service (which would need file stores
 * and a live broker). Re-exported by `src/extension/deps.ts`, the extension's module seam.
 */
export type SetupServiceLike = Pick<
  SetupService,
  | "status"
  | "ensureSignedIn"
  | "ensureBrowserChannel"
  | "cancelSignIn"
  | "cancelDiscovery"
  | "discover"
  | "apply"
  | "removeAgent"
  | "revokeWorkspace"
  | "signOut"
  | "restartBroker"
  | "updateConfig"
>;

/** What the broker reports through `broker.health`; polled by the host, never by the controller. */
export type BrokerHealthSnapshot = {
  instanceId: string;
  protocolMajor: number;
  protocolMinor: number;
  browserStarted: boolean;
  transport: { healthy: boolean; details?: string };
  authState?: { state: string; checkedAt: string };
  incidents: Incident[];
  /** G6: set when the broker is running against a development-only configuration (an insecure
   * loopback navigation allowance, or a dev app URL override) -- see `isDevMode()`
   * (src/services/setup-status.ts). Absent on a production broker/older protocol. */
  devMode?: { insecureLoopback: boolean; devAppUrl: boolean };
  /** G5: the browser the broker actually launched with, which may differ from `GlobalConfig`'s
   * configured `channel`/`headless` until the next restart. Absent before the browser has started. */
  browser?: {
    channel: string;
    headless: boolean;
    viewport?: { width: number; height: number };
    executable?: string;
  };
};

/** Structural `vscode.Disposable`, so this module stays free of the `vscode` module. */
export type Disposable = { dispose: () => void };

/** A modal, consequence-naming question. `false` means "the user did not press `confirmLabel`". */
export type ConfirmRequest = {
  title: string;
  detail?: string;
  confirmLabel: string;
  severity: "info" | "warning";
  /**
   * Distinguishes *what* this confirmation actually consents to, so a host whose bypass policy
   * differs per kind (the CLI's `--yes` / `--approve-agents` / `--allow-actions-possible` flags,
   * docs/extension-less-onboarding.md §3.1's "Consent rule") can tell them apart without parsing
   * `title`/`detail` text. `"plan"` is an operational confirmation with no security consequence of
   * its own (e.g. "open the sign-in browser now?"); `"agents"` is the agent-roster approval;
   * `"widening"` is the same roster confirmation when it also widens the machine-wide
   * `actions-possible` capability allowance. The webview host ignores this field -- every
   * confirmation is still one native modal there, exactly as before.
   */
  kind?: "plan" | "agents" | "widening";
};

/** What `host.saved()` turns into the final message: one of the panel's three notifications, or
 * the terminal wizard's closing instructions. */
export type SaveSummary = {
  /** The post-save silent `ensureSignedIn()` came back authenticated. */
  connected: boolean;
  /** Absolute paths of the MCP client files `applyIntegrations()` wrote. */
  written: readonly string[];
  /** Enabled integrations that were not written, with the reason. */
  skipped: readonly string[];
  /** Agents `SetupService.apply()` registered, and how many of those failed. */
  registered: number;
  failed: number;
};

/**
 * Everything the state machine needs from its host (docs/extension-less-onboarding.md section 4.1).
 * The VS Code implementation is `SetupViewProvider`; the CLI adds a terminal one in WP-B, where
 * `post()` renders `PanelState` transitions as lines and `confirm()` is a readline prompt.
 */
export interface SetupHost {
  readonly locale: Locale;
  readonly version: string;
  /** The shared application paths; `restartBrokerIfStale()` needs them alongside `brokerEntry()`. */
  readonly paths: AppPaths;
  post(message: HostMessage): void; // webview, browser page, or terminal renderer
  log(line: string): void; // metadata only, same invariant as today
  confirm(request: ConfirmRequest): Promise<boolean>;
  notify(level: "info" | "warning", text: string): void;
  /** G2: the proactive "sign in" notification, whose button leads back into the host's own sign-in
   * entry point (the `agentpicklink.signIn` command in VS Code). Fire and forget. */
  promptSignIn(request: { text: string; actionLabel: string }): void;
  clipboard(text: string): Promise<void>;
  openLogs(): Promise<void>;
  /** Host-owned fields of the diagnostics blob (`vscodeVersion`, `platform`, the resolved Node). */
  hostDiagnostics(): Promise<Record<string, unknown>>;
  workspaceRoot(): string | undefined;
  trusted(): boolean; // VS Code workspace trust; always true in the CLI
  homeDirectory(): string;
  integrationFlags(): IntegrationFlags; // VS Code settings vs. config.yaml `clients:` block
  saveIntegrationFlags(flags: IntegrationFlags): Promise<void>;
  integrationDefinition(): Promise<IntegrationDefinition>; // section 3.2 / 4.2
  /** §4.7 C9: the host-based prefixes (`%LOCALAPPDATA%`/home directory) a workspace-file writer
   * substitutes for a host-supported variable in `command`/`args`, so a committed
   * `.vscode/mcp.json`/`.mcp.json` works for a teammate on the same OS. `undefined` when the host
   * has nothing to offer (never derived from `M365_AGENT_INSTALL_ROOT` -- see
   * `integrationVariablesFor` in `install-home.ts`). */
  integrationVariables(): IntegrationVariables | undefined;
  brokerEntry(): string;
  refreshClients(): void; // mcp.refresh(); no-op in the CLI
  onHealth(listener: (health: BrokerHealthSnapshot | undefined) => void): Disposable;
  /** The status bar's feed: fired on every poll, including the ones that change no `PanelState`. */
  statusChanged(status: { kind: StatusKind; devMode: boolean }): void;
  saved(summary: SaveSummary): Promise<void>; // "saved" message / final instructions
}

/**
 * Maps any thrown value to what the panel renders.
 *
 * The English `message`/`remediation` the domain layer produced are kept verbatim -- they are what
 * the user copies into a bug report and what the developer greps for. `summary` (and, for the
 * handful of codes that have one, `localizedRemediation`) is the locale-appropriate one-liner
 * media/setup.js shows as the headline above them; see `describeErrorCode` in ./localize.ts.
 */
export function toPanelError(error: unknown, locale: Locale): PanelError {
  const base: PanelError =
    error instanceof DomainError
      ? (() => {
          const { error: application } = error.toResult("panel");
          return {
            code: application.code,
            message: application.message,
            ...(application.remediation ? { remediation: application.remediation } : {})
          };
        })()
      : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
  const described = describeErrorCode(locale, base.code);
  if (!described) return base;
  return {
    ...base,
    summary: described.summary,
    ...(described.remediation ? { localizedRemediation: described.remediation } : {})
  };
}

/** Registry candidates first, then anything discovery found that the registry does not know. */
function mergeCandidates(
  registry: readonly AgentCandidate[],
  discovered: readonly AgentCandidate[],
  retainMissingDescriptions = false
): AgentCandidate[] {
  const merged = new Map<string, AgentCandidate>();
  for (const candidate of registry) merged.set(candidate.key, candidate);
  for (const candidate of discovered) {
    const known = merged.get(candidate.key);
    merged.set(
      candidate.key,
      known
        ? {
            ...known,
            ...candidate,
            registered: known.registered ?? candidate.registered,
            assigned: known.assigned,
            assignmentStatus: known.assignmentStatus,
            description:
              candidate.description?.trim() ||
              (retainMissingDescriptions ? known.description : candidate.description)
          }
        : candidate
    );
  }
  return [...merged.values()];
}

/** This workspace's saved roster: the registered agents its `.m365-agents.json` assigns to it. */
function savedAgents(status: SetupStatus): AgentCandidate[] {
  return status.registry.filter((candidate) => candidate.assigned);
}

export class SetupController {
  private service?: SetupServiceLike;
  private busy = false;
  private operationStartedAt = 0;
  private lastErrorCode?: string;
  private health?: BrokerHealthSnapshot;
  /** G2: the sign-in-relevant slice of the previous poll's health, compared against the new one on
   * every `acceptHealth()` call by `shouldNotifySignIn()` -- see that function's doc comment for why
   * this is enough to notify "at most once per transition". */
  private lastSignInSnapshot: SignInNotifyInputs | undefined;
  private state: PanelState;
  private readonly healthSubscription: Disposable;

  /** `createService` is the test seam (src/extension/deps.ts); production passes the default. */
  constructor(
    private readonly host: SetupHost,
    private readonly createService: () => SetupServiceLike
  ) {
    this.state = {
      phase: "idle",
      candidates: [],
      selectedKeys: [],
      warnings: [],
      diagnostics: [],
      incidents: [],
      integrations: host.integrationFlags(),
      locale: host.locale,
      version: host.version
    };
    this.healthSubscription = host.onHealth((health) => this.acceptHealth(health));
  }

  private setup(): SetupServiceLike {
    this.service ??= this.createService();
    return this.service;
  }

  /* -------------------------------------------------------------- rendering */

  /** Re-sends the current state, unchanged: the host's first render and its "ready" handshake. */
  postState(): void {
    this.host.post({ type: "state", state: this.state });
  }

  private patch(partial: Partial<PanelState>): void {
    this.state = { ...this.state, ...partial };
    this.postState();
    this.fireStatusChanged();
  }

  private fireStatusChanged(): void {
    this.host.statusChanged({ kind: this.statusKind(), devMode: isDevMode(this.health) });
  }

  private progressSink(): (event: ProgressEvent) => void {
    return (event) => {
      this.host.log(
        `progress: ${event.phase}${event.message ? ` - ${event.message}` : ""}${
          event.elapsedMs !== undefined ? ` (${Math.round(event.elapsedMs / 1000)}s)` : ""
        }`
      );
      this.patch({
        progress: {
          phase: event.phase,
          ...(event.message ? { message: event.message } : {}),
          elapsedMs: Math.max(0, Date.now() - this.operationStartedAt),
          ...(event.current !== undefined ? { current: event.current } : {}),
          ...(event.total !== undefined ? { total: event.total } : {})
        }
      });
    };
  }

  /* -------------------------------------------------------------- status */

  statusKind(): StatusKind {
    return classifyStatus({
      errorCode: this.state.error?.code,
      incidentCodes: this.state.incidents.map((incident) => incident.code),
      brokerLive: this.state.status?.broker.live ?? !!this.health,
      authState: this.state.status?.broker.authState?.state ?? this.health?.authState?.state
    });
  }

  /** Called by the host's poller; never starts the broker or a browser. The panel is only
   * re-rendered when something the header/status actually shows changed, so a poll never disturbs
   * in-progress editing. G2: also fires the proactive "sign in" notification at most once per
   * transition (see `shouldNotifySignIn`), independent of whether anything else about this poll
   * changed the panel. */
  acceptHealth(health: BrokerHealthSnapshot | undefined): void {
    const currentSnapshot: SignInNotifyInputs = {
      authState: health?.authState?.state,
      incidents: health?.incidents ?? []
    };
    if (!this.busy && shouldNotifySignIn(this.lastSignInSnapshot, currentSnapshot)) this.notifySignIn();
    this.lastSignInSnapshot = currentSnapshot;

    this.health = health;
    const incidents: Incident[] = health?.incidents ?? this.state.incidents;
    const partial: Partial<PanelState> = {};
    if (this.state.status) {
      const broker = { live: !!health, authState: health?.authState, incidents };
      if (JSON.stringify(broker) !== JSON.stringify(this.state.status.broker))
        partial.status = { ...this.state.status, broker };
    }
    if (JSON.stringify(incidents) !== JSON.stringify(this.state.incidents)) partial.incidents = incidents;
    if (JSON.stringify(health?.browser) !== JSON.stringify(this.state.liveBrowser))
      partial.liveBrowser = health?.browser;
    if (JSON.stringify(health?.devMode) !== JSON.stringify(this.state.devMode))
      partial.devMode = health?.devMode;
    if (Object.keys(partial).length > 0) this.patch(partial);
    else this.fireStatusChanged();
  }

  /** G2: shown at most once per sign-in-required/access-denied transition (or new AUTH_REQUIRED/
   * AUTH_FAILED incident); its button leads back to the host's own sign-in entry point, the same
   * one the status bar and the panel button use. */
  private notifySignIn(): void {
    const t = translator(this.host.locale);
    this.host.promptSignIn({ text: t("signInRequiredNotification"), actionLabel: t("signIn") });
  }

  /* -------------------------------------------------------------- actions */

  /** P1-17: gates every action that signs in, discovers, or saves on the workspace being trusted.
   * Status display, `restartBroker`, `openLogs`, and `copyDiagnostics` stay available regardless --
   * they read local diagnostics or manage the broker process, never write workspace files or reach
   * out to Microsoft 365 on the repository's behalf. Returns `false` (after showing the existing
   * `workspaceUntrusted` warning) when the caller should stop. */
  private requireTrustedWorkspace(): boolean {
    if (this.host.trusted()) return true;
    this.host.notify("warning", translator(this.host.locale)("workspaceUntrusted"));
    return false;
  }

  /** Serializes the long-running actions: the broker allows one browser operation at a time. */
  private async exclusive(label: string, action: () => Promise<void>): Promise<void> {
    if (this.busy) {
      this.host.log(`${label}: ignored, another operation is still running`);
      return;
    }
    this.busy = true;
    this.operationStartedAt = Date.now();
    this.host.log(`${label}: started`);
    // A one-shot notice (e.g. G1's "sign-in cancelled") is only meant to survive until the next
    // action the user takes -- clear it here rather than at every individual call site.
    if (this.state.notice !== undefined) this.patch({ notice: undefined });
    try {
      await action();
      this.host.log(`${label}: finished`);
    } catch (error) {
      // G1: `cancelSignIn()` runs concurrently with the `exclusive()`-wrapped action that is
      // waiting on `ensureSignedIn()`, so its cancellation surfaces here as this action's own
      // failure -- render it as a neutral notice, never the red error box.
      if (isSignInCancelledError(error)) {
        this.host.log(`${label}: sign-in cancelled`);
        this.patch({ phase: "idle", notice: "sign-in-cancelled", error: undefined, progress: undefined });
        await this.refreshStatusQuiet();
        return;
      }
      const panelError = toPanelError(error, this.host.locale);
      this.lastErrorCode = panelError.code;
      this.host.log(`${label}: failed (${panelError.code}) ${panelError.message}`);
      // item 1: a browser launch failure can carry a redacted, size-bounded Playwright call log
      // (domain/errors.ts's `ApplicationError.callLog`, forwarded across IPC by
      // src/ipc/client.ts's `receive()`) -- append it under the failure line so it lands in
      // cli.log/the output channel next to the failure it explains. Never surfaced anywhere the
      // MCP tool result is built (src/frontend/tool-results.ts's `failure()` strips it again).
      if (error instanceof DomainError && error.options.callLog?.length)
        for (const line of error.options.callLog) this.host.log(`browser-log: ${line}`);
      this.patch({ phase: "error", error: panelError, progress: undefined });
      if (panelError.code === "AUTH_REQUIRED") await this.refreshStatusQuiet();
    } finally {
      this.busy = false;
    }
  }

  /** Best-effort `status()` refresh that never throws or shows an error of its own -- used after a
   * cancelled sign-in, where the panel should reflect whatever the broker's auth state actually is
   * now without turning a refresh failure into a second, confusing error. */
  private async refreshStatusQuiet(): Promise<void> {
    try {
      const status = await this.setup().status();
      this.patch({ status, incidents: status.broker.incidents });
    } catch (error) {
      this.host.log(
        `status refresh after cancel: failed (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  async runSetup(): Promise<void> {
    if (!this.requireTrustedWorkspace()) return;
    await this.exclusive("setup", async () => {
      this.patch({
        phase: "checking",
        error: undefined,
        progress: { phase: "connecting" },
        warnings: [],
        diagnostics: []
      });
      // Never let a broker from a previous extension build serve the setup flow.
      await restartBrokerIfStale({
        paths: this.host.paths,
        brokerEntry: this.host.brokerEntry(),
        log: (line) => this.host.log(line)
      }).catch(() => false);
      let status = await this.setup().status();
      this.patch({ status, incidents: status.broker.incidents });
      // A missing browser is the most common first-run failure on macOS (no Edge): switch to an
      // installed channel up front instead of letting the launch fail later with a raw error.
      const channel = await this.setup().ensureBrowserChannel();
      if (channel.changed) {
        const t = translator(this.host.locale);
        this.host.log(`browser: switched channel ${channel.previous} -> ${channel.channel}`);
        this.host.notify(
          "info",
          t("browserChannelSwitched")
            .replace("{from}", channel.previous ?? "")
            .replace("{to}", channel.channel)
        );
        if (channel.restartRequired) {
          this.patch({
            progress: { phase: "restarting-broker", message: t("restartingBroker"), elapsedMs: 0 }
          });
          await this.setup().restartBroker();
        }
        status = await this.setup().status();
        this.patch({ status, incidents: status.broker.incidents });
      }
      if (status.broker.authState?.state !== "authenticated") {
        const result = await this.interactiveSignIn();
        this.host.log(`sign-in: state=${result.state}`);
      }
      await this.discoverWithRecovery("selecting");
    });
  }

  /** Reuse a discovery made in this install invocation, but reload this workspace's own approval. */
  async reuseDiscovery(snapshot: PanelState): Promise<void> {
    if (!this.requireTrustedWorkspace()) return;
    await this.exclusive("reuse-discovery", async () => {
      const status = await this.setup().status();
      const registered = new Map(status.registry.map((candidate) => [candidate.key, candidate]));
      const candidates = snapshot.candidates.map((candidate) => {
        const current = registered.get(candidate.key);
        return {
          ...candidate,
          ...(current?.registered ? { registered: current.registered } : {}),
          assigned: current?.assigned ?? false
        };
      });
      this.patch({
        phase: "selecting",
        status,
        candidates,
        selectedKeys: candidates.filter((candidate) => candidate.assigned).map((candidate) => candidate.key),
        warnings: [...snapshot.warnings],
        diagnostics: [...snapshot.diagnostics],
        discoverySummary: snapshot.discoverySummary,
        suggestedDownloadHosts: snapshot.suggestedDownloadHosts
      });
    });
  }

  async runDiscover(): Promise<void> {
    if (!this.requireTrustedWorkspace()) return;
    await this.exclusive("refresh-list", async () => {
      await this.setup().ensureSignedIn({ interactive: false, onProgress: this.progressSink() });
      await this.discoverWithRecovery("selecting");
    });
  }

  /** Repair a crashed connection once; expired authentication always needs an explicit Sign in. */
  private async discoverWithRecovery(next: PanelState["phase"]): Promise<void> {
    try {
      await this.discoverInto(next);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      if (error.code === "AUTH_REQUIRED") {
        throw error;
      } else if (["BROWSER_CRASHED", "BROKER_UNAVAILABLE", "BROKER_VERSION_MISMATCH"].includes(error.code)) {
        this.patch({ phase: "checking", progress: { phase: "restarting-broker" } });
        await this.setup().restartBroker();
        this.host.refreshClients();
        await this.setup().ensureSignedIn({ interactive: false });
      } else {
        throw error;
      }
      await this.discoverInto(next);
    }
  }

  private async discoverInto(next: PanelState["phase"]): Promise<void> {
    this.patch({ phase: "discovering" });
    const {
      candidates,
      warnings,
      suggestedDownloadHosts,
      partial: servicePartial,
      failedCount,
      failedCountKnown
    } = await this.setup().discover(this.progressSink());
    const status = await this.setup().status();
    // SetupService has already matched the full list to the registry by stable ID or URL.
    // Merging again by key could duplicate an entry whose discovery key changed.
    const merged = warnings.includes("discovery-cancelled")
      ? mergeCandidates(this.state.candidates, candidates, true)
      : candidates;
    // The warnings are metadata-only by contract (strategy counts, the landing structure summary),
    // so logging them verbatim is what makes an empty result diagnosable from the log alone.
    this.host.log(
      `discover: ${merged.length} candidates, descriptions=${merged.filter((candidate) => candidate.description?.trim()).length}/${merged.length}, ${warnings.length} warnings${warnings.length ? `: ${warnings.join(" | ")}` : ""}`
    );
    // The panel tells failure tags apart from the run's own summaries: a successful run always
    // produces the latter, and they must not read as something having gone wrong.
    const sorted = splitDiscoveryWarnings(warnings);
    // G4: only the hosts not already configured are worth showing as a pre-fill suggestion -- the
    // field default is `configured + suggested` (see media/setup.js), so anything already present
    // would add nothing to show. mergeDownloadHostSuggestions always returns the configured hosts
    // unchanged as its prefix (see its doc comment), so everything after that prefix is exactly
    // the new, not-yet-configured suggestions.
    const newSuggestions = suggestedDownloadHosts
      ? mergeDownloadHostSuggestions(status.config.downloadHosts, suggestedDownloadHosts).slice(
          status.config.downloadHosts.length
        )
      : [];
    this.patch({
      phase: next,
      notice: warnings.includes("discovery-cancelled") ? "discovery-cancelled" : undefined,
      discoverySummary: {
        total: merged.length,
        descriptions: merged.filter((agent) => !!agent.description?.trim()).length,
        // SetupService derives `partial`/`failedCount` from this run's own discovery-warnings
        // completeness check (domain/discovery-warnings.ts's summarizeDiscoveryCompleteness); fall
        // back to the older warning-text heuristic only when the service did not report a verdict.
        partial:
          servicePartial ??
          (!warnings.includes("discovery-cancelled") &&
            warnings.some((line) => /failed:|partial|unavailable/.test(line))),
        ...(failedCount !== undefined
          ? { failedCount, ...(failedCountKnown !== undefined ? { failedCountKnown } : {}) }
          : {})
      },
      status,
      candidates: merged,
      selectedKeys: merged.filter((candidate) => candidate.assigned).map((candidate) => candidate.key),
      warnings: [],
      diagnostics: [...sorted.warnings, ...sorted.diagnostics],
      progress: undefined,
      suggestedDownloadHosts: newSuggestions.length > 0 ? newSuggestions : undefined
    });
  }

  /** Restore saved agents and check authentication silently. Opening a folder never launches
   * interactive authentication or a catalogue scan. Explicit Refresh discovers new agents. */
  async autoConnect(): Promise<void> {
    if (!this.host.trusted()) {
      this.host.log("auto-connect: skipped (workspace not trusted)");
      return;
    }
    await this.exclusive("auto-connect", async () => {
      // Surface the broker/browser startup immediately. On Windows the first connection can spend
      // tens of seconds applying pipe ACLs before the status call returns; leaving the panel idle
      // during that work makes the setup button appear broken and invites a duplicate click.
      this.patch({
        phase: "checking",
        error: undefined,
        progress: { phase: "connecting" }
      });
      let status = await this.setup().status();
      if (!isWorkspaceSetUp(status.workspace)) {
        const state = status.workspace.configured ? status.workspace.approvalStatus : "not configured";
        this.host.log(`auto-connect: nothing to resume (workspace ${state})`);
        this.patch({ phase: "idle", status, incidents: status.broker.incidents, progress: undefined });
        return;
      }
      this.patch({
        phase: "checking",
        status,
        incidents: status.broker.incidents,
        error: undefined,
        progress: { phase: "connecting" }
      });
      this.patch({
        candidates: status.registry,
        selectedKeys: savedAgents(status).map((candidate) => candidate.key)
      });
      const channel = await this.setup().ensureBrowserChannel();
      if (channel.restartRequired) await this.setup().restartBroker();
      let signedIn = !channel.restartRequired && status.broker.authState?.state === "authenticated";
      if (!signedIn) {
        try {
          const result = await this.setup().ensureSignedIn({ interactive: false });
          signedIn = result.state === "authenticated";
        } catch (error) {
          // The one expected outcome of a silent check; anything else is a real failure.
          if (!(error instanceof DomainError && error.code === "AUTH_REQUIRED")) throw error;
          signedIn = false;
        }
        status = await this.setup().status();
      }
      const saved = savedAgents(status).length;
      this.host.log(
        `auto-connect: ${signedIn ? "signed in" : "sign-in required"}; ${saved} saved agent(s) in this workspace`
      );
      this.patch({ status, incidents: status.broker.incidents });
      this.showSavedAgents(status, signedIn);
      if (!signedIn) this.notifySignIn();
    });
  }

  /** The saved roster as the panel's selection: every registered agent listed (as `discoverInto`
   * does), this workspace's assigned ones checked. "connected" only while actually signed in;
   * otherwise the panel rests at idle with the roster visible and the sign-in state in its header. */
  private showSavedAgents(status: SetupStatus, signedIn: boolean): void {
    this.patch({
      phase: signedIn ? "connected" : "idle",
      status,
      candidates: status.registry,
      selectedKeys: savedAgents(status).map((candidate) => candidate.key),
      incidents: status.broker.incidents,
      warnings: [],
      diagnostics: [],
      progress: undefined,
      error: undefined
    });
  }

  /** Explain the browser handoff before it takes focus, only when a visible login is needed. */
  private interactiveSignIn(automatic = false): Promise<{ state: string }> {
    const t = translator(this.host.locale);
    return this.setup().ensureSignedIn({
      interactive: true,
      beforeInteractiveLogin: async () => {
        if (automatic) {
          this.patch({ phase: "signing-in", progress: undefined });
          this.host.notify("info", t("browserSignInInstructions"));
          return true;
        }
        const confirmed = await this.host.confirm({
          title: t("browserSignInTitle"),
          detail: t("browserSignInInstructions"),
          confirmLabel: t("openSignInBrowser"),
          severity: "info",
          kind: "plan"
        });
        if (!confirmed) return false;
        this.patch({ phase: "signing-in", progress: undefined });
        return true;
      },
      onProgress: this.progressSink()
    });
  }

  async signIn(): Promise<void> {
    if (!this.requireTrustedWorkspace()) return;
    await this.exclusive("sign-in", async () => {
      this.patch({ phase: "checking", error: undefined, progress: undefined });
      const result = await this.interactiveSignIn();
      this.host.log(`sign-in: state=${result.state}`);
      const status = await this.setup().status();
      this.patch({ status, incidents: status.broker.incidents });
      if (result.state === "authenticated") {
        if (isWorkspaceSetUp(status.workspace)) this.showSavedAgents(status, true);
        else await this.discoverWithRecovery("selecting");
      } else {
        this.patch({ phase: "idle", progress: undefined });
      }
    });
  }

  async signOut(): Promise<void> {
    await this.exclusive("sign-out", async () => {
      await this.setup().signOut();
      this.health = undefined;
      this.patch({
        phase: "idle",
        status: undefined,
        candidates: [],
        selectedKeys: [],
        incidents: [],
        warnings: [],
        diagnostics: [],
        suggestedDownloadHosts: undefined,
        progress: undefined,
        error: undefined
      });
      this.host.notify("info", translator(this.host.locale)("signedOut"));
    });
  }

  /** G1: deliberately not wrapped in `exclusive()` -- it must run *while* `signIn()`/`runSetup()`
   * is still busy awaiting `ensureSignedIn()`. Sets no panel state of its own: the sign-in action
   * this interrupts observes the resulting cancellation and does that (see `exclusive()`'s catch
   * clause and `isSignInCancelledError`). */
  async cancelSignIn(): Promise<void> {
    this.host.log("cancel-sign-in: requested");
    try {
      const result = await this.setup().cancelSignIn();
      this.host.log(`cancel-sign-in: cancelled=${result.cancelled}`);
    } catch (error) {
      this.host.log(`cancel-sign-in: failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** Asks the broker to stop the discovery pass in flight; the pass itself returns whatever it
   * already found, tagged `discovery-cancelled` (see `discoverInto`). */
  async cancelDiscovery(): Promise<void> {
    await this.setup().cancelDiscovery();
  }

  /** G3: distinct from "removeCandidate" (which only hides an entry from this panel session and
   * never touches the registry) -- this deletes the agent's registration everywhere. Confirmed with
   * a modal naming the agent before anything is deleted. */
  async unregisterAgent(key: string): Promise<void> {
    if (!this.requireTrustedWorkspace()) return;
    const alias = this.state.candidates.find((candidate) => candidate.key === key)?.registered?.alias;
    if (!alias) return;
    const t = translator(this.host.locale);
    const confirmed = await this.host.confirm({
      title: t("unregisterConfirmTitle"),
      detail: `${alias}\n\n${t("unregisterConfirmBody")}`,
      confirmLabel: t("unregisterConfirm"),
      severity: "warning"
    });
    if (!confirmed) {
      this.host.log("unregister-agent: cancelled at the confirmation dialog");
      return;
    }
    await this.exclusive("unregister-agent", async () => {
      const status = await this.setup().removeAgent(alias);
      this.patch({
        status,
        candidates: mergeCandidates(
          status.registry,
          this.state.candidates.filter((candidate) => candidate.key !== key)
        ),
        selectedKeys: this.state.selectedKeys.filter((selected) => selected !== key),
        incidents: status.broker.incidents
      });
      this.host.notify("info", t("agentUnregistered"));
    });
  }

  /** G3: revokes only this workspace's local approval; `.m365-agents.json` and the registry are
   * left untouched (see `SetupService.revokeWorkspace`'s doc comment). Confirmed with a modal. */
  async revokeWorkspace(): Promise<void> {
    if (!this.requireTrustedWorkspace()) return;
    const t = translator(this.host.locale);
    const confirmed = await this.host.confirm({
      title: t("revokeConfirmTitle"),
      detail: t("revokeConfirmBody"),
      confirmLabel: t("revokeConfirm"),
      severity: "warning"
    });
    if (!confirmed) {
      this.host.log("revoke-workspace: cancelled at the confirmation dialog");
      return;
    }
    await this.exclusive("revoke-workspace", async () => {
      const status = await this.setup().revokeWorkspace();
      this.patch({ status, incidents: status.broker.incidents });
      this.host.notify("info", t("workspaceRevoked"));
    });
  }

  /** G5: the "Advanced" section's headless/channel toggle and the (optional) attachment retention/
   * quota fields. Offers to restart the broker immediately when the change needs it, reusing the
   * existing `restartBroker()` flow. */
  async updateConfig(patch: UpdateConfigPatchInput): Promise<void> {
    if (!this.requireTrustedWorkspace()) return;
    await this.exclusive("update-config", async () => {
      const result = await this.setup().updateConfig(patch);
      if (result.restartRequired) {
        this.host.log(`update-config: broker-scoped config changed (${result.changedKeys.join(", ")})`);
        const t = translator(this.host.locale);
        this.patch({
          phase: "checking",
          progress: { phase: "restarting-broker", message: t("restartingBroker") }
        });
        await this.setup().restartBroker();
        this.host.refreshClients();
        try {
          await this.setup().ensureSignedIn({ interactive: false });
          this.patch({ phase: "idle", progress: undefined, notice: undefined });
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== "AUTH_REQUIRED") throw error;
          this.patch({ phase: "idle", progress: undefined, notice: "saved-needs-sign-in" });
        }
      }
      const status = await this.setup().status();
      this.patch({ status, incidents: status.broker.incidents });
    });
  }

  async restartBroker(): Promise<void> {
    return this.runSetup();
  }

  async refreshStatus(): Promise<void> {
    await this.exclusive("status", async () => {
      this.patch({ phase: "checking", error: undefined });
      const status = await this.setup().status();
      this.patch({ phase: "idle", status, incidents: status.broker.incidents });
    });
  }

  async save(input: SavePlanInput): Promise<void> {
    const t = translator(this.host.locale);
    if (!this.requireTrustedWorkspace()) return;
    const { plan, unknownKeys } = buildApplyPlan(input, this.state.candidates);
    if (unknownKeys.length > 0) this.host.log(`save: ignored ${unknownKeys.length} unknown key(s)`);
    if (plan.agents.length === 0) {
      this.host.notify("warning", t("noAgentsSelected"));
      return;
    }
    // P1-18: `allowedCapabilityClasses` is machine-wide config, not per-workspace, so approving the
    // first actions-possible agent here also lets every other local workspace approve agents of
    // that capability class (each still needs its own separate approval). Warn about that widening
    // only when it is actually about to happen -- i.e. the class is not already allowed.
    const preSaveStatus = this.state.status ?? (await this.setup().status());
    const allowedClasses = new Set(preSaveStatus.config.allowedCapabilityClasses);
    const widensCapability =
      !allowedClasses.has("actions-possible") &&
      plan.agents.some((agent) => agent.capabilityClass === "actions-possible");
    const detail = [
      ...plan.agents.map((agent) => {
        const alias = agent.alias ?? previewAlias(agent.displayName);
        const capability =
          agent.capabilityClass === "actions-possible" ? t("actionsPossible") : t("knowledgeOnly");
        return `- ${alias} / ${agent.displayName} / ${capability}`;
      }),
      "",
      t("approveBody"),
      ...(widensCapability ? ["", t("actionsPossibleWidensCapability")] : [])
    ].join("\n");
    const confirmed = await this.host.confirm({
      title: t("approveTitle"),
      detail,
      confirmLabel: t("approveConfirm"),
      severity: "warning",
      kind: widensCapability ? "widening" : "agents"
    });
    if (!confirmed) {
      this.host.log("save: cancelled at the approval dialog");
      return;
    }

    await this.exclusive("save", async () => {
      this.patch({
        phase: "saving",
        error: undefined,
        progress: undefined,
        integrations: input.integrations
      });
      const result: ApplyResult = await this.setup().apply(plan, this.progressSink());
      const failed = result.registered.filter((entry) => entry.error);
      this.host.log(
        `save: ${result.registered.length - failed.length} registered, ${failed.length} failed, ` +
          `workspace file ${result.workspaceFile}, approved=${result.approved}`
      );
      await this.host.saveIntegrationFlags(input.integrations);
      const workspaceRoot = this.host.workspaceRoot();
      const variables = this.host.integrationVariables();
      const summary = await applyIntegrations(
        {
          definition: await this.host.integrationDefinition(),
          homeDirectory: this.host.homeDirectory(),
          ...(workspaceRoot ? { workspaceRoot } : {}),
          ...(variables ? { variables } : {})
        },
        input.integrations
      );
      for (const file of summary.written) this.host.log(`integration: wrote ${file}`);
      for (const skipped of summary.skipped) this.host.log(`integration: skipped ${skipped}`);
      for (const warning of summary.warnings ?? []) this.host.log(`integration: ${warning}`);
      if (result.restartRequired) {
        // P0-3: the broker reads GlobalConfig once at start() and never re-reads it, so a
        // broker-scoped change (browser.*/navigation.*/security.allowedCapabilityClasses/
        // conversations.*/invocation.*) needs a restart before it takes effect. Only key *names*
        // are logged, never their values.
        this.host.log(
          `save: broker-scoped config changed (${result.changedKeys.join(", ")}); restarting broker`
        );
        this.patch({ progress: { phase: "restarting-broker", message: t("restartingBroker") } });
        await this.setup().restartBroker();
      }
      let connected = false;
      let connectionError: PanelError | undefined;
      try {
        connected =
          (await this.setup().ensureSignedIn({ interactive: false, onProgress: this.progressSink() }))
            .state === "authenticated";
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "AUTH_REQUIRED"))
          connectionError = toPanelError(error, this.host.locale);
      }
      this.host.refreshClients();
      const warnings = [
        ...failed.map((entry) => `${entry.displayName}: ${entry.error?.code ?? "failed"}`),
        ...summary.skipped
      ];
      const status = await this.setup().status();
      this.patch({
        phase: "done",
        notice: connected ? undefined : "saved-needs-sign-in",
        error: connectionError,
        discoverySummary: undefined,
        status,
        candidates: mergeCandidates(status.registry, this.state.candidates),
        selectedKeys: savedAgents(status).map((candidate) => candidate.key),
        incidents: status.broker.incidents,
        warnings,
        // The discovery summaries described the run that produced these candidates; the "done"
        // view is about what was saved.
        diagnostics: [],
        progress: undefined
      });
      await this.host.saved({
        connected,
        written: summary.written,
        skipped: summary.skipped,
        registered: result.registered.length - failed.length,
        failed: failed.length
      });
    });
  }

  /* -------------------------------------------------------------- diagnostics */

  /** Metadata only: versions, the resolved runtime, the broker's auth state and the incident codes.
   * Never any prompt or response text. The host contributes the fields only it knows. */
  async copyDiagnostics(): Promise<void> {
    const diagnostics = {
      capturedAt: new Date().toISOString(),
      extensionVersion: this.host.version,
      ...(await this.host.hostDiagnostics()),
      brokerLive: this.health !== undefined,
      browserChannel: this.state.status?.browser.channel ?? null,
      authState: this.health?.authState ?? this.state.status?.broker.authState ?? null,
      incidents: this.state.incidents,
      lastErrorCode: this.state.error?.code ?? this.lastErrorCode ?? null
    };
    await this.host.clipboard(JSON.stringify(diagnostics, undefined, 2));
    this.host.log("diagnostics: copied to the clipboard (metadata only)");
    this.host.notify("info", translator(this.host.locale)("diagnosticsCopied"));
  }

  openLogs(): Promise<void> {
    return this.host.openLogs();
  }

  dispose(): void {
    void this.service?.cancelDiscovery().catch(() => undefined);
    this.healthSubscription.dispose();
  }
}
