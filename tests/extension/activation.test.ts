import { promises as fs } from "node:fs";
import path from "node:path";
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
import { CONFIGURATION_SECTION, ExtensionRuntime } from "../../src/extension/runtime.js";
import { mergeCodexConfigToml, mergeVscodeMcpJson } from "../../src/extension/integrations.js";
import { integrationVariablesFor, writeInstallJson } from "../../src/services/install-home.js";
import { SetupViewProvider } from "../../src/extension/setup-view.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  candidate,
  createRuntimeHarness,
  FAKE_NODE,
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

/** Captured before any `vi.useFakeTimers()` call, so it is always the real implementation. */
const realSetTimeout = setTimeout;

/**
 * Advances the fake clock, then hands the event loop a few *real* turns. §4.7 C13 made
 * `activate()`'s auto-start await `ExtensionRuntime.ready()` -- a real `install.json` read -- before
 * its first broker decision, and a thread-pool round trip is not a microtask, which is all
 * `advanceTimersByTimeAsync` flushes.
 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    await vi.advanceTimersByTimeAsync(0);
  }
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
    await advance(0);
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
    await advance(0);
    const before = deps.healthReads;
    vscodeMock.grantWorkspaceTrust();
    await advance(0);
    expect(deps.healthReads).toBe(before + 1);
    expect(logText()).toContain("workspace trust granted");
  });
});

describe("auto-start", () => {
  it("connects or starts the broker once, on a delay, and closes the probe connection", async () => {
    vi.useFakeTimers();
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    activate(harness.context as never, deps);
    await advance(0);
    expect(deps.autoStarts).toBe(0);
    await advance(2_000);
    expect(deps.autoStarts).toBe(1);
    expect(deps.closes).toBe(1);
  });

  it("never auto-starts when the setting is off or no folder is open", async () => {
    vi.useFakeTimers();
    setWorkspaceRoot(undefined);
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    activate(harness.context as never, deps);
    await advance(10_000);
    expect(deps.autoStarts).toBe(0);
  });

  it("logs and keeps going when the broker cannot be started", async () => {
    vi.useFakeTimers();
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    deps.connectOrStartBroker = () => Promise.reject(new Error("no descriptor"));
    activate(harness.context as never, deps);
    await advance(2_000);
    expect(logText()).toContain("auto-start: no descriptor");
  });

  it("does not start a second time when trust is granted before the delayed start", async () => {
    vi.useFakeTimers();
    vscodeMock.isTrusted = false;
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    activate(harness.context as never, deps);

    vscodeMock.isTrusted = true;
    vscodeMock.grantWorkspaceTrust();
    await advance(0);
    await advance(AUTO_START_DELAY_MS);

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
    await advance(AUTO_START_DELAY_MS);

    expect(deps.autoStarts).toBe(1);
    expect(deps.service.calls).toEqual([]);
  });

  // §4.7 C13: `brokerEntry()` is synchronous and only reflects `install.json` once the lazy read has
  // resolved. With every integration flag off (the default), auto-start is the *first* thing in
  // activation to touch the broker, so it has to await `runtime.ready()` itself -- otherwise the
  // machine install's live broker is judged against, and replaced by, this extension's own tree.
  it("awaits install.json before the first broker decision, so both see the machine install", async () => {
    await writeInstallJson(harness.installHome, {
      version: "9.9.9",
      installedBy: "archive",
      runtime: { path: "/machine/bin/node", source: "bundled", nodeVersion: "22.14.0" },
      identity: { command: "/machine/bin/node", args: ["/machine/bin/apl.js", "serve"] },
      clients: [],
      workspaces: [],
      platform: process.platform,
      updatedAt: "2026-09-13T00:00:00.000Z"
    });
    const machineBroker = path.join(harness.installHome, "app", "9.9.9", "dist", "broker", "process.js");
    const seenByStalenessCheck: string[] = [];
    const seenBySpawn: string[] = [];
    deps.restartBrokerIfStale = async (runtime) => {
      seenByStalenessCheck.push(runtime.brokerEntry());
      return false;
    };
    const connect = deps.connectOrStartBroker;
    deps.connectOrStartBroker = (runtime) => {
      seenBySpawn.push(runtime.brokerEntry());
      return connect(runtime);
    };
    vi.useFakeTimers();
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoStartBroker`, true);
    activate(harness.context as never, deps);

    await advance(AUTO_START_DELAY_MS);

    expect(seenByStalenessCheck).toEqual([machineBroker]);
    expect(seenBySpawn).toEqual([machineBroker]);
  });
});

// §4.7 C9 / P0-2: the activation refresh must pass the same variable prefixes the writers
// substituted with. Without them it expands nothing, reads a portable entry as stale, and rewrites
// it to an absolute path -- which the next `apl-setup` turns back into the variable form, forever.
describe("activation-time integration refresh", () => {
  it("leaves a variable-form .vscode/mcp.json byte-identical while still refreshing a stale entry", async () => {
    // `activate()` builds its own ExtensionRuntime, which no harness instance override can reach:
    // patch the prototype so its home directory (and therefore `${userHome}`) is the temp one, and
    // so `node()` never execs a real binary.
    const homeSpy = vi.spyOn(ExtensionRuntime.prototype, "homeDirectory").mockReturnValue(harness.home);
    const nodeSpy = vi.spyOn(ExtensionRuntime.prototype, "node").mockResolvedValue(FAKE_NODE);
    try {
      const identity = {
        command: path.join(harness.home, "apl", "bin", process.platform === "win32" ? "node.exe" : "node"),
        args: [path.join(harness.home, "apl", "bin", "apl.js"), "serve"]
      };
      await writeInstallJson(harness.installHome, {
        version: "9.9.9", // newer than the harness extension's 0.1.0, so §4.7 C4 defers to it
        installedBy: "archive",
        runtime: { path: identity.command, source: "bundled", nodeVersion: "22.14.0" },
        identity,
        clients: ["vscode", "codex"],
        workspaces: [harness.workspaceRoot],
        platform: process.platform,
        updatedAt: "2026-09-13T00:00:00.000Z"
      });

      const variables = integrationVariablesFor({
        env: process.env,
        platform: process.platform,
        homedir: harness.home
      });
      const portable = mergeVscodeMcpJson(
        undefined,
        { ...identity, env: { M365_AGENT_MANAGED: "1" } },
        variables
      );
      expect(portable).toContain("${"); // the writer really did substitute a variable
      const vscodeFile = path.join(harness.workspaceRoot, ".vscode", "mcp.json");
      await fs.mkdir(path.dirname(vscodeFile), { recursive: true });
      await fs.writeFile(vscodeFile, portable, "utf8");

      // A genuinely stale Codex entry, refreshed *after* the VS Code file in the same pass: its
      // "integration refreshed" line is the signal that the whole refresh has finished, so the
      // assertion below never races the floating promise `activate()` starts.
      const codexFile = path.join(harness.home, ".codex", "config.toml");
      await fs.mkdir(path.dirname(codexFile), { recursive: true });
      await fs.writeFile(
        codexFile,
        mergeCodexConfigToml(
          "",
          {
            command: "/old/node",
            args: ["/old/dist/cli/index.js", "serve"],
            startupTimeoutSec: 60,
            toolTimeoutSec: 900
          },
          undefined
        ),
        "utf8"
      );

      vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.integrations.vscodeMcpJson`, true);
      vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.integrations.codex`, true);

      activate(harness.context as never, deps);
      for (let turn = 0; turn < 200 && !logText().includes(`integration refreshed: ${codexFile}`); turn += 1)
        await new Promise((resolve) => setTimeout(resolve, 2));

      expect(logText()).toContain(`integration refreshed: ${codexFile}`);
      expect(logText()).not.toContain(`integration refreshed: ${vscodeFile}`);
      expect(await fs.readFile(vscodeFile, "utf8")).toBe(portable);
    } finally {
      nodeSpy.mockRestore();
      homeSpy.mockRestore();
    }
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
    await advance(0);
    expect(deps.service.calls).toEqual([]);
    await advance(2_000);

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
    await advance(2_000);
    expect(deps.service.signInInputs).toEqual([{ interactive: false }]);
    expect(deps.service.calls.filter((call) => call === "discover")).toHaveLength(0);
    expect(vscodeMock.statusBarItems[0].text).toContain("sign-in required");
    await advance(3 * POLL_HIDDEN_MS);
    expect(deps.service.signInInputs).toHaveLength(1);
  });

  it("leaves the service alone when agentpicklink.autoConnect is off", async () => {
    vscodeMock.configuration.set(`${CONFIGURATION_SECTION}.autoConnect`, false);

    activate(harness.context as never, deps);
    await advance(2_000);

    expect(deps.autoStarts).toBe(1);
    expect(deps.service.calls).toEqual([]);
  });

  it("waits for workspace trust and resumes once it is granted", async () => {
    vscodeMock.isTrusted = false;
    reportAuthStateOnCheck("authenticated");

    activate(harness.context as never, deps);
    await advance(2_000);
    expect(deps.service.calls).toEqual([]);
    expect(vscodeMock.messages).toEqual([]);
    expect(logText()).toContain("auto-connect: skipped (workspace not trusted)");

    vscodeMock.isTrusted = true;
    vscodeMock.grantWorkspaceTrust();
    await advance(1);

    expect(deps.service.calls).toEqual(["status", "ensureBrowserChannel", "ensureSignedIn", "status"]);
    expect(vscodeMock.statusBarItems[0].text).toContain("ready");
  });
});

describe("deactivate", () => {
  it("stops the health poller", async () => {
    vi.useFakeTimers();
    activate(harness.context as never, deps);
    await advance(0);
    const afterActivation = deps.healthReads;
    expect(afterActivation).toBe(1);

    deactivate();
    await advance(5 * POLL_VISIBLE_MS);
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
    await advance(0);
    expect(reads).toBe(1);

    poller.setVisible(true);
    await advance(POLL_VISIBLE_MS - 1);
    expect(reads).toBe(1);
    await advance(1);
    expect(reads).toBe(2);

    poller.setVisible(false);
    await advance(POLL_HIDDEN_MS - 1);
    expect(reads).toBe(2);
    await advance(1);
    expect(reads).toBe(3);

    poller.dispose();
    await advance(5 * POLL_HIDDEN_MS);
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
    await advance(0);
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
