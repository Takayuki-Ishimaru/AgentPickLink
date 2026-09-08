import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { AgentPickLinkMcpProvider } from "../../src/extension/mcp-provider.js";
import { SetupViewProvider } from "../../src/extension/setup-view.js";
import type { IntegrationFlags } from "../../src/extension/protocol.js";
import type { StatusKind } from "../../src/extension/status.js";
import type { AgentCandidate, SetupStatus } from "../../src/services/setup-service.js";
import {
  candidate,
  createFakeWebviewView,
  createRuntimeHarness,
  FakeSetupService,
  logText,
  setupStatus,
  type FakeWebviewView,
  type RuntimeHarness
} from "./harness.js";
import { answerWith, resetVscodeMock, vscodeMock } from "./vscode-mock.js";

const NO_INTEGRATIONS: IntegrationFlags = { codex: false, claudeCode: false, vscodeMcpJson: false };

type Panel = {
  provider: SetupViewProvider;
  webview: FakeWebviewView;
  service: FakeSetupService;
  mcpRefreshes: () => number;
  statusEvents: Array<{ kind: StatusKind; devMode: boolean }>;
};

let harness: RuntimeHarness;

async function createPanel(options: { language?: string } = {}): Promise<Panel> {
  harness = await createRuntimeHarness(options);
  const service = new FakeSetupService();
  const mcp = new AgentPickLinkMcpProvider(harness.runtime);
  let refreshes = 0;
  mcp.onDidChangeMcpServerDefinitions(() => {
    refreshes += 1;
  });
  const provider = new SetupViewProvider(harness.runtime, mcp, () => service);
  const statusEvents: Array<{ kind: StatusKind; devMode: boolean }> = [];
  provider.onDidChangeStatus((event) => statusEvents.push(event));
  const webview = createFakeWebviewView();
  provider.resolveWebviewView(webview.view);
  return { provider, webview, service, mcpRefreshes: () => refreshes, statusEvents };
}

/** Two discoverable agents: one already assigned to this workspace, one not. */
function discovery(): FakeSetupService["discovery"] {
  return {
    candidates: [
      candidate({
        key: "agent-requirements",
        displayName: "Requirements Agent",
        assigned: true,
        registered: {
          alias: "requirements",
          verified: true,
          enabled: true,
          kind: "m365-agent-builder",
          capabilityClass: "knowledge-only",
          usageHint: "Ask about requirements"
        }
      }),
      candidate({ key: "agent-hr", displayName: "HR Agent" })
    ],
    warnings: ["no-sidebar", "sidebar:0/0 link:3/1 scroll:0 store:unavailable"]
  };
}

function savePlan(): unknown {
  return {
    type: "save",
    plan: {
      agents: [
        { key: "agent-requirements", usageHint: "Ask about requirements", actionsPossible: false },
        { key: "agent-hr", displayName: "HR", actionsPossible: true }
      ],
      downloadHosts: ["https://contoso.sharepoint.com/sites/x"],
      acceptDownloads: true,
      integrations: NO_INTEGRATIONS
    }
  };
}

beforeEach(() => {
  resetVscodeMock();
});

afterEach(async () => {
  await harness?.dispose();
});

