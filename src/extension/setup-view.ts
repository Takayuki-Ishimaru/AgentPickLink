/**
 * The `agentpicklink.setup` webview view: the VS Code *host* for `SetupController`.
 *
 * The state machine itself (phases, discovery, sign-in, Save, auto-connect, status classification)
 * lives in `src/services/setup-controller.ts` so the CLI's terminal wizard can drive the same code
 * (docs/extension-less-onboarding.md section 4.1). What is left here is everything that needs the
 * VS Code API: the webview and its HTML, the modal dialogs and notifications, the clipboard, the
 * output channel, workspace trust, the settings-backed integration flags, the MCP definition
 * refresh and the health/status events `extension.ts` wires to the status bar.
 *
 * Security notes:
 * - The webview only ever receives data (`PanelState`); URLs and descriptions are resolved by the
 *   controller from its own candidate list.
 * - Save always goes through a modal confirmation naming every agent, and then through
 *   `SetupService.apply()`, which is what writes the registry, `.m365-agents.json` and the local
 *   approval. The panel adds no shortcut around that.
 * - Nothing logged or copied from here contains prompt or response text.
 */
import * as vscode from "vscode";
import { openMachineInstallTerminal } from "./machine-install.js";
import { randomBytes } from "node:crypto";
import type { AppPaths } from "../config/paths.js";
import type { IntegrationDefinition, IntegrationVariables } from "../services/integrations.js";
import { translator } from "../services/localize.js";
import {
  SetupController,
  type BrokerHealthSnapshot,
  type ConfirmRequest,
  type Disposable,
  type SaveSummary,
  type SetupHost
} from "../services/setup-controller.js";
import { defaultCreateSetupService, type SetupServiceLike } from "./deps.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { AgentPickLinkMcpProvider } from "./mcp-provider.js";
import type { StatusKind } from "./status.js";
import {
  parseWebviewMessage,
  type HostMessage,
  type IntegrationFlags,
  type Locale,
  type WebviewMessage
} from "./protocol.js";

export type { StatusKind } from "./status.js";
export { toPanelError } from "../services/setup-controller.js";

function nonce(): string {
  // CSP nonces must be unpredictable. `Math.random()` is not a security primitive and can let
  // an injected webview resource guess the nonce; randomBytes is provided by the extension host.
  return randomBytes(16).toString("hex");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] as string
  );
}

export class SetupViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, SetupHost {
  static readonly viewType = "agentpicklink.setup";

  private view?: vscode.WebviewView;
  private readonly controller: SetupController;
  private readonly statusEmitter = new vscode.EventEmitter<{ kind: StatusKind; devMode: boolean }>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private readonly visibilityChanged = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this.visibilityChanged.event;
  /** The poller's snapshots, forwarded to the controller through the `SetupHost.onHealth` seam. */
  private readonly healthEmitter = new vscode.EventEmitter<BrokerHealthSnapshot | undefined>();

