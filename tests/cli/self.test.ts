/**
 * `m365-agent self status|use <version>|prune|uninstall [--purge-data]`
 * (docs/extension-less-onboarding.md §3.2, §4.7 C10).
 */
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSelfPrune, runSelfStatus, runSelfUninstall, runSelfUse } from "../../src/cli/commands/self.js";
import { vscodeUserDir } from "../../src/services/client-detection.js";
import { identityFor, writeInstallJson } from "../../src/services/install-home.js";
import {
  mergeClaudeMcpJson,
  mergeClaudeUserMcpJson,
  mergeCodexConfigToml,
  mergeVscodeMcpJson,
  mergeVscodeUserMcpJson
} from "../../src/services/integrations.js";
import { makeCommandDeps, makeScriptedPrompter, makeTempPaths } from "./helpers.js";

/** A real, executable (but never actually spawned -- `deps.exec` is always injected) `claude` file
 * on a throwaway PATH, so `isClaudeCliOnPath` reports true without touching the real machine's
 * PATH or spawning anything. win32 needs no equivalent here: none of these tests run there. */
async function makeFakeClaudeOnPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "apl-fake-claude-"));
  await writeFile(path.join(dir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

async function makeHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "apl-self-home-"));
}

async function stageVersionDir(home: string, version: string): Promise<void> {
  await mkdir(path.join(home, "app", version, "dist", "broker"), { recursive: true });
  await writeFile(path.join(home, "app", version, "dist", "broker", "process.js"), "// stub\n", "utf8");
}

/** A `bin/node` (or `bin/node.exe`) that `self status` can run its real `--version` probe
 * against. `runSelfStatus` spawns `identity.command` directly (never through the injected
 * `deps.exec`), so this has to be something the OS can actually execute: a `#!/bin/sh` script
 * works on POSIX, but on Windows a `.exe`-named file has to be a real PE image -- batch-script
 * content written there fails to launch ("not a valid Win32 application"), not merely to
 * report the version. Copying `process.execPath` (the real Node running this test) works on
 * every platform, the same trick tests/cli/doctor.test.ts uses for the same reason; the
 * caller then asserts against `process.version` instead of a fixture string. */
async function writeFakeRuntime(home: string, platform: NodeJS.Platform): Promise<void> {
  await mkdir(path.join(home, "bin"), { recursive: true });
  const name = platform === "win32" ? "node.exe" : "node";
  const target = path.join(home, "bin", name);
  if (platform === "win32") {
    await copyFile(process.execPath, target);
  } else {
    await writeFile(target, `#!/bin/sh\necho "${process.version}"\n`, { encoding: "utf8", mode: 0o755 });
  }
}

describe("self status", () => {
  it("reports install.json, staged versions, the current identity and the runtime version", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({ paths });
    await stageVersionDir(home, "1.0.0");
    await stageVersionDir(home, "2.0.0");
    const identity = identityFor({ home, platform: deps.platform });
    await writeInstallJson(home, {
      version: "2.0.0",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: ["vscode"],
      workspaces: ["/tmp/some-workspace"],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    await writeFakeRuntime(home, deps.platform);

    const result = await runSelfStatus(deps, { home });

    expect(result.installed).toBe(true);
    expect((result.versions as string[]).sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(result.runtimeVersion).toBe(process.version);
    expect((result.install as { version: string }).version).toBe("2.0.0");
  });

  it("reports installed: false with no install.json under an empty home", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({ paths });

    const result = await runSelfStatus(deps, { home });

    expect(result.installed).toBe(false);
    expect(result.versions).toEqual([]);
  });
});

describe("self use", () => {
  it("re-points bin/apl.js at the requested (already staged) version and updates install.json", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({ paths });
    await stageVersionDir(home, "1.0.0");
    await stageVersionDir(home, "2.0.0");
    const identity = identityFor({ home, platform: deps.platform });
    await writeInstallJson(home, {
      version: "2.0.0",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: [],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });

    const result = await runSelfUse(deps, "1.0.0", { home });

    expect(result.switched).toBe(true);
    const aplJs = await readFile(path.join(home, "bin", "apl.js"), "utf8");
    expect(aplJs).toContain('"app", "1.0.0", "dist", "cli", "index.js"');
    const installJson = JSON.parse(await readFile(path.join(home, "install.json"), "utf8"));
    expect(installJson.version).toBe("1.0.0");
  });

  it("refuses to switch to a version that was never staged", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({ paths });

    await expect(runSelfUse(deps, "9.9.9", { home })).rejects.toThrow(/not installed/);
  });
});

