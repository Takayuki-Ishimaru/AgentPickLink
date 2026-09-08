import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerHealthSnapshot } from "../../src/extension/broker.js";
import type { ExtensionDeps } from "../../src/extension/deps.js";
import {
  activate,
  deactivate,
  HealthPoller,
  AUTO_START_DELAY_MS,
  POLL_HIDDEN_MS,
  POLL_VISIBLE_MS
} from "../../src/extension/extension.js";
import { CONFIGURATION_SECTION } from "../../src/extension/runtime.js";
import { SetupViewProvider } from "../../src/extension/setup-view.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  candidate,
  createRuntimeHarness,
  FakeSetupService,
  logText,
  setupStatus,
  type RuntimeHarness
} from "./harness.js";
import { lm, resetVscodeMock, setWorkspaceRoot, vscodeMock } from "./vscode-mock.js";

type Deps = ExtensionDeps & {
  service: FakeSetupService;
  health: BrokerHealthSnapshot | undefined;
  healthReads: number;
  autoStarts: number;
  closes: number;
};

let harness: RuntimeHarness;
let deps: Deps;

function createDeps(): Deps {
  const state: Deps = {
    service: new FakeSetupService(),
    health: undefined,
    healthReads: 0,
    autoStarts: 0,
    closes: 0,
    createSetupService: () => state.service,
    readBrokerHealth: () => {
      state.healthReads += 1;
      return Promise.resolve(state.health);
    },
    // Activation checks for a broker left behind by an older build before auto-start; that
    // path reads the descriptor from disk, which fake timers cannot flush, so stub it here.
    restartBrokerIfStale: async () => false,
    connectOrStartBroker: () => {
      state.autoStarts += 1;
      return Promise.resolve({
        close: () => {
          state.closes += 1;
        }
      });
    }
  };
  return state;
}

async function declaredCommands(): Promise<string[]> {
  const manifest = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    contributes: { commands: Array<{ command: string }> };
  };
  return manifest.contributes.commands.map((entry) => entry.command);
}

beforeEach(async () => {
  resetVscodeMock();
  harness = await createRuntimeHarness();
  deps = createDeps();
  // Off by default: the two auto-start tests turn it on explicitly.
  vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, false);
});

afterEach(async () => {
  deactivate();
  vi.useRealTimers();
  await harness.dispose();
});

describe("activate", () => {
  it("registers the startup update check and disposes it with the extension", () => {
    const update = { dispose: vi.fn() };
    deps.checkForUpdates = vi.fn(() => update);
    activate(harness.context as never, deps);
    expect(deps.checkForUpdates).toHaveBeenCalledOnce();
    expect(harness.context.subscriptions).toContain(update);
    for (const subscription of harness.context.subscriptions) subscription.dispose();
    expect(update.dispose).toHaveBeenCalledOnce();
  });

  it("registers the palette commands and legacy keybinding aliases", async () => {
    activate(harness.context as never, deps);
    const declared = await declaredCommands();
    expect([...vscodeMock.registeredCommands].sort()).toEqual(
      [
        ...declared,
        "agentpicklink.signIn",
        "agentpicklink.discover",
        "agentpicklink.restartBroker",
        "agentpicklink.reloadWindow"
      ].sort()
    );
    expect(declared.length).toBeGreaterThan(0);
  });

  it("registers the setup webview view with retained context", () => {
    activate(harness.context as never, deps);
    expect(vscodeMock.webviewProviders).toHaveLength(1);
    const [registration] = vscodeMock.webviewProviders;
    expect(registration.viewType).toBe(SetupViewProvider.viewType);
    expect(registration.viewType).toBe("agentpicklink.setup");
    expect(registration.options).toEqual({ webviewOptions: { retainContextWhenHidden: true } });
  });

  it("registers the MCP definition provider when the API exists", () => {
    activate(harness.context as never, deps);
    expect(vscodeMock.mcpProviders.map((entry) => entry.id)).toEqual(["agentpicklink.mcp"]);
  });

  it("activates without the MCP API on an older VS Code build", () => {
    lm.registerMcpServerDefinitionProvider = undefined;
    expect(() => activate(harness.context as never, deps)).not.toThrow();
    expect(vscodeMock.mcpProviders).toEqual([]);
    expect(vscodeMock.webviewProviders).toHaveLength(1);
  });

  it("creates a status bar item wired to the panel", () => {
    activate(harness.context as never, deps);
    expect(vscodeMock.statusBarItems).toHaveLength(1);
    const [item] = vscodeMock.statusBarItems;
    expect(item.command).toBe("agentpicklink.openPanel");
    expect(item.shown).toBe(true);
    expect(item.text).toContain("not connected");
  });

  it("refreshes the status bar from a health poll, including the dev-mode marker", async () => {
    vi.useFakeTimers();
    deps.health = {
      instanceId: "i1",
      protocolMajor: 1,
      protocolMinor: 0,
      browserStarted: true,
      transport: { healthy: true },
      authState: { state: "authenticated", checkedAt: "2026-09-05T00:00:00.000Z" },
      incidents: [],
      devMode: { insecureLoopback: true, devAppUrl: false }
    };
    activate(harness.context as never, deps);
    await vi.advanceTimersByTimeAsync(0);
    const [item] = vscodeMock.statusBarItems;
    expect(item.text).toContain("ready");
    expect(item.text).toContain("(dev)");
  });

  it("warns instead of running setup when no folder is open", async () => {
    setWorkspaceRoot(undefined);
    activate(harness.context as never, deps);
    await vscodeMock.commands.get("agentpicklink.setup")?.();
    expect(vscodeMock.messages.at(-1)?.kind).toBe("warning");
    expect(vscodeMock.messages.at(-1)?.message).toContain("single-root workspace");
    expect(deps.service.calls).toEqual([]);
  });

  it("routes agentpicklink.reloadWindow to the workbench command", async () => {
    activate(harness.context as never, deps);
    await vscodeMock.commands.get("agentpicklink.reloadWindow")?.();
    expect(vscodeMock.executedCommands.map((entry) => entry.command)).toContain(
      "workbench.action.reloadWindow"
    );
  });

  it("re-reads health and refreshes the MCP definitions when trust is granted", async () => {
    vi.useFakeTimers();
    activate(harness.context as never, deps);
    await vi.advanceTimersByTimeAsync(0);
    const before = deps.healthReads;
    vscodeMock.grantWorkspaceTrust();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.healthReads).toBe(before + 1);
    expect(logText()).toContain("workspace trust granted");
  });
});