describe("runSetup", () => {
  it("goes status -> discover -> selecting with the assigned agents pre-selected", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();

    await panel.provider.runSetup();

    expect(panel.service.calls).toEqual(["status", "ensureBrowserChannel", "discover", "status"]);
    const state = panel.webview.last();
    expect(state.phase).toBe("selecting");
    expect(state.candidates.map((entry) => entry.key)).toEqual(["agent-requirements", "agent-hr"]);
    expect(state.selectedKeys).toEqual(["agent-requirements"]);
    // Failure tags stay warnings; the run's own summaries are diagnostics, never warnings.
    expect(state.warnings).toEqual([]);
    expect(state.diagnostics).toEqual(["no-sidebar", "sidebar:0/0 link:3/1 scroll:0 store:unavailable"]);
    expect(panel.webview.states.map((entry) => entry.phase)).toContain("checking");
    expect(panel.webview.states.find((entry) => entry.phase === "checking")?.progress).toMatchObject({
      phase: "connecting"
    });
  });

  it("signs in interactively first when the broker is not authenticated, reporting progress", async () => {
    const panel = await createPanel();
    panel.service.status_ = setupStatus({
      broker: { live: true, authState: { state: "sign-in-required", checkedAt: "x" }, incidents: [] }
    });
    panel.service.progress = [{ phase: "login-waiting", message: "waiting", elapsedMs: 3_000 }];
    answerWith("Open browser");

    await panel.provider.runSetup();

    expect(panel.service.calls).toEqual([
      "status",
      "ensureBrowserChannel",
      "ensureSignedIn",
      "discover",
      "status"
    ]);
    expect(panel.service.signInInputs).toEqual([{ interactive: true }]);
    expect(panel.webview.states.map((entry) => entry.phase)).toContain("signing-in");
    const withProgress = panel.webview.states.find((entry) => entry.progress?.phase === "login-waiting");
    expect(withProgress?.progress).toEqual({
      phase: "login-waiting",
      message: "waiting",
      elapsedMs: expect.any(Number)
    });
    expect(panel.webview.last().phase).toBe("selecting");
  });

  it("renders a cancelled sign-in as a neutral notice, never the error box", async () => {
    const panel = await createPanel();
    panel.service.status_ = setupStatus({
      broker: { live: true, authState: { state: "sign-in-required", checkedAt: "x" }, incidents: [] }
    });
    panel.service.signInError = Object.assign(
      new DomainError("AUTH_FAILED", "Sign-in was cancelled.", false),
      { details: { cancelled: true } }
    );
    answerWith("Open browser");

    await panel.provider.runSetup();

    const state = panel.webview.last();
    expect(state.notice).toBe("sign-in-cancelled");
    expect(state.error).toBeUndefined();
    expect(state.phase).toBe("idle");
    expect(logText()).toContain("setup: sign-in cancelled");
  });

  it("ignores a second action while one is still running", async () => {
    const panel = await createPanel();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = panel.service.status.bind(panel.service);
    panel.service.status = async () => {
      await gate;
      return original();
    };

    const first = panel.provider.runSetup();
    await panel.provider.runDiscover();
    release?.();
    await first;

    expect(panel.service.calls.filter((call) => call === "discover")).toHaveLength(1);
    expect(logText()).toContain("refresh-list: ignored, another operation is still running");
  });
});

/** A registry entry as `SetupStatus.registry` reports it. */
function registered(alias: string): NonNullable<AgentCandidate["registered"]> {
  return {
    alias,
    verified: true,
    enabled: true,
    kind: "m365-agent-builder",
    capabilityClass: "knowledge-only"
  };
}

/** A workspace that was set up here before: `.m365-agents.json` present, this machine's approval
 * recorded, two registered agents of which one is assigned to this workspace. No `authState`
 * models a broker that has not probed sign-in yet (a fresh auto-start). */
function setUpWorkspace(authState?: string): SetupStatus {
  return setupStatus({
    broker: {
      live: true,
      ...(authState ? { authState: { state: authState, checkedAt: "x" } } : {}),
      incidents: []
    },
    workspace: {
      root: "/tmp/workspace",
      configured: true,
      approvalStatus: "approved",
      assignments: [{ alias: "requirements", status: "ready" }]
    },
    registry: [
      candidate({
        key: "agent-requirements",
        displayName: "Requirements Agent",
        source: "registry",
        assigned: true,
        assignmentStatus: "ready",
        registered: registered("requirements")
      }),
      candidate({
        key: "agent-hr",
        displayName: "HR Agent",
        source: "registry",
        registered: registered("hr")
      })
    ]
  });
}

