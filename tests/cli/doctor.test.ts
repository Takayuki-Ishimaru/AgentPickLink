import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/cli/commands/doctor.js";
import { brokerLogPath, createBrokerLogger } from "../../src/observability/broker-log.js";
import { resolveStandaloneDefinition } from "../../src/cli/commands/integrations.js";
import {
  identityFor,
  integrationVariablesFor,
  resolveInstallHome,
  writeInstallJson,
  writeLaunchers
} from "../../src/services/install-home.js";
import { mergeClaudeMcpJson, mergeVscodeMcpJson } from "../../src/services/integrations.js";
import { makeCommandDeps, makeFakeBrokerClient, makeTempPaths } from "./helpers.js";

async function makeIsolatedHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "apl-doctor-home-"));
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "apl-doctor-ws-"));
}

describe("doctor > installConsistency (§4.7 C12)", () => {
  it("reports no-machine-install when <home>/install.json does not exist", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeIsolatedHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });

    const result = await runDoctor(deps);

    const consistency = result.installConsistency as Record<string, unknown>;
    expect(consistency.versionSkew).toBe("no-machine-install");
    expect(consistency.machineInstall).toBeUndefined();
    expect((consistency.runtime as { live: boolean }).live).toBe(false);
    expect(Array.isArray(consistency.policies)).toBe(true);
  });

  it("R4 item 4: reports brokerInstallRoot when the running broker's descriptor points at another install root", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeIsolatedHome();
    // Under a different, freshly made temp directory -- guaranteed to fall outside whatever
    // install root `osHome` resolves to.
    const foreignEntry = path.join(await makeIsolatedHome(), "app", "1.0.0", "dist", "broker", "process.js");
    const { deps } = makeCommandDeps({
      paths,
      homedir: () => osHome,
      readDescriptor: async () => ({
        pid: 1,
        pipeName: "apl-test-pipe",
        protocolMajor: 1,
        protocolMinor: 0,
        packageVersion: "1.0.0",
        instanceId: "other-root-broker",
        authSecret: "secret",
        createdAt: new Date().toISOString(),
        build: { entry: foreignEntry, mtimeMs: 0 }
      })
    });

    const result = await runDoctor(deps);

    const consistency = result.installConsistency as {
      brokerInstallRoot?: { entry: string; note: string };
    };
    expect(consistency.brokerInstallRoot).toEqual({
      entry: foreignEntry,
      note: "broker runs from another install root"
    });
    expect(result.findings).toContain("install.brokerInstallRoot");
  });

  it("does not report brokerInstallRoot when the running broker's descriptor entry matches the current install root", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeIsolatedHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });
    const home = resolveInstallHome({ env: deps.env, platform: deps.platform, homedir: osHome });
    const matchingEntry = path.join(home, "app", "1.0.0", "dist", "broker", "process.js");
    const withDescriptor = makeCommandDeps({
      paths,
      homedir: () => osHome,
      readDescriptor: async () => ({
        pid: 1,
        pipeName: "apl-test-pipe",
        protocolMajor: 1,
        protocolMinor: 0,
        packageVersion: "1.0.0",
        instanceId: "same-root-broker",
        authSecret: "secret",
        createdAt: new Date().toISOString(),
        build: { entry: matchingEntry, mtimeMs: 0 }
      })
    }).deps;

    const result = await runDoctor(withDescriptor);

    const consistency = result.installConsistency as { brokerInstallRoot?: unknown };
    expect(consistency.brokerInstallRoot).toBeUndefined();
    expect(result.findings).not.toContain("install.brokerInstallRoot");
  });

  it("does not report brokerInstallRoot when no broker is running", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeIsolatedHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });

    const result = await runDoctor(deps);

    const consistency = result.installConsistency as { brokerInstallRoot?: unknown };
    expect(consistency.brokerInstallRoot).toBeUndefined();
  });

  it("reports version skew and real runtime liveness against a live machine install", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeIsolatedHome();
    const workspace = await makeWorkspace();
    const { deps } = makeCommandDeps({
      paths,
      homedir: () => osHome,
      root: () => workspace,
      version: "1.0.0"
    });
    const home = resolveInstallHome({ env: deps.env, platform: deps.platform, homedir: osHome });
    const identity = identityFor({ home, platform: deps.platform });
    // process.execPath is the real Node binary running this test -- a safe, deterministic way to
    // exercise a real `--version` probe without shipping a fixture binary.
    await writeInstallJson(home, {
      version: "2.0.0",
      installedBy: "archive",
      runtime: { path: process.execPath, source: "node", nodeVersion: process.version.replace(/^v/, "") },
      identity,
      clients: [],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    await writeLaunchers({ home, version: "2.0.0", platform: deps.platform });

    const result = await runDoctor(deps);

    const consistency = result.installConsistency as {
      versionSkew: string;
      machineInstall: { version: string };
      runtime: { live: boolean; version?: string };
      aplJsTarget?: string;
    };
    expect(consistency.versionSkew).toBe("cli-older"); // CLI 1.0.0 < machine install 2.0.0
    expect(consistency.machineInstall.version).toBe("2.0.0");
    expect(consistency.runtime.live).toBe(true);
    expect(consistency.runtime.version).toBeTruthy();
    expect(consistency.aplJsTarget).toBe("2.0.0");
  });

  it("classifies workspace client files (legacy, managed) and flags a command that does not resolve here", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeIsolatedHome();
    const workspace = await makeWorkspace();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome, root: () => workspace });
    const definition = await resolveStandaloneDefinition(deps);

    // A legacy (pre-marker) entry whose command does not exist on this machine.
    await mkdir(path.join(workspace, ".vscode"), { recursive: true });
    await writeFile(
      path.join(workspace, ".vscode", "mcp.json"),
      mergeVscodeMcpJson(undefined, {
        command: "/no/such/node",
        args: ["/no/such/extension/dist/cli/index.js", "serve"]
      }),
      "utf8"
    );
    // A managed entry whose command does resolve (the real Node running this test).
    await writeFile(
      path.join(workspace, ".mcp.json"),
      mergeClaudeMcpJson(undefined, { ...definition, command: process.execPath }),
      "utf8"
    );

    const result = await runDoctor(deps);
    const consistency = result.installConsistency as {
      clients: Array<{ client: string; status: string; commandResolvable?: boolean }>;
    };
    const vscode = consistency.clients.find((c) => c.client === "vscode-workspace")!;
    const claude = consistency.clients.find((c) => c.client === "claude-project")!;
    const codex = consistency.clients.find((c) => c.client === "codex")!;
    expect(vscode.status).toBe("legacy");
    expect(vscode.commandResolvable).toBe(false);
    expect(claude.status).toBe("managed");
    expect(claude.commandResolvable).toBe(true);
    expect(codex.status).toBe("absent");
    expect(codex.commandResolvable).toBeUndefined();
  });

  it("flags a differently named entry pointing at AgentPickLink as a duplicate", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeIsolatedHome();
    const workspace = await makeWorkspace();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome, root: () => workspace });
    await mkdir(path.join(workspace, ".vscode"), { recursive: true });
    const written = mergeVscodeMcpJson(undefined, {
      command: "/machine/bin/node",
      args: ["/machine/bin/apl.js", "serve"]
    });
    const withDuplicate = JSON.stringify({
      servers: {
        ...JSON.parse(written).servers,
        "my-other-server": { command: "/machine/bin/node", args: ["/machine/bin/apl.js", "serve"] }
      }
    });
    await writeFile(path.join(workspace, ".vscode", "mcp.json"), withDuplicate, "utf8");

    const result = await runDoctor(deps);
    const consistency = result.installConsistency as {
      clients: Array<{ client: string; duplicateKeys: string[] }>;
    };
    const vscode = consistency.clients.find((c) => c.client === "vscode-workspace")!;
    expect(vscode.duplicateKeys).toEqual(["my-other-server"]);
  });
});

