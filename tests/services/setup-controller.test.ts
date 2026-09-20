/**
 * `SetupController` driven through `SetupHost` alone -- no `vscode`, no webview, no extension
 * runtime. These are the tests WP-B's terminal host inherits: they prove that the whole flow
 * (status -> discover -> select -> Save, the capability-widening confirmation, and auto-connect's
 * silent trust check) is decided by the controller and only *rendered* by whichever host is
 * plugged in. The extension's own 207 tests cover the same flow through the webview host.
 *
 * The `SetupService` fakes are imported from tests/extension/harness.ts rather than copied.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appPaths, type AppPaths } from "../../src/config/paths.js";
import { DomainError } from "../../src/domain/errors.js";
import type { IntegrationDefinition, IntegrationVariables } from "../../src/services/integrations.js";
import {
  SetupController,
  type BrokerHealthSnapshot,
  type ConfirmRequest,
  type Disposable,
  type SaveSummary,
  type SetupHost
} from "../../src/services/setup-controller.js";
import type {
  HostMessage,
  IntegrationFlags,
  Locale,
  PanelState,
  SavePlanInput
} from "../../src/services/setup-protocol.js";
import type { StatusKind } from "../../src/services/setup-status.js";
import { candidate, FakeSetupService, setupStatus } from "../extension/harness.js";

const NODE_COMMAND = "/opt/apl/bin/node";
const NO_INTEGRATIONS: IntegrationFlags = { codex: false, claudeCode: false, vscodeMcpJson: false };

/**
 * A `SetupHost` that records instead of rendering. Everything a real host would show (dialogs,
 * notifications, the clipboard, the status bar) is a list a test can assert on.
 */
class FakeSetupHost implements SetupHost {
  readonly locale: Locale = "en";
  readonly version = "9.9.9";

  readonly posted: PanelState[] = [];
  readonly logs: string[] = [];
  readonly confirmed: ConfirmRequest[] = [];
  readonly notices: Array<{ level: "info" | "warning"; text: string }> = [];
  readonly signInPrompts: Array<{ text: string; actionLabel: string }> = [];
  readonly statuses: Array<{ kind: StatusKind; devMode: boolean }> = [];
  readonly savedFlags: IntegrationFlags[] = [];
  readonly summaries: SaveSummary[] = [];
  readonly clipboardText: string[] = [];
  clientRefreshes = 0;
  logsOpened = 0;

  /** Workspace trust: `false` is VS Code's Restricted Mode (a CLI host always answers true). */
  trust = true;
  /** Answers every `confirm()`; the default presses the confirmation button. */
  answer: (request: ConfirmRequest) => boolean = () => true;

  private readonly healthListeners: Array<(health: BrokerHealthSnapshot | undefined) => void> = [];

  constructor(
    readonly paths: AppPaths,
    private readonly workspace: string,
    private readonly home: string
  ) {}

  /** The distinct phases posted, in order, with consecutive repeats collapsed. */
  phases(): PanelState["phase"][] {
    return this.posted.map((state) => state.phase).filter((phase, index, all) => phase !== all[index - 1]);
  }

  last(): PanelState {
    return this.posted[this.posted.length - 1];
  }

  /** Pushes a health snapshot the way a poller would. */
  emitHealth(health: BrokerHealthSnapshot | undefined): void {
    for (const listener of [...this.healthListeners]) listener(health);
  }

  post(message: HostMessage): void {
    this.posted.push(message.state);
  }

  log(line: string): void {
    this.logs.push(line);
  }

  confirm(request: ConfirmRequest): Promise<boolean> {
    this.confirmed.push(request);
    return Promise.resolve(this.answer(request));
  }

  notify(level: "info" | "warning", text: string): void {
    this.notices.push({ level, text });
  }

  promptSignIn(request: { text: string; actionLabel: string }): void {
    this.signInPrompts.push(request);
  }

  clipboard(text: string): Promise<void> {
    this.clipboardText.push(text);
    return Promise.resolve();
  }

  openLogs(): Promise<void> {
    this.logsOpened += 1;
    return Promise.resolve();
  }

  hostDiagnostics(): Promise<Record<string, unknown>> {
    return Promise.resolve({ host: "fake" });
  }

  workspaceRoot(): string | undefined {
    return this.workspace;
  }

  trusted(): boolean {
    return this.trust;
  }

  homeDirectory(): string {
    return this.home;
  }

  integrationFlags(): IntegrationFlags {
    return { ...NO_INTEGRATIONS };
  }