describe("autoConnect", () => {
  it("restores saved agents immediately and defers new-agent discovery to explicit refresh", async () => {
    const panel = await createPanel();
    panel.service.status_ = setUpWorkspace("authenticated");
    panel.service.discovery = {
      candidates: [
        ...discovery().candidates,
        candidate({ key: "new-from-m365", description: "Official description" })
      ],
      warnings: []
    };
    await panel.provider.autoConnect();
    expect(panel.webview.last().candidates.map((entry) => entry.key)).toEqual([
      "agent-requirements",
      "agent-hr"
    ]);
    expect(panel.webview.last().selectedKeys).toEqual(["agent-requirements"]);
    expect(panel.service.appliedPlans).toEqual([]);
  });

  it("shows the saved agents as connected, without a sign-in round trip, when the broker is signed in", async () => {
    const panel = await createPanel();
    panel.service.status_ = setUpWorkspace("authenticated");
    panel.service.discovery = discovery();

    await panel.provider.autoConnect();

    expect(panel.service.calls).toEqual(["status", "ensureBrowserChannel"]);
    const state = panel.webview.last();
    expect(state.phase).toBe("connected");
    expect(state.candidates.map((entry) => entry.key)).toEqual(["agent-requirements", "agent-hr"]);
    expect(state.selectedKeys).toEqual(["agent-requirements"]);
    expect(state.error).toBeUndefined();
    expect(panel.webview.states.map((entry) => entry.phase)).toContain("checking");
    expect(logText()).toContain("auto-connect: signed in; 1 saved agent(s)");
  });

  it("checks the saved sign-in silently when the broker has not reported one yet", async () => {
    const panel = await createPanel();
    panel.service.status_ = setUpWorkspace();
    panel.service.discovery = discovery();

    await panel.provider.autoConnect();

    expect(panel.service.calls).toEqual(["status", "ensureBrowserChannel", "ensureSignedIn", "status"]);
    expect(panel.service.signInInputs).toEqual([{ interactive: false }]);
    expect(panel.webview.last().phase).toBe("connected");
    expect(panel.webview.last().selectedKeys).toEqual(["agent-requirements"]);
  });

  it("notifies about an expired session without opening a browser or scanning the catalogue", async () => {
    const panel = await createPanel();
    panel.service.status_ = setUpWorkspace();
    panel.service.discovery = discovery();
    const signIn = panel.service.ensureSignedIn.bind(panel.service);
    panel.service.ensureSignedIn = async (opts) => {
      panel.service.signInError = opts.interactive ? undefined : new DomainError("AUTH_REQUIRED", "Expired");
      return signIn(opts);
    };

    await panel.provider.autoConnect();

    expect(panel.service.signInInputs).toEqual([{ interactive: false }]);
    expect(panel.webview.last()).toMatchObject({ phase: "idle", selectedKeys: ["agent-requirements"] });
    expect(panel.webview.last().candidates).toHaveLength(2);
    expect(panel.service.calls).not.toContain("discover");
    expect(panel.webview.states.some((state) => state.phase === "signing-in")).toBe(false);
    expect(vscodeMock.messages.some((message) => message.options?.modal)).toBe(false);
    expect(panel.service.appliedPlans).toEqual([]);
  });

  it("does nothing for a folder that was never set up here", async () => {
    const panel = await createPanel();

    await panel.provider.autoConnect();

    expect(panel.service.calls).toEqual(["status"]);
    expect(panel.webview.last().phase).toBe("idle");
    expect(panel.webview.last().candidates).toEqual([]);
    expect(logText()).toContain("auto-connect: nothing to resume (workspace not configured)");

    // A committed .m365-agents.json without this machine's approval is a request, not a setup.
    panel.service.status_ = setupStatus({
      workspace: {
        root: "/tmp/workspace",
        configured: true,
        approvalStatus: "approval-required",
        assignments: []
      }
    });
    await panel.provider.autoConnect();

    expect(panel.service.calls).toEqual(["status", "status"]);
    expect(logText()).toContain("auto-connect: nothing to resume (workspace approval-required)");
  });

  it("is skipped silently in Restricted Mode", async () => {
    const panel = await createPanel();
    panel.service.status_ = setUpWorkspace("authenticated");
    panel.service.discovery = discovery();
    vscodeMock.isTrusted = false;

    await panel.provider.autoConnect();

    expect(panel.service.calls).toEqual([]);
    expect(vscodeMock.messages).toEqual([]);
    expect(logText()).toContain("auto-connect: skipped (workspace not trusted)");
  });

  it("surfaces a real failure of the silent check as the usual error banner", async () => {
    const panel = await createPanel();
    panel.service.status_ = setUpWorkspace();
    panel.service.discovery = discovery();
    panel.service.signInError = new DomainError("BROWSER_START_FAILED", "The browser could not be started.");

    await panel.provider.autoConnect();

    const state = panel.webview.last();
    expect(state.phase).toBe("error");
    expect(state.error?.code).toBe("BROWSER_START_FAILED");
  });
});