  /** `createService` is the test seam (src/extension/deps.ts); production passes the default. */
  constructor(
    private readonly runtime: ExtensionRuntime,
    private readonly mcp: AgentPickLinkMcpProvider,
    createService: (runtime: ExtensionRuntime) => SetupServiceLike = defaultCreateSetupService
  ) {
    this.controller = new SetupController(this, () => createService(runtime));
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  /* -------------------------------------------------------------- webview */

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.runtime.mediaUri()] };
    view.webview.html = this.html(view.webview);
    void this.runtime.ready().then(() => this.controller.postState());
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
    this.controller.postState();
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

  /** Panel -> host. Every case is a plain delegation: the decisions are the controller's. */
  private async handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "installMachine":
        return this.installMachine();
      case "ready":
        this.controller.postState();
        return;
      case "setup":
        return this.controller.runSetup();
      case "refresh":
      case "discover":
        return this.controller.runDiscover();
      case "signIn":
        return this.controller.signIn();
      case "signOut":
        return this.controller.signOut();
      case "cancelDiscovery":
        return this.controller.cancelDiscovery();
      case "cancelSignIn":
        return this.controller.cancelSignIn();
      case "restartBroker":
        return this.controller.restartBroker();
      case "save":
        return this.controller.save(message.plan);
      case "unregisterAgent":
        return this.controller.unregisterAgent(message.key);
      case "revokeWorkspace":
        return this.controller.revokeWorkspace();
      case "updateConfig":
        return this.controller.updateConfig(message.patch);
      case "copyDiagnostics":
        return this.controller.copyDiagnostics();
      case "openLogs":
        return this.controller.openLogs();
    }
  }

  async installMachine(): Promise<void> {
    const terminal = await openMachineInstallTerminal(this.runtime);
    const subscription = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      subscription.dispose();
      void this.runtime.reloadMachineInstall().then(() => {
        this.mcp.refresh();
        this.controller.postState();
      });
    });
  }

  /* -------------------------------------------------------------- SetupHost */

  get locale(): Locale {
    return this.runtime.locale;
  }

  get version(): string {
    return this.runtime.version;
  }

  get paths(): AppPaths {
    return this.runtime.paths;
  }

  post(message: HostMessage): void {
    void this.view?.webview.postMessage({
      ...message,
      state: { ...message.state, machineInstall: this.runtime.machineInstallOffer() }
    });
  }

  log(line: string): void {
    this.runtime.log(line);
  }

  /** Every consequence-naming question the flow asks is a native modal, as before. */
  async confirm(request: ConfirmRequest): Promise<boolean> {
    const options = { modal: true, ...(request.detail === undefined ? {} : { detail: request.detail }) };
    const answer =
      request.severity === "warning"
        ? await vscode.window.showWarningMessage(request.title, options, request.confirmLabel)
        : await vscode.window.showInformationMessage(request.title, options, request.confirmLabel);
    return answer === request.confirmLabel;
  }

  notify(level: "info" | "warning", text: string): void {
    if (level === "warning") void vscode.window.showWarningMessage(text);
    else void vscode.window.showInformationMessage(text);
  }

  /** G2: the notification's button reuses the same `agentpicklink.signIn` command the status bar
   * and the panel button do. */
  promptSignIn(request: { text: string; actionLabel: string }): void {
    void vscode.window.showWarningMessage(request.text, request.actionLabel).then((selection) => {
      if (selection === request.actionLabel) void vscode.commands.executeCommand("agentpicklink.signIn");
    });
  }

  async clipboard(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
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

  /** The VS Code-only half of the diagnostics blob; the controller adds the rest (metadata only). */
  async hostDiagnostics(): Promise<Record<string, unknown>> {
    const node = await this.runtime.node();
    return {
      vscodeVersion: vscode.version,
      platform: `${process.platform}-${process.arch}`,
      node: { kind: node.kind, version: node.version ?? null }
    };
  }

  workspaceRoot(): string | undefined {
    return this.runtime.workspaceRoot();
  }

  trusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  homeDirectory(): string {
    return this.runtime.homeDirectory();
  }

  integrationFlags(): IntegrationFlags {
    return this.runtime.integrationFlags();
  }

  saveIntegrationFlags(flags: IntegrationFlags): Promise<void> {
    return this.runtime.saveIntegrationFlags(flags);
  }

  integrationDefinition(): Promise<IntegrationDefinition> {
    return this.runtime.integrationDefinition();
  }

  integrationVariables(): IntegrationVariables | undefined {
    return this.runtime.integrationVariables();
  }

  brokerEntry(): string {
    return this.runtime.brokerEntry();
  }

  refreshClients(): void {
    this.mcp.refresh();
  }

  onHealth(listener: (health: BrokerHealthSnapshot | undefined) => void): Disposable {
    return this.healthEmitter.event(listener);
  }

  statusChanged(status: { kind: StatusKind; devMode: boolean }): void {
    this.statusEmitter.fire(status);
  }

  saved(summary: SaveSummary): Promise<void> {
    const t = translator(this.runtime.locale);
    void vscode.window.showInformationMessage(
      !summary.connected
        ? t("savedNeedsSignIn")
        : summary.written.length
          ? t("savedWithIntegrations")
          : t("saved")
    );
    return Promise.resolve();
  }

  /* -------------------------------------------------------------- commands */

  /** Called by the poller (extension.ts); reaches the controller through `onHealth`. */
  acceptHealth(health: BrokerHealthSnapshot | undefined): void {
    this.healthEmitter.fire(health);
  }

  statusKind(): StatusKind {
    return this.controller.statusKind();
  }

  runSetup(): Promise<void> {
    return this.controller.runSetup();
  }

  runDiscover(): Promise<void> {
    return this.controller.runDiscover();
  }

  autoConnect(): Promise<void> {
    return this.controller.autoConnect();
  }

  signIn(): Promise<void> {
    return this.controller.signIn();
  }

  signOut(): Promise<void> {
    return this.controller.signOut();
  }

  cancelSignIn(): Promise<void> {
    return this.controller.cancelSignIn();
  }

  revokeWorkspace(): Promise<void> {
    return this.controller.revokeWorkspace();
  }

  restartBroker(): Promise<void> {
    return this.controller.restartBroker();
  }

  refreshStatus(): Promise<void> {
    return this.controller.refreshStatus();
  }

  copyDiagnostics(): Promise<void> {
    return this.controller.copyDiagnostics();
  }

  dispose(): void {
    this.controller.dispose();
    this.statusEmitter.dispose();
    this.visibilityChanged.dispose();
    this.healthEmitter.dispose();
  }
}