  saveIntegrationFlags(flags: IntegrationFlags): Promise<void> {
    this.savedFlags.push(flags);
    return Promise.resolve();
  }

  integrationDefinition(): Promise<IntegrationDefinition> {
    return Promise.resolve({ command: NODE_COMMAND, args: [path.join(this.home, "apl.js"), "serve"] });
  }

  integrationVariables(): IntegrationVariables | undefined {
    return this.variables;
  }

  /** Set by a test that wants to assert `SetupController.save()` threads this through to
   * `applyIntegrations()` (§4.7 C9). */
  variables: IntegrationVariables | undefined = undefined;

  brokerEntry(): string {
    return path.join(this.home, "broker", "process.js");
  }

  refreshClients(): void {
    this.clientRefreshes += 1;
  }

  onHealth(listener: (health: BrokerHealthSnapshot | undefined) => void): Disposable {
    this.healthListeners.push(listener);
    return {
      dispose: () => {
        const index = this.healthListeners.indexOf(listener);
        if (index >= 0) this.healthListeners.splice(index, 1);
      }
    };
  }

  statusChanged(status: { kind: StatusKind; devMode: boolean }): void {
    this.statuses.push(status);
  }

  saved(summary: SaveSummary): Promise<void> {
    this.summaries.push(summary);
    return Promise.resolve();
  }
}

type Harness = {
  host: FakeSetupHost;
  service: FakeSetupService;
  controller: SetupController;
  workspace: string;
};

let temporary: string | undefined;

async function createHarness(): Promise<Harness> {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "apl-controller-"));
  const workspace = path.join(temporary, "workspace");
  const home = path.join(temporary, "home");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const host = new FakeSetupHost(appPaths(path.join(temporary, "appdata")), workspace, home);
  const service = new FakeSetupService();
  service.discovery = {
    candidates: [
      candidate({ key: "agent-requirements", displayName: "Requirements Agent", assigned: true }),
      candidate({ key: "agent-hr", displayName: "HR Agent" })
    ],
    warnings: []
  };
  return { host, service, controller: new SetupController(host, () => service), workspace };
}

function savePlan(overrides: Partial<SavePlanInput> = {}): SavePlanInput {
  return {
    agents: [{ key: "agent-requirements", actionsPossible: false }],
    downloadHosts: [],
    acceptDownloads: false,
    integrations: { ...NO_INTEGRATIONS },
    ...overrides
  };
}

beforeEach(() => {
  temporary = undefined;
});

