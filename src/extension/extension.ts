/**
 * Extension entry point (bundled to `dist/extension/extension.cjs` by esbuild.extension.mjs).
 *
 * Activation registers the setup view, the commands, the status bar item, the MCP definition
 * provider and the health poller. Polling only ever reads `broker.health` from an already running
 * broker -- it never starts the broker and therefore never starts a browser. The two things that
 * may: auto-start (`agentpicklink.autoStartBroker`) is the one activation path that starts the
 * broker, and auto-connect (`agentpicklink.autoConnect`, riding on it) the one that may start the
 * browser for an approved workspace, restores sign-in and reads the full agent list (see
 * `SetupViewProvider.autoConnect`).
 */
import * as vscode from "vscode";
import type { BrokerHealthSnapshot } from "./broker.js";
import { restartBrokerIfStale } from "./broker.js";
import { defaultExtensionDeps, type ExtensionDeps } from "./deps.js";
import { refreshStaleIntegrations } from "./integrations.js";
import { translator } from "./localize.js";
import { registerMcpProvider } from "./mcp-provider.js";
import { ExtensionRuntime } from "./runtime.js";
import { SetupViewProvider, type StatusKind } from "./setup-view.js";

export const POLL_VISIBLE_MS = 20_000;
export const POLL_HIDDEN_MS = 30_000;
export const AUTO_START_DELAY_MS = 2_000;

/**
 * Reads `broker.health` on a timer; the interval depends on whether the panel is visible.
 * Deliberately takes a plain reader rather than the runtime: polling must never be able to start
 * the broker (and therefore never start a browser), and that is enforced by construction here --
 * the only thing this class can call is `readHealth`.
 */
export class HealthPoller implements vscode.Disposable {
  private timer?: ReturnType<typeof setTimeout>;
  private visible = false;
  private stopped = false;
  /** A manual refresh can arrive while the scheduled probe is still in flight (for example when
   * workspace trust is granted). Do not create a second IPC connection for the same window. */
  private inFlight = false;

  constructor(
    private readonly readHealth: () => Promise<BrokerHealthSnapshot | undefined>,
    private readonly onHealth: (health: BrokerHealthSnapshot | undefined) => void
  ) {}

  start(): void {
    void this.tick();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.schedule();
  }