describe("signIn", () => {
  it("ends connected with the saved roster when the panel was empty on a set-up workspace", async () => {
    const panel = await createPanel();
    panel.service.status_ = setUpWorkspace("authenticated");
    panel.service.discovery = discovery();

    await panel.provider.signIn();

    expect(panel.service.calls).toEqual(["ensureSignedIn", "status"]);
    expect(panel.service.signInInputs).toEqual([{ interactive: true }]);
    expect(vscodeMock.messages).toEqual([]);
    const state = panel.webview.last();
    expect(state.phase).toBe("connected");
    expect(state.selectedKeys).toEqual(["agent-requirements"]);
  });

  it("restores the saved roster after signing in without a full catalogue scan", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();
    panel.service.status_ = setUpWorkspace("authenticated");
    panel.service.discovery = discovery();

    await panel.provider.signIn();

    const state = panel.webview.last();
    expect(state.phase).toBe("connected");
    expect(state.candidates.map((entry) => entry.key)).toEqual(["agent-requirements", "agent-hr"]);
    expect(state.candidates.map((entry) => entry.source)).toEqual(["registry", "registry"]);
  });

  it("loads candidates for selection on a folder that was never set up here", async () => {
    const panel = await createPanel();

    await panel.provider.signIn();

    expect(panel.webview.last().phase).toBe("selecting");
    expect(panel.webview.last().candidates).toEqual([]);
  });
});

describe("unified connection recovery", () => {
  it.each([false, true])(
    "restarts a crashed background connection once (persistent failure: %s)",
    async (persistent) => {
      const panel = await createPanel();
      panel.service.discovery = discovery();
      const discover = panel.service.discover.bind(panel.service);
      let attempts = 0;
      panel.service.discover = (progress) => {
        panel.service.discoverError =
          ++attempts === 1 || persistent ? new DomainError("BROWSER_CRASHED", "Browser crashed") : undefined;
        return discover(progress);
      };
      await panel.webview.send({ type: "refresh" });
      expect(attempts).toBe(2);
      expect(panel.service.restartCount).toBe(1);
      expect(panel.webview.last().phase).toBe(persistent ? "error" : "selecting");
      if (!persistent) expect(panel.webview.last().candidates).toHaveLength(2);
      expect(panel.service.appliedPlans).toEqual([]);
    }
  );

  it("keeps refresh and setting changes silent when authentication has expired", async () => {
    const panel = await createPanel();
    panel.service.signInError = new DomainError("AUTH_REQUIRED", "Expired");
    await panel.webview.send({ type: "refresh" });
    expect(panel.service.signInInputs).toEqual([{ interactive: false }]);
    expect(panel.service.calls).not.toContain("discover");
    panel.service.updateConfigResult = { restartRequired: true, changedKeys: ["browser.channel"] };
    await panel.webview.send({ type: "updateConfig", patch: { channel: "chrome" } });
    expect(panel.webview.last().notice).toBe("saved-needs-sign-in");
    expect(panel.service.signInInputs.every((input) => !input.interactive)).toBe(true);
    expect(vscodeMock.messages.some((message) => message.options?.modal)).toBe(false);
  });

  it("applies browser settings and reconnects without a separate restart decision", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    panel.service.updateConfigResult = { restartRequired: true, changedKeys: ["browser.channel"] };
    await panel.webview.send({ type: "updateConfig", patch: { channel: "chrome" } });
    expect(panel.service.restartCount).toBe(1);
    expect(panel.service.calls).not.toContain("discover");
    expect(panel.service.signInInputs).toEqual([{ interactive: false }]);
    expect(panel.webview.last().phase).toBe("idle");
    expect(vscodeMock.messages).toEqual([]);
  });
});