/* ------------------------------------------- §4.7 C9/C12 portability and bounded output (P1-7, §P2) */

describe("doctor > portable entries and untrusted output", () => {
  it("§4.7 C9 (P1-7): a variable-form entry resolves here, because doctor expands before access()", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeIsolatedHome();
    const workspace = await makeWorkspace();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome, root: () => workspace });
    const definition = await resolveStandaloneDefinition(deps);
    const variables = integrationVariablesFor({
      env: deps.env,
      platform: deps.platform,
      homedir: deps.homedir()
    });
    // The identity `apl-setup` writes lives under <home>, so the writer substitutes a variable for
    // its prefix. Create the file it names, so the only reason to report it unresolvable would be
    // doctor failing to expand the variable.
    await mkdir(path.dirname(definition.command), { recursive: true });
    await writeFile(definition.command, "#!/bin/sh\n", { mode: 0o755 });
    await mkdir(path.join(workspace, ".vscode"), { recursive: true });
    const portable = mergeVscodeMcpJson(undefined, definition, variables);
    expect(portable).toContain("${");
    await writeFile(path.join(workspace, ".vscode", "mcp.json"), portable, "utf8");

    const result = await runDoctor(deps);

    const consistency = result.installConsistency as {
      clients: Array<{ client: string; status: string; commandResolvable?: boolean }>;
    };
    const vscode = consistency.clients.find((client) => client.client === "vscode-workspace")!;
    expect(vscode.status).toBe("managed");
    expect(vscode.commandResolvable).toBe(true);
  });

  it("§P2: reports a runtime whose --version output is not a version as not live", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeIsolatedHome();
    const { deps } = makeCommandDeps({
      paths,
      homedir: () => osHome,
      // Bounded and shape-checked: this runs an arbitrary path read out of a file on disk.
      exec: async () => ({ stdout: "x".repeat(10_000) })
    });
    const home = resolveInstallHome({ env: deps.env, platform: deps.platform, homedir: osHome });
    await writeInstallJson(home, {
      version: "1.0.0",
      installedBy: "archive",
      runtime: { path: identityFor({ home, platform: deps.platform }).command, source: "bundled" },
      identity: identityFor({ home, platform: deps.platform }),
      clients: [],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });

    const result = await runDoctor(deps);

    const runtime = (
      result.installConsistency as { runtime: { live: boolean; version?: string; error?: string } }
    ).runtime;
    expect(runtime.live).toBe(false);
    expect(runtime.version).toBeUndefined();
    expect(runtime.error).toContain("did not answer --version");
    expect(runtime.error!.length).toBeLessThan(400);
  });

  it("§P2: truncates a runaway error message and never reports a bogus aplJsTarget", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeIsolatedHome();
    const { deps } = makeCommandDeps({
      paths,
      homedir: () => osHome,
      exec: async () => {
        throw new Error("!".repeat(5_000));
      }
    });
    const home = resolveInstallHome({ env: deps.env, platform: deps.platform, homedir: osHome });
    await writeInstallJson(home, {
      version: "1.0.0",
      installedBy: "archive",
      runtime: { path: identityFor({ home, platform: deps.platform }).command, source: "bundled" },
      identity: identityFor({ home, platform: deps.platform }),
      clients: [],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    // A hand-edited `bin/apl.js` naming something that could never be an `app/<version>` directory.
    await mkdir(path.join(home, "bin"), { recursive: true });
    await writeFile(
      path.join(home, "bin", "apl.js"),
      'const entry = path.join(__dirname, "..", "app", "../../etc/passwd", "dist", "cli", "index.js");\n',
      "utf8"
    );

    const result = await runDoctor(deps);

    const consistency = result.installConsistency as {
      runtime: { error?: string };
      aplJsTarget?: string;
    };
    expect(consistency.runtime.error!.length).toBeLessThanOrEqual(201);
    expect(consistency.aplJsTarget).toBeUndefined();
  });
});