  async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    try {
      const health = await this.readHealth();
      if (!this.stopped) this.onHealth(health);
    } catch {
      // Health is advisory; a transient probe failure is represented by the next undefined
      // snapshot and must never stop future polling.
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), this.visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

let poller: HealthPoller | undefined;

/**
 * P1-9: once per activation, re-synchronizes an already-existing `m365-agents` entry in each
 * *enabled* integration's on-disk file with the current extension version's Node command/CLI path,
 * so upgrading the extension does not silently leave Codex/Claude Code/VS Code pointed at a moved
 * or deleted `dist/cli/index.js`. Never creates a first-time entry (that only ever happens through
 * an explicit Save) and never touches a disabled integration's file. Gated on workspace trust for
 * the same reason Save is: writing files on the repository's behalf should not happen silently in
 * Restricted Mode.
 */
async function refreshIntegrationsOnActivate(runtime: ExtensionRuntime): Promise<void> {
  if (!vscode.workspace.isTrusted) return;
  const settings = runtime.integrationFlags();
  if (!settings.codex && !settings.claudeCode && !settings.vscodeMcpJson) return;
  try {
    const definition = await runtime.integrationDefinition();
    const workspaceRoot = runtime.workspaceRoot();
    const summary = await refreshStaleIntegrations(
      { definition, homeDirectory: runtime.homeDirectory(), ...(workspaceRoot ? { workspaceRoot } : {}) },
      settings
    );
    for (const file of summary.refreshed) runtime.log(`integration refreshed: ${file}`);
    if (summary.refreshed.length > 0)
      void vscode.window.showInformationMessage(translator(runtime.locale)("integrationsRefreshed"));
  } catch (error) {
    runtime.log(`integration refresh: failed (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * `deps` is the test seam (src/extension/deps.ts): VS Code only ever passes the context, so the
 * default is the production wiring. Tests pass fakes so activation never reaches a real broker.
 */
export function activate(
  context: vscode.ExtensionContext,
  deps: ExtensionDeps = defaultExtensionDeps()
): void {
  const runtime = new ExtensionRuntime(context);
  const t = translator(runtime.locale);
  runtime.log(`activating AgentPickLink ${runtime.version} on ${process.platform}-${process.arch}`);
  void refreshIntegrationsOnActivate(runtime);
  if (deps.checkForUpdates) context.subscriptions.push(deps.checkForUpdates(context, runtime));

  const mcp = registerMcpProvider(runtime, context);
  const provider = new SetupViewProvider(runtime, mcp, deps.createSetupService);
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SetupViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.command = "agentpicklink.openPanel";
  context.subscriptions.push(statusBar);
  const statusLabels: Record<StatusKind, string> = {
    ready: t("statusReady"),
    "sign-in": t("statusSignIn"),
    stopped: t("statusStopped"),
    "ui-changed": t("statusUiChanged"),
    error: t("statusError")
  };
  const renderStatus = (kind: StatusKind, devMode: boolean): void => {
    statusBar.text = `$(organization) APL: ${statusLabels[kind]}${devMode ? " (dev)" : ""}`;
    statusBar.tooltip =
      kind === "ui-changed"
        ? t("uiChangedTooltip")
        : kind === "sign-in"
          ? t("signInTooltip")
          : "AgentPickLink";
    statusBar.backgroundColor =
      kind === "ui-changed" || kind === "error"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    statusBar.show();
  };
  context.subscriptions.push(provider.onDidChangeStatus(({ kind, devMode }) => renderStatus(kind, devMode)));
  renderStatus("stopped", false);

  poller = new HealthPoller(
    () => deps.readBrokerHealth(runtime),
    (health) => provider.acceptHealth(health)
  );
  context.subscriptions.push(poller);
  context.subscriptions.push(provider.onDidChangeVisibility((visible) => poller?.setVisible(visible)));
  poller.start();

  const requireWorkspace = (): boolean => {
    if (runtime.workspaceRoot()) return true;
    void vscode.window.showWarningMessage(t("noWorkspace"));
    return false;
  };
  const focusPanel = async (): Promise<void> => {
    await vscode.commands.executeCommand("workbench.view.extension.agentpicklink");
  };

  const commands: Array<[string, () => unknown]> = [
    [
      "agentpicklink.setup",
      async () => {
        if (!requireWorkspace()) return;
        await focusPanel();
        await provider.runSetup();
      }
    ],
    ["agentpicklink.refresh", () => provider.runSetup()],
    // Compatibility aliases for existing keybindings; the palette offers one refresh action.
    ["agentpicklink.signIn", () => provider.signIn()],
    ["agentpicklink.signOut", () => provider.signOut()],
    ["agentpicklink.cancelSignIn", () => provider.cancelSignIn()],
    [
      "agentpicklink.discover",
      async () => {
        if (!requireWorkspace()) return;
        await provider.runDiscover();
      }
    ],
    ["agentpicklink.restartBroker", () => provider.runSetup()],
    ["agentpicklink.revokeWorkspace", () => provider.revokeWorkspace()],
    ["agentpicklink.openLogs", () => provider.openLogs()],
    ["agentpicklink.copyDiagnostics", () => provider.copyDiagnostics()],
    ["agentpicklink.reloadWindow", () => vscode.commands.executeCommand("workbench.action.reloadWindow")],
    ["agentpicklink.openPanel", focusPanel]
  ];
  for (const [id, handler] of commands)
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  // Auto-connect rides on auto-start: once the broker is live, a workspace that was set up here
  // before is resumed: silently check sign-in and restore the saved roster. Off together with
  // autoStartBroker, or on its own via agentpicklink.autoConnect.
  const autoConnect = (): Promise<void> =>
    runtime.autoConnect() && runtime.workspaceRoot() ? provider.autoConnect() : Promise.resolve();
  // Trust can be granted before the delayed auto-start callback runs. Keep overlapping callbacks
  // within this activation single-flight so the shared broker starts or resumes only once.
  let autoStartPromise: Promise<void> | undefined;
  const autoStart = (): Promise<void> => {
    if (!vscode.workspace.isTrusted || !runtime.workspaceRoot()) return Promise.resolve();
    if (autoStartPromise) return autoStartPromise;
    autoStartPromise = (deps.restartBrokerIfStale ?? restartBrokerIfStale)(runtime)
      .catch(() => false)
      .then(() => deps.connectOrStartBroker(runtime))
      .then((client) => {
        client.close();
        runtime.log("auto-start: broker is live");
      })
      .then(autoConnect)
      .then(() => poller?.tick())
      .catch((error: unknown) => {
        runtime.log(`auto-start: ${error instanceof Error ? error.message : String(error)}`);
      });
    return autoStartPromise;
  };

  // Restricted Mode hides the MCP server and blocks Save; once the user trusts the folder, offer
  // the definition and refresh the panel without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      runtime.log("workspace trust granted");
      mcp.refresh();
      // Resume the same startup sequence that was deferred while the folder was untrusted.
      void (runtime.autoStartBroker() ? autoStart() : Promise.resolve()).then(() => poller?.tick());
    })
  );

  if (runtime.autoStartBroker() && runtime.workspaceRoot()) {
    const timer = setTimeout(() => {
      // Restricted Mode cannot auto-connect and must not start the shared broker just to have the
      // trust callback start it again later.
      if (!vscode.workspace.isTrusted) {
        void autoConnect();
        return;
      }
      // A broker left running by a previous extension build is stopped first, so the connect
      // below spawns this build's broker instead of talking to stale code.
      void autoStart();
    }, AUTO_START_DELAY_MS);
    timer.unref?.();
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
}

export function deactivate(): void {
  poller?.dispose();
  poller = undefined;
}