describe("self prune", () => {
  it("removes every staged version except the one install.json currently points at", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({ paths });
    await stageVersionDir(home, "1.0.0");
    await stageVersionDir(home, "2.0.0");
    const identity = identityFor({ home, platform: deps.platform });
    await writeInstallJson(home, {
      version: "2.0.0",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: [],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });

    const result = await runSelfPrune(deps, { home, yes: true });

    expect(result.removed).toEqual(["1.0.0"]);
    await expect(
      readFile(path.join(home, "app", "1.0.0", "dist", "broker", "process.js"), "utf8")
    ).rejects.toThrow();
    await expect(
      readFile(path.join(home, "app", "2.0.0", "dist", "broker", "process.js"), "utf8")
    ).resolves.toBeTruthy();
  });

  it("keeps the version the bin/current-version sidecar names, even when install.json disagrees (§P1-7)", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({ paths });
    await stageVersionDir(home, "1.0.0");
    await stageVersionDir(home, "2.0.0");
    const identity = identityFor({ home, platform: deps.platform });
    // install.json still says "1.0.0" -- stale relative to what bin/apl.js was last pointed at.
    await writeInstallJson(home, {
      version: "1.0.0",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: [],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    await mkdir(path.join(home, "bin"), { recursive: true });
    await writeFile(path.join(home, "bin", "current-version"), "2.0.0\n", "utf8");

    const result = await runSelfPrune(deps, { home, yes: true });

    expect(result.removed).toEqual(["1.0.0"]);
    expect(result.kept).toBe("2.0.0");
    await expect(
      readFile(path.join(home, "app", "2.0.0", "dist", "broker", "process.js"), "utf8")
    ).resolves.toBeTruthy();
    await expect(
      readFile(path.join(home, "app", "1.0.0", "dist", "broker", "process.js"), "utf8")
    ).rejects.toThrow();
  });
});