describe("browser sign-in instructions", () => {
  it.each([
    ["runSetup", "ja", "ブラウザーを開く"],
    ["signIn", "ja", "ブラウザーを開く"],
    ["runSetup", "en", "Open browser"],
    ["signIn", "en", "Open browser"]
  ] as const)(
    "%s explains the handoff in %s before showing the sign-in state",
    async (action, language, open) => {
      const panel = await createPanel({ language });
      panel.service.status_ = setupStatus({
        broker: { live: true, authState: { state: "sign-in-required", checkedAt: "x" }, incidents: [] }
      });
      vscodeMock.answer = (message) => {
        expect(panel.webview.last().phase).toBe("checking");
        expect(message.kind).toBe("information");
        expect(message.options?.modal).toBe(true);
        expect(message.message).toContain("Microsoft 365");
        expect(message.options?.detail).toContain(
          language === "ja" ? "追加認証" : "additional authentication"
        );
        expect(message.options?.detail).toContain(
          language === "ja" ? "自動で閉じます" : "closes automatically"
        );
        expect(message.options?.detail).toContain("VS Code");
        expect(message.items).toEqual([open]);
        return open;
      };

      await panel.provider[action]();

      expect(vscodeMock.messages).toHaveLength(1);
      expect(panel.webview.states.map((entry) => entry.phase)).toContain("signing-in");
      expect(panel.webview.last().error).toBeUndefined();
      expect(panel.webview.last().phase).toBe("selecting");
    }
  );

  it.each(["runSetup", "signIn"] as const)(
    "dismissing the %s instructions cancels the flow",
    async (action) => {
      const panel = await createPanel();
      panel.service.status_ = setupStatus({
        broker: { live: true, authState: { state: "sign-in-required", checkedAt: "x" }, incidents: [] }
      });

      await panel.provider[action]();

      expect(vscodeMock.messages).toHaveLength(1);
      expect(panel.webview.states.map((entry) => entry.phase)).not.toContain("signing-in");
      expect(panel.service.calls).not.toContain("discover");
      expect(panel.webview.last()).toMatchObject({ phase: "idle", notice: "sign-in-cancelled" });
      expect(panel.webview.last().error).toBeUndefined();
    }
  );
});

describe("save", () => {
  it("does nothing when the modal approval is dismissed", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();
    vscodeMock.answer = () => undefined;

    await panel.webview.send(savePlan());

    expect(panel.service.calls).not.toContain("apply");
    expect(logText()).toContain("save: cancelled at the approval dialog");
  });

  it("names every agent, its capability and the machine-wide widening in the modal", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();
    vscodeMock.answer = () => undefined;

    await panel.webview.send(savePlan());

    const modal = vscodeMock.messages.at(-1);
    expect(modal?.options?.modal).toBe(true);
    // The registered alias wins over the discovered display name (see buildApplyPlan).
    expect(modal?.options?.detail).toContain("- requirements / Requirements Agent / knowledge only");
    expect(modal?.options?.detail).toContain("hr / HR / file output / actions possible");
    expect(modal?.options?.detail).toContain("other workspaces on this machine");
  });

  it("applies the plan built from the selected keys once approved", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();
    answerWith("Approve and save", "Later");

    await panel.webview.send(savePlan());

    expect(panel.service.appliedPlans).toHaveLength(1);
    const [plan] = panel.service.appliedPlans;
    expect(plan.downloadHosts).toEqual(["contoso.sharepoint.com"]);
    expect(plan.acceptDownloads).toBe(true);
    expect(plan.agents).toEqual([
      {
        url: "https://m365.cloud.microsoft/chat/agent/agent-requirements",
        alias: "requirements",
        displayName: "Requirements Agent",
        description: "",
        usageHint: "Ask about requirements",
        kind: "m365-agent-builder",
        capabilityClass: "knowledge-only"
      },
      {
        url: "https://m365.cloud.microsoft/chat/agent/agent-hr",
        displayName: "HR",
        description: "",
        capabilityClass: "actions-possible"
      }
    ]);
    expect(panel.webview.last().phase).toBe("done");
    expect(panel.mcpRefreshes()).toBe(1);
  });

  it("restarts the broker only when the applied config needs it", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();
    answerWith("Approve and save", "Later");
    await panel.webview.send(savePlan());
    expect(panel.service.restartCount).toBe(0);

    panel.service.applyResult_ = {
      ...panel.service.applyResult_,
      restartRequired: true,
      changedKeys: ["browser.acceptDownloads"]
    };
    answerWith("Approve and save", "Later");
    await panel.webview.send(savePlan());

    expect(panel.service.restartCount).toBe(1);
    expect(logText()).toContain("browser.acceptDownloads");
  });

  it("writes an MCP client file only for an enabled integration", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();

    answerWith("Approve and save", "Later");
    await panel.webview.send(savePlan());
    await expect(fs.stat(path.join(harness.workspaceRoot, ".mcp.json"))).rejects.toThrow();

    answerWith("Approve and save", "Later");
    await panel.webview.send({
      type: "save",
      plan: {
        agents: [{ key: "agent-hr" }],
        downloadHosts: [],
        acceptDownloads: false,
        integrations: { codex: false, claudeCode: true, vscodeMcpJson: false }
      }
    });

    const written = await fs.readFile(path.join(harness.workspaceRoot, ".mcp.json"), "utf8");
    expect(written).toContain("m365-agents");
    expect(written).not.toContain("M365_AGENT_DEV_");
    expect(vscodeMock.configurationUpdates.map((entry) => entry.key)).toContain(
      "agentpicklink.integrations.claudeCode"
    );
  });

  it("saves without asking users to reload the VS Code window", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();
    answerWith("Approve and save", "Reload");

    await panel.webview.send(savePlan());

    const prompt = vscodeMock.messages.at(-1);
    expect(prompt?.message).toBe("Selected agents saved.");
    expect(prompt?.items).toEqual([]);
    expect(vscodeMock.executedCommands.map((entry) => entry.command)).not.toContain(
      "workbench.action.reloadWindow"
    );
  });

  it("warns instead of saving when nothing is selected", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();

    await panel.webview.send({
      type: "save",
      plan: { agents: [], downloadHosts: [], acceptDownloads: false, integrations: NO_INTEGRATIONS }
    });

    expect(vscodeMock.messages.at(-1)?.message).toContain("Select at least one agent");
    expect(panel.service.calls).not.toContain("apply");
  });
});

