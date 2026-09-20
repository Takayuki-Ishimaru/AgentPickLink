import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { loadGlobalConfig } from "../../config/global-config.js";
import { DomainError } from "../../domain/errors.js";
import {
  SetupController,
  type BrokerHealthSnapshot,
  type ConfirmRequest,
  type Disposable
} from "../../services/setup-controller.js";
import type {
  HostMessage,
  IntegrationFlags,
  WebviewMessage,
  PanelState
} from "../../services/setup-protocol.js";
import type { CommandDeps } from "../command-deps.js";
import { TerminalSetupHost, type TerminalSetupHostOptions } from "../setup-host-terminal.js";
import { startSetupServer, type SetupServer } from "./server.js";

/** Polls only an existing broker; closing the host releases both timer and IPC client. */
export function pollSetupHealth(
  deps: CommandDeps,
  listener: (health: BrokerHealthSnapshot | undefined) => void,
  intervalMs = 3_000
): Disposable {
  let disposed = false;
  let polling = false;
  let client: Awaited<ReturnType<CommandDeps["connectExistingBroker"]>>;
  const poll = async (): Promise<void> => {
    if (disposed || polling) return;
    polling = true;
    try {
      client = await deps.connectExistingBroker(deps.paths);
      if (disposed) return;
      const health = client ? ((await client.call("broker.health", {})) as BrokerHealthSnapshot) : undefined;
      if (!disposed) listener(health);
    } catch {
      if (!disposed) listener(undefined);
    } finally {
      client?.close();
      client = undefined;
      polling = false;
    }
  };
  const timer = setInterval(() => {
    void poll();
  }, intervalMs);
  timer.unref();
  void poll();
  return {
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      client?.close();
    }
  };
}

export class BrowserSetupHost extends TerminalSetupHost {
  server?: SetupServer;
  private readonly salt = randomBytes(32).toString("hex");
  private readonly keys = new Map<string, string>();
  constructor(
    options: TerminalSetupHostOptions,
    clients: Awaited<ReturnType<typeof loadGlobalConfig>>["clients"],
    private readonly deps: CommandDeps,
    /** ISSUE-08 (docs/validation-log-2026-09-14-windows.md): the workspace/project-scope selection
     * `install` already resolved from `--clients` (`vscodeWorkspace` -> VS Code, `claudeProject` ->
     * Claude Code, `codex` -> Codex) -- the panel's three checkboxes must open showing *this* run's
     * actual opt-in, not `TerminalSetupHost.integrationFlags()`'s config.yaml default, which is
     * whatever a previous run (or none at all) last saved. `undefined` for a caller that never had
     * a CLI selection to give (a lower-level test constructing this host directly) falls back to
     * that same config.yaml default, unchanged. The default, zero-touch user-scope writers
     * (`vscodeUser`/`claudeUser`) are `install`'s own concern outside this panel entirely and have
     * no slot in `IntegrationFlags` to show here -- documented in the report, not modeled here. */
    private readonly initialIntegrationFlags?: IntegrationFlags
  ) {
    super(options, clients);
  }
  /** ISSUE-08: seeds `SetupController`'s very first `PanelState.integrations` (read once, at
   * construction -- see setup-controller.ts) from the CLI's own `--clients` selection instead of
   * the terminal host's config.yaml default. `saveIntegrationFlags` below (inherited unchanged)
   * still persists whatever the page's checkboxes are set to when Save runs, exactly as before. */
  override integrationFlags(): IntegrationFlags {
    return this.initialIntegrationFlags ?? super.integrationFlags();
  }
  override post(message: HostMessage): void {
    super.post(message);
    const copy = structuredClone(message);
    this.keys.clear();
    const keyFor = (key: string): string => {
      const opaque = createHash("sha256").update(this.salt).update(key).digest("hex");
      this.keys.set(opaque, key);
      return opaque;
    };
    // URL-shaped discovery keys stay in the host; the page only receives opaque references.
    const visited = new WeakSet<object>();
    for (const candidate of [...copy.state.candidates, ...(copy.state.status?.registry ?? [])]) {
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      candidate.key = keyFor(candidate.key);
      candidate.url = "";
    }
    copy.state.selectedKeys = copy.state.selectedKeys.map(keyFor);
    this.server?.send(copy);
  }
  restoreMessage(message: WebviewMessage): WebviewMessage | undefined {
    if (message.type === "save") {
      if (message.plan.agents.some((agent) => !this.keys.has(agent.key))) return undefined;
      return {
        ...message,
        plan: {
          ...message.plan,
          agents: message.plan.agents.map((agent) => ({ ...agent, key: this.keys.get(agent.key)! }))
        }
      };
    }
    if (message.type === "unregisterAgent") {
      const key = this.keys.get(message.key);
      return key ? { ...message, key } : undefined;
    }
    return message;
  }
  override async confirm(request: ConfirmRequest): Promise<boolean> {
    if (!this.server?.active() || !this.deps.prompter.interactive) return false;
    this.server.send({
      type: "terminal",
      text: this.locale === "ja" ? "端末で確認してください。" : "Please confirm in the terminal."
    });
    this.deps.stdout(`${request.title}\n${request.detail ? `${request.detail}\n` : ""}`);
    // No browser message or automatic flag can answer this confirmation.
    const accepted = await this.deps.prompter.confirm(request.confirmLabel);
    if (this.server.active() && this.lastPanelState())
      this.post({ type: "state", state: this.lastPanelState()! });
    return this.server.active() && accepted;
  }
  override onHealth(listener: (health: BrokerHealthSnapshot | undefined) => void): Disposable {
    return pollSetupHealth(this.deps, listener);
  }
}