describe("self uninstall", () => {
  it("removes managed client entries, bin/, app/ and install.json, but leaves a foreign entry byte-identical and never touches app data without --purge-data", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const osHome = await mkdtemp(path.join(os.tmpdir(), "apl-self-oshome-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-self-ws-"));
    const { deps } = makeCommandDeps({
      paths,
      homedir: () => osHome,
      prompter: makeScriptedPrompter({ interactive: true, confirmAnswer: true })
    });
    await stageVersionDir(home, "1.0.0");
    const identity = identityFor({ home, platform: deps.platform });
    await writeInstallJson(home, {
      version: "1.0.0",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: ["vscode", "claude", "codex"],
      workspaces: [workspace],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });

    // A managed entry (our own identity, ownership marker set) in every one of this workspace's files.
    const managedDefinition = {
      command: identity.command,
      args: identity.args,
      env: { M365_AGENT_MANAGED: "1" }
    };
    await mkdir(path.join(workspace, ".vscode"), { recursive: true });
    await writeFile(
      path.join(workspace, ".vscode", "mcp.json"),
      mergeVscodeMcpJson(undefined, managedDefinition),
      "utf8"
    );
    await writeFile(
      path.join(workspace, ".mcp.json"),
      mergeClaudeMcpJson(undefined, managedDefinition),
      "utf8"
    );
    // A foreign Codex entry: no ownership marker, and not one of AgentPickLink's own shapes.
    await mkdir(path.join(osHome, ".codex"), { recursive: true });
    const foreignCodex = mergeCodexConfigToml("", {
      command: "/usr/bin/some-other-tool",
      args: ["serve"],
      startupTimeoutSec: 10,
      toolTimeoutSec: 10
    });
    await writeFile(path.join(osHome, ".codex", "config.toml"), foreignCodex, "utf8");

    const result = await runSelfUninstall(deps, { home });

    expect(result.uninstalled).toBe(true);
    expect(result.purged).toBe(false);
    expect(result.removedIntegrations).toEqual(
      expect.arrayContaining([path.join(workspace, ".vscode", "mcp.json"), path.join(workspace, ".mcp.json")])
    );

    // The managed entries are gone, but the files themselves (and any other content) remain.
    const vscodeAfter = JSON.parse(await readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8"));
    expect(vscodeAfter.servers?.["m365-agents"]).toBeUndefined();
    const claudeAfter = JSON.parse(await readFile(path.join(workspace, ".mcp.json"), "utf8"));
    expect(claudeAfter.mcpServers?.["m365-agents"]).toBeUndefined();

    // The foreign Codex entry is left completely untouched (no --force was given).
    expect(await readFile(path.join(osHome, ".codex", "config.toml"), "utf8")).toBe(foreignCodex);

    // The machine install itself is gone; app data (paths.root) is untouched (no --purge-data).
    await expect(readFile(path.join(home, "install.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(home, "bin", "apl.js"), "utf8")).rejects.toThrow();
  });

  it("removes the vscodeUser entry from the VS Code user-profile mcp.json", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const osHome = await mkdtemp(path.join(os.tmpdir(), "apl-self-oshome-"));
    const { deps } = makeCommandDeps({
      paths,
      homedir: () => osHome,
      prompter: makeScriptedPrompter({ interactive: true, confirmAnswer: true })
    });
    await stageVersionDir(home, "1.0.0");
    const identity = identityFor({ home, platform: deps.platform });
    await writeInstallJson(home, {
      version: "1.0.0",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: ["vscode-user"],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    await mkdir(userDir, { recursive: true });
    const managedDefinition = {
      command: identity.command,
      args: identity.args,
      env: { M365_AGENT_MANAGED: "1" }
    };
    const userFile = path.join(userDir, "mcp.json");
    await writeFile(userFile, mergeVscodeUserMcpJson(undefined, managedDefinition), "utf8");

    const result = await runSelfUninstall(deps, { home });

    expect(result.removedIntegrations).toContain(userFile);
    const after = JSON.parse(await readFile(userFile, "utf8"));
    expect(after.servers?.["m365-agents"]).toBeUndefined();
  });

  it("removes the claudeUser entry via the injected `claude mcp remove` exec when the vendor CLI is on PATH", async () => {
    if (process.platform === "win32") return;
    const home = await makeHome();
    const paths = await makeTempPaths();
    const osHome = await mkdtemp(path.join(os.tmpdir(), "apl-self-oshome-"));
    const claudeDir = await makeFakeClaudeOnPath();
    const execCalls: string[][] = [];
    const { deps } = makeCommandDeps({
      paths,
      homedir: () => osHome,
      env: { PATH: claudeDir },
      exec: async (_command, args) => {
        execCalls.push(args);
        return { stdout: "" };
      },
      prompter: makeScriptedPrompter({ interactive: true, confirmAnswer: true })
    });
    await stageVersionDir(home, "1.0.0");
    const identity = identityFor({ home, platform: deps.platform });
    await writeInstallJson(home, {
      version: "1.0.0",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: ["claude-user"],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    const managedDefinition = {
      command: identity.command,
      args: identity.args,
      env: { M365_AGENT_MANAGED: "1" }
    };
    const claudeJsonFile = path.join(osHome, ".claude.json");
    await writeFile(claudeJsonFile, mergeClaudeUserMcpJson(undefined, managedDefinition), "utf8");

    const result = await runSelfUninstall(deps, { home });

    expect(result.removedIntegrations).toContain(claudeJsonFile);
    expect(execCalls).toContainEqual(["mcp", "remove", "m365-agents", "--scope", "user"]);
  });

  it("also removes the app-data root when --purge-data is given and confirmed", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const osHome = await mkdtemp(path.join(os.tmpdir(), "apl-self-oshome-"));
    const { deps } = makeCommandDeps({
      paths,
      homedir: () => osHome,
      prompter: makeScriptedPrompter({ interactive: true, confirmAnswer: true })
    });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.registry, "version: 1\nagents: []\n", "utf8");

    const result = await runSelfUninstall(deps, { home, purgeData: true });

    expect(result.purged).toBe(true);
    await expect(readFile(paths.registry, "utf8")).rejects.toThrow();
  });
});

describe("self prune confirmation", () => {
  it("retains old versions when confirmation is declined", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const prompter = makeScriptedPrompter({ interactive: true, confirmAnswer: false });
    const { deps } = makeCommandDeps({ paths, prompter });
    for (const version of ["1.0.0", "2.0.0"]) await stageVersionDir(home, version);
    await writeInstallJson(home, {
      version: "2.0.0",
      installedBy: "archive",
      runtime: { path: process.execPath, source: "node" },
      identity: identityFor({ home, platform: deps.platform }),
      clients: [],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    const result = await runSelfPrune(deps, { home });
    expect(result.confirmed).toBe(false);
    expect(result.removed).toEqual([]);
    expect(prompter.confirmCalls[0]).toContain("1.0.0");
    expect(await readFile(path.join(home, "app", "1.0.0", "dist", "broker", "process.js"), "utf8")).toBe(
      "// stub\n"
    );
  });
});

describe("self use build stamp", () => {
  it("restamps recorded workspace files while keeping Codex byte-identical", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-self-restamp-"));
    const { deps } = makeCommandDeps({ paths });
    for (const version of ["1.0.0", "2.0.0"]) await stageVersionDir(home, version);
    const identity = identityFor({ home, platform: deps.platform });
    await writeInstallJson(home, {
      version: "2.0.0",
      installedBy: "archive",
      runtime: { path: process.execPath, source: "node" },
      identity,
      clients: ["vscode", "codex"],
      workspaces: [workspace],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    await mkdir(path.join(workspace, ".vscode"));
    const definition = { ...identity, env: { M365_AGENT_MANAGED: "1", M365_AGENT_BUILD: "2.0.0+old" } };
    const file = path.join(workspace, ".vscode", "mcp.json");
    await writeFile(file, mergeVscodeMcpJson(undefined, definition));
    await mkdir(path.join(deps.homedir(), ".codex"), { recursive: true });
    const codexPath = path.join(deps.homedir(), ".codex", "config.toml");
    const codex = mergeCodexConfigToml("", { ...definition, startupTimeoutSec: 30, toolTimeoutSec: 300 });
    await writeFile(codexPath, codex);
    await runSelfUse(deps, "1.0.0", { home });
    expect(JSON.parse(await readFile(file, "utf8")).servers["m365-agents"].env.M365_AGENT_BUILD).toBe(
      "1.0.0"
    );
    expect(await readFile(codexPath, "utf8")).toBe(codex);
  });

  it("also restamps the vscodeUser entry, once, independent of any workspace", async () => {
    const home = await makeHome();
    const paths = await makeTempPaths();
    const osHome = await mkdtemp(path.join(os.tmpdir(), "apl-self-restamp-user-"));
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });
    for (const version of ["1.0.0", "2.0.0"]) await stageVersionDir(home, version);
    const identity = identityFor({ home, platform: deps.platform });
    await writeInstallJson(home, {
      version: "2.0.0",
      installedBy: "archive",
      runtime: { path: process.execPath, source: "node" },
      identity,
      clients: ["vscode-user"],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    await mkdir(userDir, { recursive: true });
    const definition = { ...identity, env: { M365_AGENT_MANAGED: "1", M365_AGENT_BUILD: "2.0.0+old" } };
    const userFile = path.join(userDir, "mcp.json");
    await writeFile(userFile, mergeVscodeUserMcpJson(undefined, definition), "utf8");

    await runSelfUse(deps, "1.0.0", { home });

    const after = JSON.parse(await readFile(userFile, "utf8"));
    expect(after.servers["m365-agents"].env.M365_AGENT_BUILD).toBe("1.0.0");
    expect(after.servers["m365-agents"].cwd).toBeUndefined();
  });
});