describe("auto-start", () => {
  it("connects or starts the broker once, on a delay, and closes the probe connection", async () => {
    vi.useFakeTimers();
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    activate(harness.context as never, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.autoStarts).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.autoStarts).toBe(1);
    expect(deps.closes).toBe(1);
  });

  it("never auto-starts when the setting is off or no folder is open", async () => {
    vi.useFakeTimers();
    setWorkspaceRoot(undefined);
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    activate(harness.context as never, deps);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.autoStarts).toBe(0);
  });

  it("logs and keeps going when the broker cannot be started", async () => {
    vi.useFakeTimers();
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    deps.connectOrStartBroker = () => Promise.reject(new Error("no descriptor"));
    activate(harness.context as never, deps);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(logText()).toContain("auto-start: no descriptor");
  });

  it("does not start a second time when trust is granted before the delayed start", async () => {
    vi.useFakeTimers();
    vscodeMock.isTrusted = false;
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    activate(harness.context as never, deps);

    vscodeMock.isTrusted = true;
    vscodeMock.grantWorkspaceTrust();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(AUTO_START_DELAY_MS);

    expect(deps.autoStarts).toBe(1);
    expect(deps.closes).toBe(1);
  });

  it("still starts the broker after trust when auto-connect is disabled", async () => {
    vi.useFakeTimers();
    vscodeMock.isTrusted = false;
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoConnect`, false);
    activate(harness.context as never, deps);

    vscodeMock.isTrusted = true;
    vscodeMock.grantWorkspaceTrust();
    await vi.advanceTimersByTimeAsync(AUTO_START_DELAY_MS);

    expect(deps.autoStarts).toBe(1);
    expect(deps.service.calls).toEqual([]);
  });
});

describe("auto-connect", () => {
  /** A workspace set up here before (approval recorded), one saved agent, broker not yet probed. */
  function setUpWorkspaceStatus() {
    return setupStatus({
      broker: { live: true, incidents: [] },
      workspace: {
        root: harness.workspaceRoot,
        configured: true,
        approvalStatus: "approved",
        assignments: []
      },
      registry: [candidate({ key: "agent-requirements", source: "registry", assigned: true })]
    });
  }

  function healthWith(authState: string): BrokerHealthSnapshot {
    return {
      instanceId: "i1",
      protocolMajor: 1,
      protocolMinor: 0,
      browserStarted: true,
      transport: { healthy: true },
      authState: { state: authState, checkedAt: "x" },
      incidents: []
    };
  }

  /** The silent check is what makes the broker report an auth state; model that by updating the
   * polled health from inside the fake's `ensureSignedIn`. */
  function reportAuthStateOnCheck(authState: string): void {
    const ensureSignedIn = deps.service.ensureSignedIn.bind(deps.service);
    deps.service.ensureSignedIn = (opts) => {
      deps.health = healthWith(authState);
      return ensureSignedIn(opts);
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    deps.service.status_ = setUpWorkspaceStatus();
  });

  it("reaches ready with the saved agents selected, without any button press", async () => {
    reportAuthStateOnCheck("authenticated");

    activate(harness.context as never, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.service.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(deps.autoStarts).toBe(1);
    expect(deps.service.calls).toEqual(["status", "ensureBrowserChannel", "ensureSignedIn", "status"]);
    expect(deps.service.signInInputs).toEqual([{ interactive: false }]);
    expect(vscodeMock.statusBarItems[0].text).toContain("ready");
    expect(vscodeMock.messages).toEqual([]);
    expect(logText()).toContain("auto-connect: signed in; 1 saved agent(s)");
  });

  it("notifies once about expired authentication without opening a browser", async () => {
    const signIn = deps.service.ensureSignedIn.bind(deps.service);
    deps.service.ensureSignedIn = async (opts) => {
      deps.service.signInError = opts.interactive ? undefined : new DomainError("AUTH_REQUIRED", "Expired");
      deps.health = healthWith(opts.interactive ? "authenticated" : "sign-in-required");
      return signIn(opts);
    };
    activate(harness.context as never, deps);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.service.signInInputs).toEqual([{ interactive: false }]);
    expect(deps.service.calls.filter((call) => call === "discover")).toHaveLength(0);
    expect(vscodeMock.statusBarItems[0].text).toContain("sign-in required");
    await vi.advanceTimersByTimeAsync(3 * POLL_HIDDEN_MS);
    expect(deps.service.signInInputs).toHaveLength(1);
  });

  it("leaves the service alone when agentpicklink.autoConnect is off", async () => {
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoConnect`, false);

    activate(harness.context as never, deps);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(deps.autoStarts).toBe(1);
    expect(deps.service.calls).toEqual([]);
  });

  it("waits for workspace trust and resumes once it is granted", async () => {
    vscodeMock.isTrusted = false;
    reportAuthStateOnCheck("authenticated");

    activate(harness.context as never, deps);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.service.calls).toEqual([]);
    expect(vscodeMock.messages).toEqual([]);
    expect(logText()).toContain("auto-connect: skipped (workspace not trusted)");

    vscodeMock.isTrusted = true;
    vscodeMock.grantWorkspaceTrust();
    await vi.advanceTimersByTimeAsync(1);

    expect(deps.service.calls).toEqual(["status", "ensureBrowserChannel", "ensureSignedIn", "status"]);
    expect(vscodeMock.statusBarItems[0].text).toContain("ready");
  });
});