afterEach(async () => {
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

describe("host-agnostic setup flow", () => {
  it("runs status -> discover -> select -> save and writes the host's own integration definition", async () => {
    const { host, service, controller, workspace } = await createHarness();

    await controller.runSetup();

    expect(service.calls).toEqual(["status", "ensureBrowserChannel", "discover", "status"]);
    expect(host.last().selectedKeys).toEqual(["agent-requirements"]);

    await controller.save(savePlan({ integrations: { ...NO_INTEGRATIONS, claudeCode: true } }));

    // One posted phase sequence for the whole flow: nothing about it is VS Code specific.
    expect(host.phases()).toEqual(["checking", "discovering", "selecting", "saving", "done"]);
    expect(host.confirmed.map((request) => request.severity)).toEqual(["warning"]);
    expect(service.appliedPlans).toHaveLength(1);
    expect(service.appliedPlans[0].agents.map((agent) => agent.displayName)).toEqual(["Requirements Agent"]);
    // saveIntegrationFlags -> applyIntegrations -> refreshClients, in that order, with the
    // definition the *host* supplied (a terminal host supplies `<home>/bin/apl.js` instead).
    expect(host.savedFlags).toEqual([{ ...NO_INTEGRATIONS, claudeCode: true }]);
    const written = await fs.readFile(path.join(workspace, ".mcp.json"), "utf8");
    expect(written).toContain(NODE_COMMAND);
    expect(host.summaries).toEqual([
      { connected: true, written: [path.join(workspace, ".mcp.json")], skipped: [], registered: 0, failed: 0 }
    ]);
    expect(host.clientRefreshes).toBe(1);
    expect(host.last().phase).toBe("done");
  });

  it("threads the host's integration variables through to applyIntegrations (§4.7 C9)", async () => {
    const { host, controller, workspace } = await createHarness();
    // NODE_COMMAND is "/opt/apl/bin/node" -- home-based under this userHome, so a working
    // IntegrationContext.variables plumbing turns it into the portable "${userHome}" form.
    host.variables = { userHome: "/opt/apl" };

    await controller.runSetup();
    await controller.save(savePlan({ integrations: { ...NO_INTEGRATIONS, vscodeMcpJson: true } }));

    const written = JSON.parse(await fs.readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")) as {
      servers: Record<string, { command: string }>;
    };
    expect(written.servers["m365-agents"].command).toBe("${userHome}/bin/node");
  });

  it("asks before widening the machine-wide capability allowance, and a decline aborts the save", async () => {
    const { host, service, controller } = await createHarness();
    service.status_ = setupStatus({
      config: { ...setupStatus().config, allowedCapabilityClasses: ["knowledge-only"] }
    });
    await controller.runSetup();
    host.answer = () => false;

    await controller.save(savePlan({ agents: [{ key: "agent-hr", actionsPossible: true }] }));

    const request = host.confirmed.at(-1);
    expect(request?.detail).toContain("- hr-agent / HR Agent / file output / actions possible");
    expect(request?.detail).toContain("other workspaces on this machine");
    expect(service.calls).not.toContain("apply");
    expect(service.appliedPlans).toEqual([]);
    expect(host.savedFlags).toEqual([]);
    expect(host.summaries).toEqual([]);
    expect(host.logs).toContain("save: cancelled at the approval dialog");
    expect(host.last().phase).toBe("selecting");
  });

  it("does not widen the allowance again once the class is already allowed", async () => {
    const { host, service, controller } = await createHarness();
    service.status_ = setupStatus({
      config: {
        ...setupStatus().config,
        allowedCapabilityClasses: ["knowledge-only", "actions-possible"]
      }
    });
    await controller.runSetup();

    await controller.save(savePlan({ agents: [{ key: "agent-hr", actionsPossible: true }] }));

    expect(host.confirmed.at(-1)?.detail).not.toContain("other workspaces on this machine");
    expect(service.appliedPlans).toHaveLength(1);
  });

  it("carries a partial discovery's failedCount and failedCountKnown into the panel state (WP-D)", async () => {
    const { host, service, controller } = await createHarness();
    service.discovery = {
      candidates: [candidate({ key: "agent-requirements", displayName: "Requirements Agent" })],
      warnings: ["store-catalog: total=10 done=8 none=2 errors=0"],
      partial: true,
      failedCount: 2
    };
    // FakeSetupService.discovery (tests/extension/harness.ts) predates `failedCountKnown`; set it
    // via Object.assign rather than widening that shared fixture's type just for this suite.
    Object.assign(service.discovery, { failedCountKnown: true });

    await controller.runSetup();

    expect(host.last().discoverySummary).toMatchObject({
      partial: true,
      failedCount: 2,
      failedCountKnown: true
    });
  });

  // ISSUE-2026-09-14-01: a partial reason with no count of its own (an expansion failure while
  // items were still arriving, or the store pass running out of its own budget) reports failedCount
  // as a floor of 1 with failedCountKnown: false, so the panel/CLI phrase it as "may not have been
  // retrieved" instead of a literal, possibly self-contradicting count.
  it("carries an unknown-count partial discovery's failedCountKnown: false into the panel state (WP-D)", async () => {
    const { host, service, controller } = await createHarness();
    service.discovery = {
      candidates: [candidate({ key: "agent-requirements", displayName: "Requirements Agent" })],
      warnings: [
        "store-catalog:items=210 attr=0 nav=10 dialog=0 open=0 forbidden-only=0 skipped=200 none=0 errors=0 off-host=0 more=2 retried=2 recovered=0 scroll=0 partial",
        "store-expansion-failed:TimeoutError:locator.click"
      ],
      partial: true,
      failedCount: 1
    };
    Object.assign(service.discovery, { failedCountKnown: false });

    await controller.runSetup();

    expect(host.last().discoverySummary).toMatchObject({
      partial: true,
      failedCount: 1,
      failedCountKnown: false
    });
  });

  it("falls back to the warning-text heuristic when the service reports no partial verdict", async () => {
    const { host, service, controller } = await createHarness();
    service.discovery = {
      candidates: [candidate({ key: "agent-requirements", displayName: "Requirements Agent" })],
      warnings: ["sidebar-scan-failed:TimeoutError"]
    };

    await controller.runSetup();

    expect(host.last().discoverySummary?.partial).toBe(true);
    expect(host.last().discoverySummary?.failedCount).toBeUndefined();
  });

  // item 1: a browser launch failure's redacted Playwright call log (DomainError.options.callLog,
  // forwarded across IPC -- see src/ipc/client.ts's receive()) must reach the host's own log next
  // to the "failed (CODE)" line it explains, prefixed browser-log: (src/cli/setup-host-terminal.ts
  // appends every host.log() line to cli.log).
  it("appends browser-log: lines under a failure that carries a callLog", async () => {
    const { host, service, controller } = await createHarness();
    service.statusError = new DomainError(
      "BROWSER_START_FAILED",
      "The msedge browser did not start: Timeout 30000ms exceeded.",
      false,
      { callLog: ["<launching> [redacted-url]", "<launched> pid=4242"], timedOut: true }
    );

    await controller.runSetup();

    expect(host.logs).toContain(
      "setup: failed (BROWSER_START_FAILED) The msedge browser did not start: Timeout 30000ms exceeded."
    );
    const browserLogLines = host.logs.filter((line) => line.startsWith("browser-log: "));
    expect(browserLogLines).toEqual([
      "browser-log: <launching> [redacted-url]",
      "browser-log: <launched> pid=4242"
    ]);
    expect(host.last().phase).toBe("error");
  });

  it("never adds browser-log: lines for a failure without a callLog", async () => {
    const { host, service, controller } = await createHarness();
    service.statusError = new DomainError("AUTH_REQUIRED", "Microsoft 365 sign-in is required.");

    await controller.runSetup();

    expect(host.logs.some((line) => line.startsWith("browser-log: "))).toBe(false);
  });

  it("skips auto-connect silently when the host reports an untrusted workspace", async () => {
    const { host, service, controller } = await createHarness();
    host.trust = false;

    await controller.autoConnect();

    expect(service.calls).toEqual([]);
    expect(host.posted).toEqual([]);
    expect(host.notices).toEqual([]);
    expect(host.logs).toEqual(["auto-connect: skipped (workspace not trusted)"]);
  });

  it("refuses the explicit flows with one warning each while untrusted", async () => {
    const { host, service, controller } = await createHarness();
    host.trust = false;

    await controller.runSetup();
    await controller.runDiscover();
    await controller.signIn();
    await controller.save(savePlan());

    expect(service.calls).toEqual([]);
    expect(host.notices).toHaveLength(4);
    expect(host.notices.every((notice) => notice.level === "warning")).toBe(true);
    expect(host.notices[0].text).toContain("Restricted Mode");
  });
});

describe("health handed in through the host", () => {
  function health(overrides: Record<string, unknown> = {}): BrokerHealthSnapshot {
    return {
      instanceId: "i1",
      protocolMajor: 1,
      protocolMinor: 0,
      browserStarted: true,
      transport: { healthy: true },
      incidents: [],
      ...overrides
    } as BrokerHealthSnapshot;
  }

  it("classifies the poller's snapshots and asks the host for a sign-in once per transition", async () => {
    const { host, controller } = await createHarness();
    expect(controller.statusKind()).toBe("stopped");

    host.emitHealth(health({ authState: { state: "sign-in-required", checkedAt: "x" } }));
    host.emitHealth(health({ authState: { state: "sign-in-required", checkedAt: "x" } }));
    expect(controller.statusKind()).toBe("sign-in");
    expect(host.signInPrompts).toHaveLength(1);
    expect(host.signInPrompts[0].actionLabel).toBe("Sign in");

    host.emitHealth(health({ authState: { state: "authenticated", checkedAt: "x" } }));
    expect(controller.statusKind()).toBe("ready");
    expect(host.statuses.map((status) => status.kind)).toEqual(["sign-in", "sign-in", "ready"]);
  });

  it("stops listening once disposed", async () => {
    const { host, controller } = await createHarness();
    controller.dispose();

    host.emitHealth(health({ authState: { state: "sign-in-required", checkedAt: "x" } }));

    expect(host.signInPrompts).toEqual([]);
    expect(controller.statusKind()).toBe("stopped");
  });
});

describe("diagnostics", () => {
  it("puts a metadata-only blob on the host's clipboard and merges the host's own fields", async () => {
    const { host, controller } = await createHarness();

    await controller.copyDiagnostics();

    const diagnostics = JSON.parse(host.clipboardText[0]) as Record<string, unknown>;
    expect(diagnostics).toMatchObject({
      extensionVersion: "9.9.9",
      host: "fake",
      brokerLive: false,
      lastErrorCode: null
    });
    expect(JSON.stringify(diagnostics)).not.toContain("prompt");
    expect(host.notices.at(-1)?.text).toContain("Diagnostic");
  });
});