describe("Windows setup completion and cancellation", () => {
  it("keeps saved settings and requests sign-in when a post-save restart loses the session", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();
    panel.service.applyResult_ = {
      ...panel.service.applyResult_,
      restartRequired: true,
      changedKeys: ["browser.acceptDownloads"]
    };
    panel.service.signInError = new DomainError("AUTH_REQUIRED", "Session not retained");
    answerWith("Approve and save");
    await panel.webview.send(savePlan());
    expect(panel.service.calls.slice(-3)).toEqual(["restartBroker", "ensureSignedIn", "status"]);
    expect(panel.service.signInInputs.at(-1)).toEqual({ interactive: false });
    expect(panel.webview.last()).toMatchObject({ phase: "done", notice: "saved-needs-sign-in" });
    expect(panel.service.appliedPlans).toHaveLength(1);
    expect(vscodeMock.messages.at(-1)?.message).toContain("Settings saved. Sign in again");
  });

  it("cancels while busy and keeps previously retrieved candidates", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    panel.service.discovery.candidates[0].description = "Previously retrieved description";
    await panel.provider.runSetup();
    const previousKeys = panel.webview.last().candidates.map((agent) => agent.key);
    let finish!: (value: { candidates: ReturnType<typeof candidate>[]; warnings: string[] }) => void;
    panel.service.discover = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const running = panel.provider.runSetup();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await panel.webview.send({ type: "cancelDiscovery" });
    expect(panel.service.calls).toContain("cancelDiscovery");
    finish({
      candidates: [candidate({ key: "agent-requirements", description: undefined })],
      warnings: ["discovery-cancelled"]
    });
    await running;
    expect(panel.webview.last().notice).toBe("discovery-cancelled");
    expect(panel.webview.last().candidates.map((agent) => agent.key)).toEqual(previousKeys);
    expect(panel.webview.last().error).toBeUndefined();
    expect(panel.webview.last().candidates[0].description).toBe("Previously retrieved description");
  });
});

describe("errors", () => {
  it("shows the code, the English text and a localized summary, and classifies UI drift", async () => {
    const panel = await createPanel();
    panel.service.discoverError = new DomainError(
      "UI_CHANGED",
      "The stop-generating control was not found.",
      false
    );

    await panel.provider.runDiscover();

    const state = panel.webview.last();
    expect(state.phase).toBe("error");
    expect(state.error?.code).toBe("UI_CHANGED");
    expect(state.error?.message).toBe("The stop-generating control was not found.");
    expect(state.error?.remediation).toContain("report it to the developer");
    expect(state.error?.summary).toBe(
      "The Microsoft 365 page structure differs from what this version expects."
    );
    expect(state.error?.localizedRemediation).toContain("Copy the diagnostic");
    expect(panel.provider.statusKind()).toBe("ui-changed");
  });

  it("does not classify an operational failure as UI drift", async () => {
    const panel = await createPanel();
    panel.service.discoverError = new DomainError("BROWSER_PROFILE_LOCKED", "Profile is locked.", false);

    await panel.provider.runDiscover();

    expect(panel.provider.statusKind()).toBe("error");
    expect(panel.webview.last().error?.localizedRemediation).toContain("Close the browser");
  });

  it("renders the summary and remediation in Japanese for a Japanese VS Code", async () => {
    const panel = await createPanel({ language: "ja" });

    panel.service.statusError = new DomainError("INVALID_ARGUMENT", "Invalid configuration.");
    await panel.provider.runSetup();

    const error = panel.webview.last().error;
    expect(error?.code).toBe("INVALID_ARGUMENT");
    expect(error?.summary).toBe("入力値が正しくありません。");
    expect(error?.message).toContain("Invalid configuration.");
    expect(error?.localizedRemediation).toBeUndefined();
  });

  it("keeps a non-domain failure as INTERNAL_ERROR with a localized summary", async () => {
    const panel = await createPanel();
    panel.service.statusError = new Error("socket hang up");

    await panel.provider.runSetup();

    const error = panel.webview.last().error;
    expect(error?.code).toBe("INTERNAL_ERROR");
    expect(error?.message).toBe("socket hang up");
    expect(error?.summary).toBe("An unexpected internal error occurred.");
  });
});

