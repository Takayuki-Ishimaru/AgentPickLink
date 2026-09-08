/**
 * The `agentpicklink.setup` webview view: the whole "set up environment" flow lives here.
 *
 * Security notes:
 * - The webview only ever receives data (`PanelState`); URLs and descriptions are resolved here.
 * - Save always goes through a modal confirmation naming every agent, and then through
 *   `SetupService.apply()`, which is what writes the registry, `.m365-agents.json` and the local
 *   approval. The panel adds no shortcut around that.
 * - Nothing logged or copied from here contains prompt or response text.
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { splitDiscoveryWarnings } from "../domain/discovery-warnings.js";
import type { Incident } from "../observability/incidents.js";
import {
  classifyStatus,
  isDevMode,
  isWorkspaceSetUp,
  shouldNotifySignIn,
  type SignInNotifyInputs,
  type StatusKind
} from "./status.js";
import type { ProgressEvent } from "../domain/progress.js";
import {
  isSignInCancelledError,
  type AgentCandidate,
  type ApplyResult,
  type SetupStatus
} from "../services/setup-service.js";
import type { BrokerHealthSnapshot } from "./broker.js";
import { restartBrokerIfStale } from "./broker.js";
import { defaultCreateSetupService, type SetupServiceLike } from "./deps.js";
import { applyIntegrations } from "./integrations.js";
import { describeErrorCode, translator } from "./localize.js";
import { buildApplyPlan, mergeDownloadHostSuggestions, previewAlias } from "./plan.js";
import {
  parseWebviewMessage,
  type Locale,
  type PanelError,
  type PanelState,
  type SavePlanInput,
  type UpdateConfigPatchInput,
  type WebviewMessage
} from "./protocol.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { AgentPickLinkMcpProvider } from "./mcp-provider.js";

export type { StatusKind } from "./status.js";

function nonce(): string {
  // CSP nonces must be unpredictable. `Math.random()` is not a security primitive and can let
  // an injected webview resource guess the nonce; randomBytes is provided by the extension host.
  return randomBytes(16).toString("hex");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string
  );
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

export class SetupViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "agentpicklink.setup";

  private view?: vscode.WebviewView;
  private service?: SetupServiceLike;
  private busy = false;
  private operationStartedAt = 0;
  private lastErrorCode?: string;
  private health?: BrokerHealthSnapshot;
  /** G2: the sign-in-relevant slice of the previous poll's health, compared against the new one on
   * every `acceptHealth()` call by `shouldNotifySignIn()` -- see that function's doc comment for why
   * this is enough to notify "at most once per transition". */
  private lastSignInSnapshot: SignInNotifyInputs | undefined;
  private readonly statusChanged = new vscode.EventEmitter<{ kind: StatusKind; devMode: boolean }>();
  readonly onDidChangeStatus = this.statusChanged.event;
  private readonly visibilityChanged = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this.visibilityChanged.event;
  private state: PanelState;

  /** `createService` is the test seam (src/extension/deps.ts); production passes the default. */
  constructor(
    private readonly runtime: ExtensionRuntime,
    private readonly mcp: AgentPickLinkMcpProvider,
    private readonly createService: (
      runtime: ExtensionRuntime
    ) => SetupServiceLike = defaultCreateSetupService
  ) {
    this.state = {
      phase: "idle",
      candidates: [],
      selectedKeys: [],
      warnings: [],
      diagnostics: [],
      incidents: [],
      integrations: runtime.integrationFlags(),
      locale: runtime.locale,
      version: runtime.version
    };
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  private setup(): SetupServiceLike {
    this.service ??= this.createService(this.runtime);
    return this.service;
  }

  /* -------------------------------------------------------------- webview */

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.runtime.mediaUri()] };
    view.webview.html = this.html(view.webview);
    // The listener's return value is ignored by VS Code, but returning the promise lets a test
    // await the action a posted message triggered instead of polling for it.
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      return message ? this.handle(message) : undefined;
    });
    view.onDidChangeVisibility(() => this.visibilityChanged.fire(view.visible));
    view.onDidDispose(() => {
      this.view = undefined;
    });
    this.post();
  }

  private html(webview: vscode.Webview): string {
    const media = this.runtime.mediaUri();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "setup.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "setup.css"));
    const token = nonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${token}'`
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="${escapeHtml(this.runtime.locale)}">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${style}" rel="stylesheet" />
    <title>AgentPickLink</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${token}" src="${script}"></script>
  </body>
</html>`;
  }

  private post(): void {
    this.view?.webview.postMessage({ type: "state", state: this.state });
  }

  private patch(partial: Partial<PanelState>): void {
    this.state = { ...this.state, ...partial };
    this.post();
    this.fireStatusChanged();
  }

  private fireStatusChanged(): void {
    this.statusChanged.fire({ kind: this.statusKind(), devMode: isDevMode(this.health) });
  }

  private progressSink(): (event: ProgressEvent) => void {
    return (event) => {
      this.runtime.log(
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

  /** Called by the poller; never starts the broker or a browser. The panel is only re-rendered
   * when something the header/status actually shows changed, so a poll never disturbs in-progress
   * editing. G2: also fires the proactive "sign in" notification at most once per transition (see
   * `shouldNotifySignIn`), independent of whether anything else about this poll changed the panel. */
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
   * AUTH_FAILED incident); its button reuses the same `agentpicklink.signIn` command the status bar
   * and panel button do. */
  private notifySignIn(): void {
    const t = translator(this.runtime.locale);
    void vscode.window.showWarningMessage(t("signInRequiredNotification"), t("signIn")).then((selection) => {
      if (selection === t("signIn")) void vscode.commands.executeCommand("agentpicklink.signIn");
    });
  }

  /* -------------------------------------------------------------- actions */

  private async handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.post();
        return;
      case "setup":
        return this.runSetup();
      case "refresh":
      case "discover":
        return this.runDiscover();
      case "signIn":
        return this.signIn();
      case "signOut":
        return this.signOut();
      case "cancelDiscovery":
        await this.setup().cancelDiscovery();
        return;
      case "cancelSignIn":
        return this.cancelSignIn();
      case "restartBroker":
        return this.restartBroker();
      case "save":
        return this.save(message.plan);
      case "unregisterAgent":
        return this.unregisterAgent(message.key);
      case "revokeWorkspace":
        return this.revokeWorkspace();
      case "updateConfig":
        return this.updateConfig(message.patch);
      case "copyDiagnostics":
        return this.copyDiagnostics();
      case "openLogs":
        return this.openLogs();
    }
  }

  /** P1-17: gates every action that signs in, discovers, or saves on the workspace being trusted.
   * Status display, `restartBroker`, `openLogs`, and `copyDiagnostics` stay available regardless --
   * they read local diagnostics or manage the broker process, never write workspace files or reach
   * out to Microsoft 365 on the repository's behalf. Returns `false` (after showing the existing
   * `workspaceUntrusted` warning) when the caller should stop. */
  private requireTrustedWorkspace(): boolean {
    if (vscode.workspace.isTrusted) return true;
    void vscode.window.showWarningMessage(translator(this.runtime.locale)("workspaceUntrusted"));
    return false;
  }

  /** Serializes the long-running actions: the broker allows one browser operation at a time. */
  private async exclusive(label: string, action: () => Promise<void>): Promise<void> {
    if (this.busy) {
      this.runtime.log(`${label}: ignored, another operation is still running`);
      return;
    }
    this.busy = true;
    this.operationStartedAt = Date.now();
    this.runtime.log(`${label}: started`);
    // A one-shot notice (e.g. G1's "sign-in cancelled") is only meant to survive until the next
    // action the user takes -- clear it here rather than at every individual call site.
    if (this.state.notice !== undefined) this.patch({ notice: undefined });
    try {
      await action();
      this.runtime.log(`${label}: finished`);
    } catch (error) {
      // G1: `cancelSignIn()` runs concurrently with the `exclusive()`-wrapped action that is
      // waiting on `ensureSignedIn()`, so its cancellation surfaces here as this action's own
      // failure -- render it as a neutral notice, never the red error box.
      if (isSignInCancelledError(error)) {
        this.runtime.log(`${label}: sign-in cancelled`);
        this.patch({ phase: "idle", notice: "sign-in-cancelled", error: undefined, progress: undefined });
        await this.refreshStatusQuiet();
        return;
      }
      const panelError = toPanelError(error, this.runtime.locale);
      this.lastErrorCode = panelError.code;
      this.runtime.log(`${label}: failed (${panelError.code}) ${panelError.message}`);
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
      this.runtime.log(
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
      await restartBrokerIfStale(this.runtime).catch(() => false);
      let status = await this.setup().status();
      this.patch({ status, incidents: status.broker.incidents });
      // A missing browser is the most common first-run failure on macOS (no Edge): switch to an
      // installed channel up front instead of letting the launch fail later with a raw error.
      const channel = await this.setup().ensureBrowserChannel();
      if (channel.changed) {
        const t = translator(this.runtime.locale);
        this.runtime.log(`browser: switched channel ${channel.previous} -> ${channel.channel}`);
        void vscode.window.showInformationMessage(
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
        this.runtime.log(`sign-in: state=${result.state}`);
      }
      await this.discoverWithRecovery("selecting");
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
        this.mcp.refresh();
        await this.setup().ensureSignedIn({ interactive: false });
      } else {
        throw error;
      }
      await this.discoverInto(next);
    }
  }

  private async discoverInto(next: PanelState["phase"]): Promise<void> {
    this.patch({ phase: "discovering" });
    const { candidates, warnings, suggestedDownloadHosts } = await this.setup().discover(this.progressSink());
    const status = await this.setup().status();
    // SetupService has already matched the full list to the registry by stable ID or URL.
    // Merging again by key could duplicate an entry whose discovery key changed.
    const merged = warnings.includes("discovery-cancelled")
      ? mergeCandidates(this.state.candidates, candidates, true)
      : candidates;
    // The warnings are metadata-only by contract (strategy counts, the landing structure summary),
    // so logging them verbatim is what makes an empty result diagnosable from the log alone.
    this.runtime.log(
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
        partial:
          !warnings.includes("discovery-cancelled") &&
          warnings.some((line) => /failed:|partial|unavailable/.test(line))
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
    if (!vscode.workspace.isTrusted) {
      this.runtime.log("auto-connect: skipped (workspace not trusted)");
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
        this.runtime.log(`auto-connect: nothing to resume (workspace ${state})`);
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
      this.runtime.log(
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
    const t = translator(this.runtime.locale);
    return this.setup().ensureSignedIn({
      interactive: true,
      beforeInteractiveLogin: async () => {
        if (automatic) {
          this.patch({ phase: "signing-in", progress: undefined });
          void vscode.window.showInformationMessage(t("browserSignInInstructions"));
          return true;
        }
        const open = t("openSignInBrowser");
        const selection = await vscode.window.showInformationMessage(
          t("browserSignInTitle"),
          { modal: true, detail: t("browserSignInInstructions") },
          open
        );
        if (selection !== open) return false;
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
      this.runtime.log(`sign-in: state=${result.state}`);
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
      void vscode.window.showInformationMessage(translator(this.runtime.locale)("signedOut"));
    });
  }

  /** G1: deliberately not wrapped in `exclusive()` -- it must run *while* `signIn()`/`runSetup()`
   * is still busy awaiting `ensureSignedIn()`. Sets no panel state of its own: the sign-in action
   * this interrupts observes the resulting cancellation and does that (see `exclusive()`'s catch
   * clause and `isSignInCancelledError`). */
  async cancelSignIn(): Promise<void> {
    this.runtime.log("cancel-sign-in: requested");
    try {
      const result = await this.setup().cancelSignIn();
      this.runtime.log(`cancel-sign-in: cancelled=${result.cancelled}`);
    } catch (error) {
      this.runtime.log(`cancel-sign-in: failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** G3: distinct from "removeCandidate" (which only hides an entry from this panel session and
   * never touches the registry) -- this deletes the agent's registration everywhere. Confirmed with
   * a modal naming the agent before anything is deleted. */
  private async unregisterAgent(key: string): Promise<void> {
    if (!this.requireTrustedWorkspace()) return;
    const alias = this.state.candidates.find((candidate) => candidate.key === key)?.registered?.alias;
    if (!alias) return;
    const t = translator(this.runtime.locale);
    const answer = await vscode.window.showWarningMessage(
      t("unregisterConfirmTitle"),
      { modal: true, detail: `${alias}\n\n${t("unregisterConfirmBody")}` },
      t("unregisterConfirm")
    );
    if (answer !== t("unregisterConfirm")) {
      this.runtime.log("unregister-agent: cancelled at the confirmation dialog");
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
      void vscode.window.showInformationMessage(t("agentUnregistered"));
    });
  }

  /** G3: revokes only this workspace's local approval; `.m365-agents.json` and the registry are
   * left untouched (see `SetupService.revokeWorkspace`'s doc comment). Confirmed with a modal.
   * Public: also wired to the `agentpicklink.revokeWorkspace` command. */
  async revokeWorkspace(): Promise<void> {
    if (!this.requireTrustedWorkspace()) return;
    const t = translator(this.runtime.locale);
    const answer = await vscode.window.showWarningMessage(
      t("revokeConfirmTitle"),
      { modal: true, detail: t("revokeConfirmBody") },
      t("revokeConfirm")
    );
    if (answer !== t("revokeConfirm")) {
      this.runtime.log("revoke-workspace: cancelled at the confirmation dialog");
      return;
    }
    await this.exclusive("revoke-workspace", async () => {
      const status = await this.setup().revokeWorkspace();
      this.patch({ status, incidents: status.broker.incidents });
      void vscode.window.showInformationMessage(t("workspaceRevoked"));
    });
  }

  /** G5: the "Advanced" section's headless/channel toggle and the (optional) attachment retention/
   * quota fields. Offers to restart the broker immediately when the change needs it, reusing the
   * existing `restartBroker()` flow. */
  private async updateConfig(patch: UpdateConfigPatchInput): Promise<void> {
    if (!this.requireTrustedWorkspace()) return;
    await this.exclusive("update-config", async () => {
      const result = await this.setup().updateConfig(patch);
      if (result.restartRequired) {
        this.runtime.log(`update-config: broker-scoped config changed (${result.changedKeys.join(", ")})`);
        const t = translator(this.runtime.locale);
        this.patch({
          phase: "checking",
          progress: { phase: "restarting-broker", message: t("restartingBroker") }
        });
        await this.setup().restartBroker();
        this.mcp.refresh();
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

  private async save(input: SavePlanInput): Promise<void> {
    const t = translator(this.runtime.locale);
    if (!this.requireTrustedWorkspace()) return;
    const { plan, unknownKeys } = buildApplyPlan(input, this.state.candidates);
    if (unknownKeys.length > 0) this.runtime.log(`save: ignored ${unknownKeys.length} unknown key(s)`);
    if (plan.agents.length === 0) {
      void vscode.window.showWarningMessage(t("noAgentsSelected"));
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
    const answer = await vscode.window.showWarningMessage(
      t("approveTitle"),
      { modal: true, detail },
      t("approveConfirm")
    );
    if (answer !== t("approveConfirm")) {
      this.runtime.log("save: cancelled at the approval dialog");
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
      this.runtime.log(
        `save: ${result.registered.length - failed.length} registered, ${failed.length} failed, ` +
          `workspace file ${result.workspaceFile}, approved=${result.approved}`
      );
      await this.runtime.saveIntegrationFlags(input.integrations);
      const summary = await applyIntegrations(
        {
          definition: await this.runtime.integrationDefinition(),
          homeDirectory: this.runtime.homeDirectory(),
          ...(this.runtime.workspaceRoot() ? { workspaceRoot: this.runtime.workspaceRoot() } : {})
        },
        input.integrations
      );
      for (const file of summary.written) this.runtime.log(`integration: wrote ${file}`);
      for (const skipped of summary.skipped) this.runtime.log(`integration: skipped ${skipped}`);
      if (result.restartRequired) {
        // P0-3: the broker reads GlobalConfig once at start() and never re-reads it, so a
        // broker-scoped change (browser.*/navigation.*/security.allowedCapabilityClasses/
        // conversations.*/invocation.*) needs a restart before it takes effect. Only key *names*
        // are logged, never their values.
        this.runtime.log(
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
          connectionError = toPanelError(error, this.runtime.locale);
      }
      this.mcp.refresh();
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
      void vscode.window.showInformationMessage(
        !connected ? t("savedNeedsSignIn") : summary.written.length ? t("savedWithIntegrations") : t("saved")
      );
    });
  }

  /* -------------------------------------------------------------- diagnostics */

  async copyDiagnostics(): Promise<void> {
    const node = await this.runtime.node();
    const diagnostics = {
      capturedAt: new Date().toISOString(),
      extensionVersion: this.runtime.version,
      vscodeVersion: vscode.version,
      platform: `${process.platform}-${process.arch}`,
      node: { kind: node.kind, version: node.version ?? null },
      brokerLive: this.health !== undefined,
      browserChannel: this.state.status?.browser.channel ?? null,
      authState: this.health?.authState ?? this.state.status?.broker.authState ?? null,
      incidents: this.state.incidents,
      lastErrorCode: this.state.error?.code ?? this.lastErrorCode ?? null
    };
    await vscode.env.clipboard.writeText(JSON.stringify(diagnostics, undefined, 2));
    this.runtime.log("diagnostics: copied to the clipboard (metadata only)");
    void vscode.window.showInformationMessage(translator(this.runtime.locale)("diagnosticsCopied"));
  }

  async openLogs(): Promise<void> {
    const t = translator(this.runtime.locale);
    this.runtime.output.show(true);
    const answer = await vscode.window.showInformationMessage(
      this.runtime.paths.logs,
      t("revealLogs"),
      t("close")
    );
    if (answer === t("revealLogs"))
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(this.runtime.paths.logs));
  }

  dispose(): void {
    void this.service?.cancelDiscovery().catch(() => undefined);
    this.statusChanged.dispose();
    this.visibilityChanged.dispose();
  }
}