describe("doctor", () => {
  it("with no options, adds neither authentication nor agent checks and calls no broker method at all", async () => {
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({ paths });

    const result = await runDoctor(deps);

    expect(result).not.toHaveProperty("authentication");
    expect(result).not.toHaveProperty("agent");
    expect(result).toHaveProperty("broker");
    expect(result).toHaveProperty("registry");
    expect(result).toHaveProperty("workspace");
    // The browser channel/install check is a local (no-broker) HealthService.localReport check;
    // it must always be present regardless of broker connectivity.
    expect(result).toHaveProperty("browser");
  });

  it("passes a live broker's authState and incidents straight through in result.broker, unmodified", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "broker.health": {
        instanceId: "x",
        authState: { state: "sign-in-required", checkedAt: "2026-09-01T00:00:00.000Z" },
        incidents: [{ at: "2026-09-01T00:00:00.000Z", code: "UI_CHANGED", phase: "invoke", message: "m" }]
      }
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps);

    expect(result.broker).toMatchObject({
      live: true,
      authState: { state: "sign-in-required", checkedAt: "2026-09-01T00:00:00.000Z" },
      incidents: [{ code: "UI_CHANGED", phase: "invoke" }]
    });
  });

  // item 1: doctor prints broker.log's path and its last 20 lines (metadata only) when a
  // BROWSER_START_FAILED was recorded anywhere in the run -- here, a live incident.
  it("prints broker.log's path and tail when the live broker recorded a BROWSER_START_FAILED incident", async () => {
    const paths = await makeTempPaths();
    const logger = createBrokerLogger(paths.logs);
    logger.log("broker: started pid=1");
    logger.log("browser: launch failure call log (1 line(s), redacted):");
    logger.log("browser: <launched> pid=4242");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const broker = makeFakeBrokerClient({
      "broker.health": {
        instanceId: "x",
        incidents: [
          {
            at: "2026-09-01T00:00:00.000Z",
            code: "BROWSER_START_FAILED",
            phase: "browser.login",
            message: "m"
          }
        ]
      }
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps);

    expect(result.brokerLog).toMatchObject({ path: brokerLogPath(paths.logs) });
    const brokerLog = result.brokerLog as { path: string; tail: string[] };
    expect(brokerLog.tail).toEqual([
      expect.stringContaining("broker: started pid=1"),
      expect.stringContaining("browser: launch failure call log (1 line(s), redacted):"),
      expect.stringContaining("browser: <launched> pid=4242")
    ]);
  });

  it("omits brokerLog entirely when no BROWSER_START_FAILED was recorded", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "broker.health": {
        instanceId: "x",
        incidents: [{ at: "2026-09-01T00:00:00.000Z", code: "UI_CHANGED", phase: "invoke", message: "m" }]
      }
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps);

    expect(result).not.toHaveProperty("brokerLog");
  });

  it("--auth adds only an authentication check, via browser.authState, never a conversation/invoke call", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "broker.health": { instanceId: "x" },
      "browser.authState": { state: "authenticated" }
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps, { auth: true });

    expect(result).toHaveProperty("authentication");
    expect(result).not.toHaveProperty("agent");
    const methods = broker.calls.map((call) => call.method);
    expect(methods).toContain("browser.authState");
    expect(methods.some((method) => method.toLowerCase().includes("invoke"))).toBe(false);
  });

  it("--agent adds only an agent check, calling agent.validate with sendTestMessage:false, never true", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "broker.health": { instanceId: "x" },
      "agent.validate": { valid: true }
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps, { agent: "requirements" });

    expect(result).toHaveProperty("agent");
    expect(result).not.toHaveProperty("authentication");
    const agentValidateCall = broker.calls.find((call) => call.method === "agent.validate");
    expect(agentValidateCall?.params).toEqual({ agent: "requirements", sendTestMessage: false });
  });

  it("never calls any transport invoke/submission method, with both --auth and --agent set", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "broker.health": { instanceId: "x" },
      "browser.authState": { state: "authenticated" },
      "agent.validate": { valid: true }
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    await runDoctor(deps, { auth: true, agent: "requirements" });

    const methods = broker.calls.map((call) => call.method);
    expect(
      methods.some(
        (method) => method.toLowerCase().includes("invoke") || method.toLowerCase().includes("submit")
      )
    ).toBe(false);
  });
});

describe("doctor source install", () => {
  it("reports the dev launcher's absolute target instead of omitting it", async () => {
    const paths = await makeTempPaths();
    const home = await makeIsolatedHome();
    const entry = path.join(home, "checkout", "dist", "cli", "index.js");
    const { deps } = makeCommandDeps({
      paths,
      env: { M365_AGENT_INSTALL_ROOT: home },
      exec: async () => ({ stdout: "v24.21.0" })
    });
    await writeInstallJson(home, {
      version: deps.version,
      installedBy: "source",
      runtime: { path: process.execPath, source: "node" },
      identity: identityFor({ home, platform: deps.platform }),
      clients: [],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    await writeLaunchers({ home, version: deps.version, platform: deps.platform, devEntry: entry });
    const result = await runDoctor(deps);
    expect((result.installConsistency as { aplJsTarget: string }).aplJsTarget).toBe(entry);
  });
});