describe("Restricted Mode", () => {
  it("refuses setup, sign-in, discovery and save with the trust message", async () => {
    const panel = await createPanel();
    vscodeMock.isTrusted = false;

    await panel.provider.runSetup();
    await panel.provider.signIn();
    await panel.provider.runDiscover();
    await panel.webview.send(savePlan());
    await panel.provider.revokeWorkspace();

    expect(panel.service.calls).toEqual([]);
    expect(vscodeMock.messages).toHaveLength(5);
    for (const message of vscodeMock.messages) {
      expect(message.kind).toBe("warning");
      expect(message.message).toContain("Restricted Mode");
    }
  });

  it("still allows the read-only diagnostics actions", async () => {
    const panel = await createPanel();
    vscodeMock.isTrusted = false;

    await panel.provider.copyDiagnostics();

    expect(vscodeMock.clipboard).toHaveLength(1);
    const diagnostics = JSON.parse(vscodeMock.clipboard[0]) as Record<string, unknown>;
    expect(diagnostics.extensionVersion).toBe("0.1.0");
    expect(diagnostics.brokerLive).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain("prompt");
  });
});

describe("destructive actions", () => {
  it("unregisters an agent only after the modal naming it is confirmed", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();

    vscodeMock.answer = () => undefined;
    await panel.webview.send({ type: "unregisterAgent", key: "agent-requirements" });
    expect(panel.service.removedAliases).toEqual([]);
    expect(vscodeMock.messages.at(-1)?.options?.detail).toContain("requirements");

    answerWith("Unregister");
    await panel.webview.send({ type: "unregisterAgent", key: "agent-requirements" });
    expect(panel.service.removedAliases).toEqual(["requirements"]);
  });

  it("does nothing for an agent that is not registered", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    await panel.provider.runSetup();
    answerWith("Unregister");

    await panel.webview.send({ type: "unregisterAgent", key: "agent-hr" });

    expect(panel.service.removedAliases).toEqual([]);
    expect(vscodeMock.messages).toHaveLength(0);
  });

  it("revokes this workspace's approval only after its own confirmation", async () => {
    const panel = await createPanel();

    vscodeMock.answer = () => undefined;
    await panel.provider.revokeWorkspace();
    expect(panel.service.calls).not.toContain("revokeWorkspace");
    expect(vscodeMock.messages.at(-1)?.options?.detail).toContain(".m365-agents.json is not changed");

    answerWith("Revoke approval");
    await panel.provider.revokeWorkspace();
    expect(panel.service.calls).toContain("revokeWorkspace");
    expect(vscodeMock.messages.at(-1)?.message).toContain("approval was revoked");
  });
});