describe("deactivate", () => {
  it("stops the health poller", async () => {
    vi.useFakeTimers();
    activate(harness.context as never, deps);
    await vi.advanceTimersByTimeAsync(0);
    const afterActivation = deps.healthReads;
    expect(afterActivation).toBe(1);

    deactivate();
    await vi.advanceTimersByTimeAsync(5 * POLL_VISIBLE_MS);
    expect(deps.healthReads).toBe(afterActivation);
  });
});

describe("HealthPoller", () => {
  it("polls every 20s while visible and every 30s while hidden, and never starts a broker", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const poller = new HealthPoller(
      () => {
        reads += 1;
        return Promise.resolve(undefined);
      },
      () => {}
    );
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);

    poller.setVisible(true);
    await vi.advanceTimersByTimeAsync(POLL_VISIBLE_MS - 1);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(2);

    poller.setVisible(false);
    await vi.advanceTimersByTimeAsync(POLL_HIDDEN_MS - 1);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(3);

    poller.dispose();
    await vi.advanceTimersByTimeAsync(5 * POLL_HIDDEN_MS);
    expect(reads).toBe(3);
    // Nothing in this test could have started a broker: the poller's only collaborator is the
    // reader above (src/extension/deps.ts keeps connect-or-start on a separate seam).
    expect(deps.autoStarts).toBe(0);
  });

  it("hands each snapshot to the sink", async () => {
    vi.useFakeTimers();
    const seen: Array<BrokerHealthSnapshot | undefined> = [];
    const poller = new HealthPoller(
      () => Promise.resolve(undefined),
      (health) => seen.push(health)
    );
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([undefined]);
    poller.dispose();
  });

  it("does not overlap a manual refresh with an in-flight health read", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let resolveRead!: (health: BrokerHealthSnapshot | undefined) => void;
    const pending = new Promise<BrokerHealthSnapshot | undefined>((resolve) => {
      resolveRead = resolve;
    });
    const poller = new HealthPoller(
      () => {
        reads += 1;
        return pending;
      },
      () => {}
    );

    const first = poller.tick();
    const second = poller.tick();
    expect(reads).toBe(1);
    resolveRead(undefined);
    await Promise.all([first, second]);
    poller.dispose();
  });
});