export async function runBrowserSetup(
  deps: CommandDeps,
  options: TerminalSetupHostOptions,
  packageRoot: string,
  noOpen: boolean,
  discoverySnapshot?: PanelState,
  /** ISSUE-08: `install`'s own `--clients` selection (`toIntegrationFlags(selection)`), so the
   * panel's checkboxes open matching this run's actual opt-in rather than config.yaml's saved
   * default -- see `BrowserSetupHost`'s constructor doc comment. */
  initialIntegrationFlags?: IntegrationFlags
): Promise<BrowserSetupHost> {
  if (!deps.prompter.interactive)
    throw new DomainError("INVALID_ARGUMENT", "Browser setup needs an interactive terminal for consent.");
  const config = await loadGlobalConfig(deps.paths);
  const host = new BrowserSetupHost(options, config.clients, deps, initialIntegrationFlags);
  const service = deps.createSetupService(deps, () => options.workspaceRoot);
  const controller = new SetupController(host, () => service);
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const server = await startSetupServer({
    mediaDirectory: path.join(packageRoot, "media"),
    onExpired: () => {
      void service.cancelSignIn().catch(() => undefined);
      controller.dispose();
      rejectDone(
        new DomainError("INVALID_ARGUMENT", "Setup expired after fifteen minutes. Run install again.")
      );
    },
    onMessage: async (raw) => {
      const message = host.restoreMessage(raw);
      if (!message || !server.active()) return;
      switch (message.type) {
        case "installMachine":
          return; // No extension is present in this host.
        case "ready":
          if (discoverySnapshot) {
            await controller.reuseDiscovery(discoverySnapshot);
            discoverySnapshot = undefined;
          } else controller.postState();
          return;
        case "setup":
          await controller.runSetup();
          return;
        case "refresh":
        case "discover":
          await controller.runDiscover();
          return;
        case "signIn":
          await controller.signIn();
          return;
        case "cancelSignIn":
          await controller.cancelSignIn();
          return;
        case "cancelDiscovery":
          await controller.cancelDiscovery();
          return;
        case "save":
          await controller.save(message.plan);
          if (host.savedSummary() && host.lastPanelState()?.phase !== "error") resolveDone();
          return;
        case "restartBroker":
          await controller.restartBroker();
          return;
        case "updateConfig":
          await controller.updateConfig(message.patch);
          return;
        case "copyDiagnostics":
          await controller.copyDiagnostics();
          return;
        case "openLogs":
          await controller.openLogs();
          return;
        // These consequences also stay in the terminal that owns the session.
        case "signOut":
        case "revokeWorkspace":
        case "unregisterAgent":
          if (
            !(await host.confirm({
              title: message.type,
              confirmLabel: "Continue / 続行",
              severity: "warning",
              kind: "agents"
            }))
          )
            return;
          if (message.type === "signOut") await controller.signOut();
          else if (message.type === "revokeWorkspace") await controller.revokeWorkspace();
          else await controller.unregisterAgent(message.key);
      }
    }
  }).catch((error: unknown) => {
    controller.dispose();
    throw error;
  });
  host.server = server;
  try {
    if (noOpen)
      deps.stdout(`${server.url}\n`); // User-facing only, never the log/JSON report.
    else {
      try {
        if (!deps.openBrowser) throw new Error("No browser opener");
        await deps.openBrowser(server.url);
      } catch {
        deps.stdout(`${server.url}\n`);
      }
    }
    await done;
    return host;
  } finally {
    controller.dispose();
    await server.close();
  }
}