describe("health polling", () => {
  function health(overrides: Record<string, unknown> = {}): never {
    return {
      instanceId: "i1",
      protocolMajor: 1,
      protocolMinor: 0,
      browserStarted: true,
      transport: { healthy: true },
      incidents: [],
      ...overrides
    } as never;
  }

  it("maps the broker's auth state onto the status kind", async () => {
    const panel = await createPanel();
    expect(panel.provider.statusKind()).toBe("stopped");

    panel.provider.acceptHealth(health({ authState: { state: "authenticated", checkedAt: "x" } }));
    expect(panel.provider.statusKind()).toBe("ready");

    panel.provider.acceptHealth(health({ authState: { state: "sign-in-required", checkedAt: "x" } }));
    expect(panel.provider.statusKind()).toBe("sign-in");

    panel.provider.acceptHealth(undefined);
    expect(panel.provider.statusKind()).toBe("stopped");
    expect(panel.statusEvents.map((event) => event.kind)).toEqual(["ready", "sign-in", "stopped"]);
  });

  it("notifies about a required sign-in at most once per transition", async () => {
    const panel = await createPanel();
    const signInRequired = health({ authState: { state: "sign-in-required", checkedAt: "x" } });

    panel.provider.acceptHealth(signInRequired);
    panel.provider.acceptHealth(signInRequired);
    await new Promise((resolve) => setImmediate(resolve));

    const notifications = vscodeMock.messages.filter((entry) =>
      entry.message.includes("Microsoft 365 sign-in is required")
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].items).toEqual(["Sign in"]);
  });

  it("runs the sign-in command when the notification's button is pressed", async () => {
    const panel = await createPanel();
    answerWith("Sign in");

    panel.provider.acceptHealth(health({ authState: { state: "sign-in-required", checkedAt: "x" } }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(vscodeMock.executedCommands.map((entry) => entry.command)).toEqual(["agentpicklink.signIn"]);
  });

  it("surfaces the broker's dev-mode flags to the panel and the status event", async () => {
    const panel = await createPanel();

    panel.provider.acceptHealth(
      health({
        authState: { state: "authenticated", checkedAt: "x" },
        devMode: { insecureLoopback: true, devAppUrl: false }
      })
    );

    expect(panel.webview.last().devMode).toEqual({ insecureLoopback: true, devAppUrl: false });
    expect(panel.statusEvents.at(-1)).toEqual({ kind: "ready", devMode: true });
  });

  it("forwards the live browser info and the incident list", async () => {
    const panel = await createPanel();

    panel.provider.acceptHealth(
      health({
        authState: { state: "authenticated", checkedAt: "x" },
        browser: { channel: "chrome", headless: true, viewport: { width: 1440, height: 900 } },
        incidents: [{ at: "2026-09-05T00:00:00.000Z", code: "UI_CHANGED", message: "drifted" }]
      })
    );

    const state = panel.webview.last();
    expect(state.liveBrowser).toEqual({
      channel: "chrome",
      headless: true,
      viewport: { width: 1440, height: 900 }
    });
    expect(state.incidents.map((incident) => incident.code)).toEqual(["UI_CHANGED"]);
    expect(panel.provider.statusKind()).toBe("ui-changed");
  });
});

describe("webview plumbing", () => {
  it("serves a nonce-locked CSP and only the media resource root", async () => {
    const panel = await createPanel();
    const html = panel.webview.html();
    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9]{32}'/);
    expect(html).toContain("setup.js");
    expect(html).toContain("setup.css");
  });

  it("reports visibility changes so the poller can slow down", async () => {
    const panel = await createPanel();
    const seen: boolean[] = [];
    panel.provider.onDidChangeVisibility((visible) => seen.push(visible));
    panel.webview.setVisible(false);
    panel.webview.setVisible(true);
    expect(seen).toEqual([false, true]);
  });

  it("drops an unknown message instead of acting on it", async () => {
    const panel = await createPanel();
    await panel.webview.send({ type: "definitelyNotAMessage" });
    await panel.webview.send("not even an object");
    expect(panel.service.calls).toEqual([]);
  });

  it("re-posts the current state when the webview announces it is ready", async () => {
    const panel = await createPanel();
    const before = panel.webview.states.length;
    await panel.webview.send({ type: "ready" });
    expect(panel.webview.states.length).toBe(before + 1);
  });
});

describe("runSetup browser channel", () => {
  it("switches to an installed browser, restarts the broker, and tells the user before signing in", async () => {
    const panel = await createPanel();
    panel.service.discovery = discovery();
    panel.service.browserChannel_ = {
      changed: true,
      previous: "msedge",
      channel: "chrome",
      restartRequired: true
    };

    await panel.provider.runSetup();

    expect(panel.service.calls).toEqual([
      "status",
      "ensureBrowserChannel",
      "restartBroker",
      "status",
      "discover",
      "status"
    ]);
    const notice = vscodeMock.messages.find((message) => message.message.includes("chrome"));
    expect(notice?.message).toContain("msedge");
    expect(panel.webview.last().phase).toBe("selecting");
  });
});
