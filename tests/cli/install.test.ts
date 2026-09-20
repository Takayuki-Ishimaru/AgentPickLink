/**
 * `m365-agent install` (docs/extension-less-onboarding.md §3.1, WP-B). Every scenario here fakes
 * `createSetupService` (with `FakeSetupService` from tests/extension/harness.ts) and `mcpHandshake`
 * so no real broker or browser is ever touched, and points `packageRoot` at a throwaway directory
 * so `install` never stages the real repository checkout.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as brokerLifecycle from "../../src/broker/broker-lifecycle.js";
import { formatInstallReport, runInstall } from "../../src/cli/commands/install.js";
import { DomainError } from "../../src/domain/errors.js";
import { vscodeUserDir } from "../../src/services/client-detection.js";
import {
  buildStamp,
  identityFor,
  readInstallJson,
  writeInstallJson
} from "../../src/services/install-home.js";
import {
  mergeClaudeMcpJson,
  mergeCodexConfigToml,
  mergeVscodeMcpJson
} from "../../src/services/integrations.js";
import { candidate, FakeSetupService, setupStatus } from "../extension/harness.js";
import { makeCommandDeps, makeFakeBrokerClient, makeScriptedPrompter, makeTempPaths } from "./helpers.js";

/** A process id this machine will not have: high, and immediately probed as absent. Used to stand
 * in for a broker whose process has already exited by the time `stopBroker`'s release wait checks
 * it, so that wait settles immediately instead of polling for its full timeout. */
function deadPid(): number {
  for (let candidate = 999_999; candidate > 100_000; candidate -= 7919) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no dead pid available");
}

function fakePreExistingDescriptor(pid: number) {
  return {
    pid,
    pipeName: "apl-test-pipe",
    protocolMajor: 1,
    protocolMinor: 0,
    packageVersion: "0.0.0-test",
    instanceId: "pre-existing-broker",
    authSecret: "test-secret",
    createdAt: new Date().toISOString()
  };
}

/** Makes `service.ensureSignedIn` throw `error` on its first call only, falling through to the
 * fake's normal behavior afterwards -- for asserting a one-shot restart-and-retry. */
function failFirstSignIn(service: FakeSetupService, error: unknown): { attempts: () => number } {
  let attempts = 0;
  const original = service.ensureSignedIn.bind(service);
  service.ensureSignedIn = ((opts: Parameters<FakeSetupService["ensureSignedIn"]>[0]) => {
    attempts++;
    if (attempts === 1) return Promise.reject(error);
    return original(opts);
  }) as FakeSetupService["ensureSignedIn"];
  return { attempts: () => attempts };
}

async function makePackageRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "apl-pkgroot-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "agent-pick-link" }), "utf8");
  return root;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "apl-install-ws-"));
}

/** A stable content-hash of every file under `root`, so a test can assert "nothing changed". */
async function hashTree(root: string): Promise<string> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else {
        const content = await readFile(full).catch(() => Buffer.alloc(0));
        entries.push(
          `${path.relative(root, full)}:${content.length}:${createHash("sha256").update(content).digest("hex")}`
        );
      }
    }
  }
  await walk(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const okHandshake = async () => ({
  serverName: "agent-pick-link",
  serverVersion: "1.2.3",
  tools: ["m365_agent_ask", "m365_agent_list", "m365_agent_session"],
  instructionsPresent: true,
  stderr: ""
});

const failingHandshake = async () => {
  throw new Error("no server responded");
};

function fakeService(): FakeSetupService {
  const service = new FakeSetupService();
  service.discovery = {
    candidates: [candidate({ key: "agent-requirements", displayName: "Requirements Agent", assigned: true })],
    warnings: []
  };
  return service;
}

describe("install --dry-run", () => {
  it("prints the plan and writes nothing under home or the workspace", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const beforeHome = await hashTree(home);
    const beforeWorkspace = await hashTree(workspace);
    const report = await runInstall(deps, {
      workspaces: [workspace],
      dryRun: true,
      yes: true,
      clients: "vscode,claude"
    });

    expect(report.exitCode).toBe(0);
    expect(report.dryRun).toBe(true);
    expect(await hashTree(home)).toBe(beforeHome);
    expect(await hashTree(workspace)).toBe(beforeWorkspace);
  });
});

describe("install confirmation", () => {
  it("writes nothing and exits 1 when the plan is not confirmed", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      prompter: makeScriptedPrompter({ interactive: true, confirmAnswer: false }),
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const beforeHome = await hashTree(home);
    const report = await runInstall(deps, { workspaces: [workspace], home, clients: "vscode" });

    expect(report.exitCode).toBe(1);
    expect(report.confirmed).toBe(false);
    expect(await hashTree(home)).toBe(beforeHome);
  });
});

describe("install staging failure", () => {
  it("reports exit code 1 without touching the workspace when staging fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => path.join(home, "does-not-exist"),
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const beforeWorkspace = await hashTree(workspace);
    const report = await runInstall(deps, { workspaces: [workspace], yes: true, home, clients: "vscode" });

    expect(report.exitCode).toBe(1);
    expect(report.verifyError).toBeTruthy();
    expect(await hashTree(workspace)).toBe(beforeWorkspace);
  });
});

describe("install --agents", () => {
  it("fails with an unknown alias without writing any client file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    await expect(
      runInstall(deps, {
        workspaces: [workspace],
        yes: true,
        home,
        clients: "vscode",
        agents: "no-such-agent"
      })
    ).rejects.toThrow(/Unknown agent/);
    await expect(readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).rejects.toThrow();
  });
});

describe("install happy path", () => {
  it("stages the package, writes .vscode/mcp.json and .mcp.json with the stable identity, marker and stamp, and reports exit 0", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const version = "9.9.9-test";
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      version,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace,claude-project",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    expect(report.verified).toBe(true);
    expect(report.version).toBe(version);

    // Staging actually happened.
    expect((await stat(path.join(home, "app", version))).isDirectory()).toBe(true);
    expect((await stat(path.join(home, "bin", "apl.js"))).isFile()).toBe(true);
    const installJson = JSON.parse(await readFile(path.join(home, "install.json"), "utf8"));
    expect(installJson.version).toBe(version);
    expect(installJson.workspaces).toContain(workspace);
    expect(installJson.clients.sort()).toEqual(["claude-project", "vscode-workspace"]);

    const identity = identityFor({ home, platform: deps.platform });
    const vscodeEntry = JSON.parse(await readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8"));
    const server = vscodeEntry.servers["m365-agents"];
    expect(server.command).toBe(identity.command);
    expect(server.args).toEqual(identity.args);
    expect(server.env.M365_AGENT_MANAGED).toBe("1");
    expect(server.env.M365_AGENT_BUILD).toBe(version);

    const claudeEntry = JSON.parse(await readFile(path.join(workspace, ".mcp.json"), "utf8"));
    expect(claudeEntry.mcpServers["m365-agents"].command).toBe(identity.command);

    const clientReport = report.clients.find((client) => client.id === "vscode");
    expect(clientReport?.files).toContain(path.join(workspace, ".vscode", "mcp.json"));
    const codexReport = report.clients.find((client) => client.id === "codex");
    expect(codexReport?.selected).toBe(false);
    expect(codexReport?.files).toEqual([]);
  });

  it("reports exit code 2 when nothing is verified to be written for any client (--clients none)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "none",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(2);
    expect(report.verified).toBe(true);
    await expect(readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).rejects.toThrow();
  });

  it("reports exit code 3 when the MCP handshake fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: failingHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(3);
    expect(report.verified).toBe(false);
    expect(report.verifyError).toBeTruthy();
    // Client files are still written -- verification is a separate, later step.
    await expect(readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).resolves.toBeTruthy();
  });
});

describe("install --clients auto (default, §4.4)", () => {
  it("writes only the default user-scope files, leaving .vscode/mcp.json and .mcp.json untouched", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "apl-install-userhome-"));
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      homedir: () => fakeHome,
      // No claude on PATH here: "auto" still detects claude (its presence check also matches
      // `~/.claude.json`/`~/.claude/` alone, seeded below). The VS Code user directory is
      // pre-created below too, but only so "auto" *detects* vscode via the "user data dir present"
      // evidence (client-detection.ts) -- the writer itself no longer requires it to pre-exist
      // (ISSUE-2026-09-14-14: see the dedicated "install --clients vscode-user" tests below for the
      // absent-directory case).
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    await mkdir(userDir, { recursive: true });
    // detectClients' claude check also matches `~/.claude.json`/`~/.claude/` alone -- create one so
    // "auto" selects claudeUser here without needing a real `claude` on PATH.
    await mkdir(path.join(fakeHome, ".claude"), { recursive: true });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      agents: "agent-requirements"
      // clients omitted entirely: exercises the real "auto" default.
    });

    expect(report.exitCode).toBe(0);
    expect(report.vscodeUser?.written).toEqual([path.join(userDir, "mcp.json")]);
    expect(report.claudeUser?.written).toEqual([path.join(fakeHome, ".claude.json")]);
    await expect(readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(workspace, ".mcp.json"), "utf8")).rejects.toThrow();
    const installJson = JSON.parse(await readFile(path.join(home, "install.json"), "utf8"));
    expect(installJson.clients.sort()).toEqual(["claude-user", "vscode-user"]);
  });
});

describe("install --clients claude/claude-user via the vendor CLI (§4.4)", () => {
  it("passes the JSON as one argv element through the injected exec, end to end", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "apl-install-userhome-"));
    const claudeDir = await mkdtemp(path.join(os.tmpdir(), "apl-fake-claude-"));
    await writeFile(path.join(claudeDir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const execCalls: string[][] = [];
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      homedir: () => fakeHome,
      env: { PATH: claudeDir },
      exec: async (_command, args) => {
        execCalls.push(args);
        return { stdout: "" };
      },
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "claude",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    expect(report.claudeUser?.written).toEqual([path.join(fakeHome, ".claude.json")]);
    const addCall = execCalls.find((args) => args[0] === "mcp" && args[1] === "add-json");
    expect(addCall?.[2]).toBe("m365-agents");
    expect(() => JSON.parse(addCall![3])).not.toThrow();
    expect(addCall?.slice(4)).toEqual(["--scope", "user"]);
    expect(execCalls).toContainEqual(["mcp", "get", "m365-agents"]);
    // The vendor CLI handled the write end to end -- the direct-file fallback never ran.
    await expect(readFile(path.join(fakeHome, ".claude.json"), "utf8")).rejects.toThrow();
  });
});

describe("install §4.3 item 4: migrates away an unselected workspace/project file", () => {
  it("removes a managed .vscode/mcp.json entry when vscode-workspace is not selected, and leaves a foreign .mcp.json entry", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    // A managed entry from a previous run that defaulted to the workspace file.
    await mkdir(path.join(workspace, ".vscode"), { recursive: true });
    await writeFile(
      path.join(workspace, ".vscode", "mcp.json"),
      mergeVscodeMcpJson(undefined, { command: "/old/node", args: ["/old/home/bin/apl.js", "serve"] }),
      "utf8"
    );
    // A hand-written (foreign) .mcp.json entry that must never be touched.
    const foreignClaude = mergeClaudeMcpJson(undefined, {
      command: "/usr/bin/some-other-tool",
      args: ["--serve-everything"]
    });
    await writeFile(path.join(workspace, ".mcp.json"), foreignClaude, "utf8");

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "none",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(2);
    const vscodeAfter = JSON.parse(await readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8"));
    expect(vscodeAfter.servers?.["m365-agents"]).toBeUndefined();
    expect(await readFile(path.join(workspace, ".mcp.json"), "utf8")).toBe(foreignClaude);
    expect(report.migrations).toContainEqual({
      workspace,
      file: path.join(workspace, ".vscode", "mcp.json")
    });
    expect(report.migrations.some((entry) => entry.file === path.join(workspace, ".mcp.json"))).toBe(false);
  });

  it("previews the same removal under --dry-run without changing anything", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    await mkdir(path.join(workspace, ".vscode"), { recursive: true });
    const original = mergeVscodeMcpJson(undefined, {
      command: "/old/node",
      args: ["/old/home/bin/apl.js", "serve"]
    });
    await writeFile(path.join(workspace, ".vscode", "mcp.json"), original, "utf8");

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      dryRun: true,
      home,
      clients: "none"
    });

    expect(report.dryRun).toBe(true);
    expect(report.migrations).toContainEqual({
      workspace,
      file: path.join(workspace, ".vscode", "mcp.json")
    });
    expect(await readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).toBe(original);
  });
});

describe("install --clients vscode-user (§4.4)", () => {
  // ISSUE-2026-09-14-14 (docs/validation-log-2026-09-14-windows-round5.md): an absent
  // `%APPDATA%\Code\User` used to make the writer skip even when vscode-user was explicitly
  // selected -- a first VS Code run, or one this OS user account never opened, means the folder
  // simply never existed yet. `install` must now create it itself (see the `vscodeUserDirNeedsCreate`
  // write site in src/cli/commands/install.ts) so VS Code picks the file up on its next start.
  it("creates the VS Code user directory and writes mcp.json when explicitly selected but the directory does not exist", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    // A throwaway $HOME: the real developer machine running this test may already have a VS Code
    // user directory, which would otherwise make this "does not exist" scenario flaky.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "apl-install-userhome-"));
    const { deps, stdoutLines } = makeCommandDeps({
      paths,
      root: () => workspace,
      homedir: () => fakeHome,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    await expect(stat(userDir)).rejects.toThrow();

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-user",
      agents: "agent-requirements"
    });

    expect(report.vscodeUser?.written).toEqual([path.join(userDir, "mcp.json")]);
    expect(report.vscodeUser?.skipped ?? []).toEqual([]);
    expect(report.exitCode).toBe(0);
    // The directory now exists, current-user-default permissions -- and stays strictly under the
    // injected fake home, never touching the real machine's own VS Code profile.
    expect((await stat(userDir)).isDirectory()).toBe(true);
    expect(userDir.startsWith(fakeHome)).toBe(true);
    const entry = JSON.parse(await readFile(path.join(userDir, "mcp.json"), "utf8")).servers["m365-agents"];
    expect(entry.env.M365_AGENT_MANAGED).toBe("1");
    expect(stdoutLines.some((line) => line.includes("Created VS Code's user settings folder"))).toBe(true);
  });

  it("writes via auto-detection when VS Code's own executable is found on PATH but the user directory does not exist", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "apl-install-userhome-"));
    // Stands in for VS Code's own executable being on PATH (`code on PATH` evidence in
    // client-detection.ts's detectVscode) -- never the circular "user data dir present" evidence,
    // which cannot fire here since the directory is absent by construction.
    const codeDir = await mkdtemp(path.join(os.tmpdir(), "apl-fake-code-"));
    await writeFile(path.join(codeDir, "code"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // win32's PATH lookup is PATHEXT-driven (client-detection.ts's commandOnPath), so an
    // extension-less file is never found there; VS Code itself ships `code.cmd`.
    await writeFile(path.join(codeDir, "code.cmd"), "@echo off\r\nexit /b 0\r\n");
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      homedir: () => fakeHome,
      env: { PATH: codeDir },
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    await expect(stat(userDir)).rejects.toThrow();

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      // clients omitted entirely: exercises the real "auto" default, which selects vscode-user
      // exactly when detectClients() finds it installed and no policy blocks it.
      agents: "agent-requirements"
    });

    expect(report.vscodeUser?.written).toEqual([path.join(userDir, "mcp.json")]);
    expect((await stat(userDir)).isDirectory()).toBe(true);
  });

  it("skips with a reason, and never creates the directory, when VS Code is neither selected nor detected", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "apl-install-userhome-"));
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      homedir: () => fakeHome,
      // No `code` on PATH, no VS Code user directory, no macOS .app -- nothing for auto-detection
      // to find, and vscode is not named in --clients either.
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "codex",
      agents: "agent-requirements"
    });

    expect(report.vscodeUser).toBeUndefined();
    await expect(stat(userDir)).rejects.toThrow();
  });

  it("writes mcp.json with no cwd once the user directory exists", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    // A throwaway $HOME so this never touches the real developer machine's VS Code profile.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "apl-install-userhome-"));
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      homedir: () => fakeHome,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    await mkdir(userDir, { recursive: true });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-user",
      agents: "agent-requirements"
    });

    expect(report.vscodeUser?.written).toEqual([path.join(userDir, "mcp.json")]);
    expect(report.exitCode).toBe(0);
    const entry = JSON.parse(await readFile(path.join(userDir, "mcp.json"), "utf8")).servers["m365-agents"];
    expect(entry.cwd).toBeUndefined();
    expect(entry.env.M365_AGENT_MANAGED).toBe("1");
    const installJson = JSON.parse(await readFile(path.join(home, "install.json"), "utf8"));
    expect(installJson.clients).toContain("vscode-user");
  });

  it("writes the single per-machine file once even with multiple workspaces, and no restriction applies", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const first = await makeWorkspace();
    const second = await makeWorkspace();
    const paths = await makeTempPaths();
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "apl-install-userhome-"));
    const { deps } = makeCommandDeps({
      paths,
      root: () => first,
      homedir: () => fakeHome,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    await mkdir(userDir, { recursive: true });

    const report = await runInstall(deps, {
      workspaces: [first, second],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-user",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    expect(report.vscodeUser?.written).toEqual([path.join(userDir, "mcp.json")]);
    // No `cwd` binds the file to either workspace -- VS Code resolves the workspace itself.
    const entry = JSON.parse(await readFile(path.join(userDir, "mcp.json"), "utf8")).servers["m365-agents"];
    expect(entry.cwd).toBeUndefined();
  });
});

describe("install §4.7 C6/C7: legacy migration and foreign entries", () => {
  it("converges a legacy-managed entry in a previously recorded workspace that is not named on this run", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const otherWorkspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const version = "9.9.9-test";
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      version,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const identity = identityFor({ home, platform: deps.platform });
    // Pre-seed install.json as if `otherWorkspace` was already set up by a previous run, and write
    // a legacy (pre-marker) entry for it -- the shape a 0.1.x extension would have written.
    await writeInstallJson(home, {
      version: "9.9.8",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: ["claude"],
      workspaces: [otherWorkspace],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    await writeFile(
      path.join(otherWorkspace, ".mcp.json"),
      mergeClaudeMcpJson(undefined, {
        command: "/old/node",
        args: ["/old/extension/dist/cli/index.js", "serve"]
      }),
      "utf8"
    );

    await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "claude",
      agents: "agent-requirements"
    });

    const migrated = JSON.parse(await readFile(path.join(otherWorkspace, ".mcp.json"), "utf8"));
    const newIdentity = identityFor({ home, platform: deps.platform });
    expect(migrated.mcpServers["m365-agents"].command).toBe(newIdentity.command);
    expect(migrated.mcpServers["m365-agents"].env.M365_AGENT_MANAGED).toBe("1");
  });

  it("leaves a hand-written (foreign) entry in a previously recorded workspace byte-identical", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const otherWorkspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      // §4.7 C4: this run has to be an *upgrade* over the recorded 9.9.8, or the downgrade guard
      // refuses it before any migration pass runs.
      version: "9.9.9",
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const identity = identityFor({ home, platform: deps.platform });
    await writeInstallJson(home, {
      version: "9.9.8",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: ["claude"],
      workspaces: [otherWorkspace],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    const foreign = mergeClaudeMcpJson(undefined, { command: "/usr/bin/some-other-tool", args: ["serve"] });
    await writeFile(path.join(otherWorkspace, ".mcp.json"), foreign, "utf8");

    await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "claude",
      agents: "agent-requirements"
    });

    expect(await readFile(path.join(otherWorkspace, ".mcp.json"), "utf8")).toBe(foreign);
  });
});

describe("install --dev (§4.7 C2)", () => {
  it("registers the checkout as the machine install without staging a copy into app/", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const version = "9.9.9-dev";
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      version,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      dev: true,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    expect(report.runtime.source).toBe("node");

    // No app/<version> directory was staged at all.
    await expect(stat(path.join(home, "app", version))).rejects.toThrow();
    // bin/node is still a real, spawnable copy (a host that only knows <home>/bin/node still works).
    expect(
      (await stat(path.join(home, "bin", deps.platform === "win32" ? "node.exe" : "node"))).isFile()
    ).toBe(true);

    const aplJs = await readFile(path.join(home, "bin", "apl.js"), "utf8");
    expect(aplJs).toContain(JSON.stringify(path.join(packageRoot, "dist", "cli", "index.js")));

    const installJson = JSON.parse(await readFile(path.join(home, "install.json"), "utf8"));
    expect(installJson.installedBy).toBe("source");
    // install.json records the *original* running binary, not the <home>/bin/node copy.
    expect(installJson.runtime.path).toBe(process.execPath);
    expect(installJson.runtime.source).toBe("node");
    // The identity written to client files is still the stable <home>/bin/node + apl.js serve --
    // only what bin/apl.js imports internally changed.
    const identity = identityFor({ home, platform: deps.platform });
    expect(installJson.identity).toEqual(identity);
    const vscodeEntry = JSON.parse(await readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8"));
    expect(vscodeEntry.servers["m365-agents"].command).toBe(identity.command);
  });
});

function actionsPossibleCandidate(key: string, displayName: string) {
  return candidate({
    key,
    displayName,
    assigned: true,
    registered: {
      alias: `${key}-alias`,
      verified: true,
      enabled: true,
      kind: "m365-agent-builder",
      capabilityClass: "actions-possible"
    }
  });
}

describe("install P0-1: capability class preserved on re-run", () => {
  it("keeps a registered actions-possible agent's capability class across a non-interactive re-run", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = new FakeSetupService();
    service.discovery = { candidates: [actionsPossibleCandidate("agent-hr", "HR Agent")], warnings: [] };
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      allowActionsPossible: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-hr"
    });

    expect(report.exitCode).toBe(0);
    expect(service.appliedPlans).toHaveLength(1);
    expect(service.appliedPlans[0].agents[0].capabilityClass).toBe("actions-possible");
  });
});

describe("install P0-2: a Save failure is visible", () => {
  it("a service whose apply() throws is reported on the workspace (exit 3), and .m365-agents.json is not listed", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = fakeService();
    service.applyError = new Error("apply exploded");
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(3);
    const workspaceReport = report.workspaces.find((entry) => entry.root === workspace);
    expect(workspaceReport?.error).toBeTruthy();
    expect(workspaceReport?.files).toEqual([]);
    await expect(readFile(path.join(workspace, ".m365-agents.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).rejects.toThrow();
  });
});

describe("install P0-3: consent rule (§3.1)", () => {
  it("--yes alone does not confirm the agent-roster approval", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps, stderrLines } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      home,
      clients: "vscode",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(3);
    const workspaceReport = report.workspaces.find((entry) => entry.root === workspace);
    expect(workspaceReport?.error).toBeTruthy();
    expect(workspaceReport?.files).toEqual([]);
    expect(stderrLines.some((line) => line.includes("--approve-agents"))).toBe(true);
    await expect(readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).rejects.toThrow();
  });

  it("--yes --approve-agents confirms the agent-roster approval", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    const workspaceReport = report.workspaces.find((entry) => entry.root === workspace);
    expect(workspaceReport?.error).toBeUndefined();
    await expect(readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).resolves.toBeTruthy();
  });

  it("drops an actions-possible candidate and names it, without --allow-actions-possible", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = new FakeSetupService();
    service.discovery = { candidates: [actionsPossibleCandidate("agent-hr", "HR Agent")], warnings: [] };
    const { deps, stderrLines } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode",
      agents: "agent-hr"
    });

    // Dropped before the widening consent would even be needed -- no error, nothing to approve.
    expect(service.appliedPlans).toEqual([]);
    const workspaceReport = report.workspaces.find((entry) => entry.root === workspace);
    expect(workspaceReport?.error).toBeUndefined();
    expect(workspaceReport?.agentsRegistered).toBe(0);
    expect(stderrLines.some((line) => line.includes("HR Agent"))).toBe(true);
  });
});

describe("install WP-D: partial discovery notice", () => {
  it("carries partial/failedCount from a partial discovery into the workspace report and its text/JSON rendering", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = fakeService();
    service.discovery = { ...service.discovery, partial: true, failedCount: 2 };
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    const workspaceReport = report.workspaces.find((entry) => entry.root === workspace);
    expect(workspaceReport?.partial).toBe(true);
    expect(workspaceReport?.failedCount).toBe(2);

    // --json: the field survives a plain JSON.stringify of the report (no separate shaping step).
    expect(JSON.parse(JSON.stringify(report)).workspaces[0].partial).toBe(true);
    expect(JSON.parse(JSON.stringify(report)).workspaces[0].failedCount).toBe(2);

    // Text report: one extra line naming the count, metadata only (no agent names).
    const text = formatInstallReport(report, "en");
    expect(text).toContain("Some candidates could not be retrieved (2). Re-running discovery may find more.");
    const textJa = formatInstallReport(report, "ja");
    expect(textJa).toContain("一部の候補を取得できませんでした（2 件）。再実行すると増えることがあります。");
  });

  it("leaves partial/failedCount unset for a clean discovery", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    const workspaceReport = report.workspaces.find((entry) => entry.root === workspace);
    expect(workspaceReport?.partial).toBeUndefined();
    expect(workspaceReport?.failedCount).toBeUndefined();
    expect(formatInstallReport(report, "en")).not.toContain("could not be retrieved");
  });
});

describe("install P1-4: no-argument upgrade reuses recorded workspaces", () => {
  it("re-stamps every recorded workspace's client files, leaving ~/.codex/config.toml byte-identical", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspaceA = await makeWorkspace();
    const workspaceB = await makeWorkspace();
    const paths = await makeTempPaths();
    const osHome = await mkdtemp(path.join(os.tmpdir(), "apl-install-userhome-"));
    const oldVersion = "1.0.0";
    const newVersion = "2.0.0";
    const commonDeps = {
      paths,
      root: () => workspaceA,
      homedir: () => osHome,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    };
    const { deps: depsV1 } = makeCommandDeps({ ...commonDeps, version: oldVersion });
    const { deps: depsV2 } = makeCommandDeps({ ...commonDeps, version: newVersion });

    // First install, at the old version, recording both workspaces.
    await runInstall(depsV1, {
      workspaces: [workspaceA, workspaceB],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace,codex",
      agents: "agent-requirements"
    });
    const codexBefore = await readFile(path.join(osHome, ".codex", "config.toml"), "utf8");
    const stampBefore = JSON.parse(await readFile(path.join(workspaceB, ".vscode", "mcp.json"), "utf8"))
      .servers["m365-agents"].env.M365_AGENT_BUILD;
    expect(stampBefore).toBe(oldVersion);

    // The upgrade: a newer running version, no workspace arguments at all.
    const report = await runInstall(depsV2, {
      workspaces: [],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace,codex",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    expect(report.workspaces.map((entry) => entry.root).sort()).toEqual([workspaceA, workspaceB].sort());
    const stampA = JSON.parse(await readFile(path.join(workspaceA, ".vscode", "mcp.json"), "utf8")).servers[
      "m365-agents"
    ].env.M365_AGENT_BUILD;
    const stampB = JSON.parse(await readFile(path.join(workspaceB, ".vscode", "mcp.json"), "utf8")).servers[
      "m365-agents"
    ].env.M365_AGENT_BUILD;
    expect(stampA).toBe(newVersion);
    expect(stampB).toBe(newVersion);
    const codexAfter = await readFile(path.join(osHome, ".codex", "config.toml"), "utf8");
    expect(codexAfter).toBe(codexBefore);
  });
});

describe("install P1-6: partial staging", () => {
  it("rolls back a half-installed version and reports exit 3 when an older version remains", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const version = "2.0.0";
    // A previous, working version already staged.
    await mkdir(path.join(home, "app", "1.0.0", "dist", "cli"), { recursive: true });
    await writeFile(path.join(home, "app", "1.0.0", "dist", "cli", "index.js"), "// v1", "utf8");
    await mkdir(path.join(home, "bin"), { recursive: true });
    await writeFile(path.join(home, "bin", "apl.js"), "// launcher\n", "utf8");

    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      version,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    // Force a deterministic failure *after* stageVersion has already copied app/2.0.0 into place
    // (installRuntime/writeLaunchers always succeed here -- process.execPath is a real binary and
    // <home>/bin is freshly created): pre-create install.json as a directory, so writeInstallJson's
    // atomicWrite -- a rename onto that path -- fails with EISDIR.
    await mkdir(path.join(home, "install.json"), { recursive: true });

    const report = await runInstall(deps, { workspaces: [workspace], yes: true, home, clients: "vscode" });

    expect(report.exitCode).toBe(3);
    expect(report.verifyError).toMatch(/partial install left/);
    // The half-installed new version was rolled back...
    await expect(stat(path.join(home, "app", version))).rejects.toThrow();
    // ...but the previously working version is untouched.
    expect((await stat(path.join(home, "app", "1.0.0", "dist", "cli", "index.js"))).isFile()).toBe(true);
  });

  it("reports exit 1 when nothing at all is left after rollback", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    // Nothing staged before this run. Force ensurePrivateDirectories' own `mkdir(bin, {recursive})`
    // to fail, before stageVersion/installRuntime/writeLaunchers ever run, so nothing but the
    // rolled-back app/<version> could possibly be left behind. A plain file sitting at `bin` fails
    // that mkdir with ENOTDIR/EEXIST identically on POSIX and Windows; a directory pre-created at
    // `bin/node(.exe)` (the original approach here) does not portably force a failure -- on win32,
    // installRuntime's rename-aside-then-swap dance for a running broker's open `node.exe` (see
    // installRuntime in src/services/install-home.ts) simply moves that directory out of the way
    // and succeeds, so the intended failure never happens there.
    await writeFile(path.join(home, "bin"), "not a directory", "utf8");

    const report = await runInstall(deps, { workspaces: [workspace], yes: true, home, clients: "vscode" });

    expect(report.exitCode).toBe(1);
    await expect(stat(path.join(home, "app", deps.version))).rejects.toThrow();
    await expect(stat(path.join(home, "bin", "apl.js"))).rejects.toThrow();
  });
});

describe("install P1-12: <home> is current-user-only", () => {
  it("creates <home>, <home>/bin and <home>/app with mode 0700 on POSIX", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    for (const dir of [home, path.join(home, "bin"), path.join(home, "app")])
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});

describe("install P2: verify requires exactly the three tools", () => {
  it("fails verification when the handshake reports an unexpected extra tool", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: async () => ({
        serverName: "agent-pick-link",
        serverVersion: "1.2.3",
        tools: ["m365_agent_ask", "m365_agent_list", "m365_agent_session", "unexpected_tool"],
        instructionsPresent: true,
        stderr: ""
      })
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.verified).toBe(false);
    expect(report.exitCode).toBe(3);
  });
});

describe("install P2: the plan step reports a missing browser under --dry-run", () => {
  it("prints the ensureBrowserChannel failure to stderr even though --dry-run writes nothing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = fakeService();
    service.ensureBrowserChannel = async () => {
      throw new Error("The configured browser is not installed and no supported alternative was found.");
    };
    const { deps, stderrLines } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, { workspaces: [workspace], yes: true, dryRun: true, home });

    expect(report.dryRun).toBe(true);
    expect(stderrLines.some((line) => line.includes("not installed"))).toBe(true);
  });
});

describe("install P2: verify uses the identity's own env plus a curated passthrough", () => {
  it("never forwards an arbitrary process.env variable to the verify handshake", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      env: { PATH: "/usr/bin", M365_AGENT_SOME_UNRELATED_TEST_VAR: "leak-me-not" },
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: async (options) => {
        capturedEnv = options.env;
        return okHandshake();
      }
    });

    await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(capturedEnv?.M365_AGENT_MANAGED).toBe("1");
    expect(capturedEnv?.PATH).toBe("/usr/bin");
    expect(capturedEnv?.M365_AGENT_SOME_UNRELATED_TEST_VAR).toBeUndefined();
  });
});

/* --------------------------------------------------------- §4.7 C14 re-stamping (P1-4) */

describe("install §4.7 C14: re-stamping a recorded workspace on upgrade", () => {
  it("re-stamps M365_AGENT_BUILD in a recorded-but-unnamed workspace, leaving Codex byte-identical", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const osHome = await mkdtemp(path.join(os.tmpdir(), "apl-install-oshome-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const recorded = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      homedir: () => osHome,
      version: "2.0.0",
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    // The identity never changes across versions (§3.2), so `M365_AGENT_BUILD` is the only launch
    // field an upgrade touches -- and the only thing VS Code hashes to notice the server is
    // outdated (§4.7 C14).
    const identity = identityFor({ home, platform: deps.platform });
    const previous = {
      ...identity,
      env: { M365_AGENT_MANAGED: "1", M365_AGENT_BUILD: buildStamp("1.0.0") }
    };
    await writeInstallJson(home, {
      version: "1.0.0",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: ["vscode", "claude", "codex"],
      workspaces: [recorded],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    await mkdir(path.join(recorded, ".vscode"), { recursive: true });
    await writeFile(
      path.join(recorded, ".vscode", "mcp.json"),
      mergeVscodeMcpJson(undefined, previous),
      "utf8"
    );
    await writeFile(path.join(recorded, ".mcp.json"), mergeClaudeMcpJson(undefined, previous), "utf8");
    // Codex spawns the server per session and therefore never carries the stamp: its file must come
    // out of the upgrade byte-identical, not rewritten on every run.
    const codexFile = path.join(osHome, ".codex", "config.toml");
    await mkdir(path.dirname(codexFile), { recursive: true });
    const codexBefore = mergeCodexConfigToml("", {
      ...identity,
      env: { M365_AGENT_MANAGED: "1" },
      startupTimeoutSec: 60,
      toolTimeoutSec: 900
    });
    await writeFile(codexFile, codexBefore, "utf8");

    await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "claude",
      agents: "agent-requirements"
    });

    const vscodeEntry = JSON.parse(await readFile(path.join(recorded, ".vscode", "mcp.json"), "utf8")) as {
      servers: { "m365-agents": { command: string; env: Record<string, string> } };
    };
    const claudeEntry = JSON.parse(await readFile(path.join(recorded, ".mcp.json"), "utf8")) as {
      mcpServers: { "m365-agents": { command: string; env: Record<string, string> } };
    };
    expect(vscodeEntry.servers["m365-agents"].env.M365_AGENT_BUILD).toBe("2.0.0");
    expect(vscodeEntry.servers["m365-agents"].command).toBe(identity.command);
    expect(claudeEntry.mcpServers["m365-agents"].env.M365_AGENT_BUILD).toBe("2.0.0");
    expect(await readFile(codexFile, "utf8")).toBe(codexBefore);
  });
});

/* ------------------------------------------------------------ §4.7 C4 downgrade guard (P1-6) */

describe("install §4.7 C4: downgrade guard", () => {
  async function seedNewerInstall(home: string, platform: NodeJS.Platform): Promise<void> {
    const identity = identityFor({ home, platform });
    await writeInstallJson(home, {
      version: "2.0.0",
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: [],
      workspaces: [],
      platform,
      updatedAt: new Date().toISOString()
    });
  }

  it("refuses to install an older package over a newer machine install, naming self use and --force", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      version: "1.0.0",
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    await seedNewerInstall(home, deps.platform);
    const before = await hashTree(home);

    await expect(
      runInstall(deps, { workspaces: [workspace], yes: true, approveAgents: true, home, clients: "none" })
    ).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      message: expect.stringContaining("2.0.0"),
      // The two ways out, named in the remediation the CLI prints under the message.
      options: { remediation: expect.stringMatching(/self use[\s\S]*--force/) }
    });

    // Refused before anything was staged, printed or asked.
    expect(await hashTree(home)).toBe(before);
  });

  it("proceeds with --force, and the machine install becomes the older version", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      version: "1.0.0",
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    await seedNewerInstall(home, deps.platform);

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      force: true,
      home,
      clients: "none",
      agents: "agent-requirements"
    });

    expect(report.confirmed).toBe(true);
    expect((await readInstallJson(home))?.version).toBe("1.0.0");
  });
});

/* --------------------------------------------------- §P1-5: nodeVersion for a bundled runtime */

describe("install records the bundled runtime's version", () => {
  it("probes <home>/bin/node once, through the injected exec, and records what it reports", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    // A "bundled" runtime is simply a `runtime/node` next to package.json; its bytes are never run
    // here, which is exactly why the version has to come from an injected probe.
    await mkdir(path.join(packageRoot, "runtime"), { recursive: true });
    const runtimeBinary = path.join(
      packageRoot,
      "runtime",
      process.platform === "win32" ? "node.exe" : "node"
    );
    await writeFile(runtimeBinary, "#!/bin/sh\n", { mode: 0o755 });
    const execCalls: Array<{ command: string; args: string[] }> = [];
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      version: "1.0.0",
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake,
      exec: async (command, args) => {
        execCalls.push({ command, args });
        return { stdout: "v24.4.1\n" };
      }
    });

    await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "none",
      agents: "agent-requirements"
    });

    const installJson = await readInstallJson(home);
    expect(installJson?.runtime.source).toBe("bundled");
    expect(installJson?.runtime.nodeVersion).toBe("24.4.1");
    const identity = identityFor({ home, platform: deps.platform });
    expect(execCalls.filter((call) => call.command === identity.command)).toEqual([
      { command: identity.command, args: ["--version"] }
    ]);
  });

  it("records no nodeVersion rather than failing when the bundled runtime will not answer", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    await mkdir(path.join(packageRoot, "runtime"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "runtime", process.platform === "win32" ? "node.exe" : "node"),
      "#!/bin/sh\n",
      { mode: 0o755 }
    );
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      version: "1.0.0",
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake,
      exec: async () => ({ stdout: "not a version at all" })
    });

    await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "none",
      agents: "agent-requirements"
    });

    const installJson = await readInstallJson(home);
    expect(installJson?.runtime.source).toBe("bundled");
    expect(installJson?.runtime.nodeVersion).toBeUndefined();
  });
});

describe("install final refinements", () => {
  it("fails verification when doctor fails even when all MCP tools are present", async () => {
    const paths = await makeTempPaths();
    const workspace = await makeWorkspace();
    const { deps } = makeCommandDeps({
      paths,
      packageRoot: makePackageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake,
      diagnose: async () => ({ ok: false, findings: ["profile"] })
    });
    const result = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      agents: "agent-requirements",
      approveAgents: true,
      clients: "vscode-workspace"
    });
    expect(result.exitCode).toBe(3);
    expect(result.verified).toBe(false);
    expect(result.doctor).toEqual([{ workspace, ok: false, findings: ["profile"] }]);
  });
  it("discovers once and saves independently in both workspaces", async () => {
    const paths = await makeTempPaths();
    const first = await makeWorkspace();
    const second = await makeWorkspace();
    const services = new Map([
      [first, fakeService()],
      [second, fakeService()]
    ]);
    const { deps } = makeCommandDeps({
      paths,
      packageRoot: makePackageRoot,
      createSetupService: (_deps, root) => services.get(root())!,
      mcpHandshake: okHandshake
    });
    const result = await runInstall(deps, {
      workspaces: [first, second],
      yes: true,
      agents: "agent-requirements",
      approveAgents: true,
      clients: "vscode-workspace"
    });
    expect(result.exitCode).toBe(0);
    expect(services.get(first)!.calls.filter((call) => call === "discover")).toHaveLength(1);
    expect(services.get(second)!.calls).not.toContain("discover");
    expect(services.get(first)!.appliedPlans).toHaveLength(1);
    expect(services.get(second)!.appliedPlans).toHaveLength(1);
    expect(result.workspaces.map((item) => item.root)).toEqual([first, second]);
    expect(result.doctor?.every((item) => item.ok)).toBe(true);
  });
  // §4.4: with no `cwd`, the single per-machine vscode-user file works for any number of
  // workspaces -- there is no longer a restriction to reject here.
  it("no longer restricts vscode-user to a single workspace", async () => {
    const paths = await makeTempPaths();
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "apl-install-userhome-"));
    const { deps } = makeCommandDeps({
      paths,
      homedir: () => fakeHome,
      packageRoot: makePackageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    await mkdir(userDir, { recursive: true });

    const result = await runInstall(deps, {
      workspaces: [await makeWorkspace(), await makeWorkspace()],
      clients: "vscode-user",
      yes: true,
      approveAgents: true,
      agents: "agent-requirements"
    });

    expect(result.exitCode).toBe(0);
    expect(result.vscodeUser?.written).toEqual([path.join(userDir, "mcp.json")]);
  });
});

describe("install ISSUE-03: staging/verification failure reason in the text report", () => {
  it("a fake service throwing at sign-in reports the code on the workspace, and the text report shows it (--json shape unchanged)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = new FakeSetupService();
    // Force `runSetup()`'s interactive sign-in path (skipped when already "authenticated"), then
    // fail it -- the same shape a real `BROWSER_START_FAILED` from browser-manager.ts carries
    // (an explicit English `remediation`, no localized one in localize.ts's dictionary).
    service.status_ = setupStatus({
      broker: { live: true, authState: { state: "unauthenticated" }, incidents: [] }
    });
    service.signInError = new DomainError(
      "BROWSER_START_FAILED",
      "The msedge browser did not start: spawn ENOENT",
      true,
      { remediation: "Install Microsoft Edge, then run the setup again." }
    );
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(3);
    const workspaceReport = report.workspaces.find((entry) => entry.root === workspace);
    // The real cause is reported directly -- never masked by selectAgents()'s own "unknown agent
    // alias"/"no interactive terminal" (discovery never produced a single candidate here).
    expect(workspaceReport?.errorCode).toBe("BROWSER_START_FAILED");
    expect(workspaceReport?.error).toContain("did not start");
    await expect(readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).rejects.toThrow();

    const text = formatInstallReport(report, "en");
    expect(text).toContain("Failed: BROWSER_START_FAILED");
    expect(text).toContain("Install Microsoft Edge, then run the setup again.");
    const textJa = formatInstallReport(report, "ja");
    expect(textJa).toContain("失敗: BROWSER_START_FAILED");

    // --json shape unchanged: the pre-existing `error` string field is still populated exactly as
    // before this fix -- `errorCode`/`errorRemediation` are additive, nothing was renamed/removed.
    const jsonWorkspace = JSON.parse(JSON.stringify(report)).workspaces[0];
    expect(jsonWorkspace.error).toBe(workspaceReport?.error);
    expect(jsonWorkspace.errorCode).toBe("BROWSER_START_FAILED");
  });

  it("shows the code + remediation for a staging failure (exit code 1)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => path.join(home, "does-not-exist"),
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, { workspaces: [workspace], yes: true, home, clients: "vscode" });

    expect(report.exitCode).toBe(1);
    expect(report.verifyError).toBeTruthy();
    // No DomainError behind a plain ENOENT-style staging failure -- the text report still shows the
    // message (previously it showed nothing for `verifyError` at all).
    expect(report.verifyErrorCode).toBeUndefined();
    const text = formatInstallReport(report, "en");
    expect(text).toContain(`Failed: ${report.verifyError}`);
  });

  it("--agents against an empty (but successfully completed) discovery says so in the remediation", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = new FakeSetupService();
    service.discovery = { candidates: [], warnings: [] };
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake
    });

    let caught: unknown;
    try {
      await runInstall(deps, {
        workspaces: [workspace],
        yes: true,
        home,
        clients: "vscode",
        agents: "no-such-agent"
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("AGENT_NOT_FOUND");
    expect((caught as DomainError).message).toContain("Unknown agent");
    expect((caught as InstanceType<typeof DomainError>).options.remediation).toContain("0 candidates");
  });
});

describe("install: restart-and-retry against a pre-existing broker (docs/validation-log-2026-09-14-windows-round2.md R4)", () => {
  const startFailed = () =>
    new DomainError("BROWSER_START_FAILED", "The msedge browser did not start: spawn ENOENT", true, {
      remediation: "Run: m365-agent broker restart"
    });

  it("restarts a broker that predates this run once and retries, succeeding the second time", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = fakeService();
    service.status_ = setupStatus({
      broker: { live: true, authState: { state: "unauthenticated" }, incidents: [] }
    });
    const signIn = failFirstSignIn(service, startFailed());
    const brokerClient = makeFakeBrokerClient();
    const { deps, stdoutLines } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake,
      readDescriptor: async () => fakePreExistingDescriptor(deadPid()),
      connectExistingBroker: async () => brokerClient as never
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    // 1 (fails, retried) + 1 (the retry, succeeds) + 1 (controller.save()'s own unrelated
    // post-save silent check, per SaveSummary.connected's doc comment) = 3.
    expect(signIn.attempts()).toBe(3);
    expect(brokerClient.calls.map((call) => call.method)).toContain("broker.shutdown");
    // Sent through notify(), never the metadata-only log() -- a normal (non --json) run shows it.
    expect(stdoutLines.some((line) => line.includes("Restarting the previous broker and retrying"))).toBe(
      true
    );
  });

  it("waits for the old broker's browser tree to be gone (docs/validation-log-2026-09-14-windows-round4.md U2) before the retry, and logs it ahead of the restart notice", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = fakeService();
    service.status_ = setupStatus({
      broker: { live: true, authState: { state: "unauthenticated" }, incidents: [] }
    });
    const signIn = failFirstSignIn(service, startFailed());
    const brokerClient = makeFakeBrokerClient();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake,
      readDescriptor: async () => fakePreExistingDescriptor(deadPid()),
      connectExistingBroker: async () => brokerClient as never
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    expect(signIn.attempts()).toBe(3);
    const logText = await readFile(path.join(paths.logs, "cli.log"), "utf8");
    // No real process on this machine names this test's temporary profile directory, so the wait
    // resolves on its very first check -- proof the retry path actually calls it (item 3), not just
    // that stopBroker's own internal wait (item 1) ran.
    const treeGoneIndex = logText.indexOf("broker: browser tree for profile gone after");
    const noticeIndex = logText.indexOf("notice: Restarting the previous broker and retrying");
    expect(treeGoneIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeGreaterThan(treeGoneIndex);
  });

  it("reports BROWSER_START_FAILED as today when the retry also fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = fakeService();
    service.status_ = setupStatus({
      broker: { live: true, authState: { state: "unauthenticated" }, incidents: [] }
    });
    service.signInError = startFailed();
    const brokerClient = makeFakeBrokerClient();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake,
      readDescriptor: async () => fakePreExistingDescriptor(deadPid()),
      connectExistingBroker: async () => brokerClient as never
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(3);
    const workspaceReport = report.workspaces.find((entry) => entry.root === workspace);
    expect(workspaceReport?.errorCode).toBe("BROWSER_START_FAILED");
    // Exactly one restart attempt: shutdown was requested exactly once, not retried forever.
    expect(brokerClient.calls.filter((call) => call.method === "broker.shutdown")).toHaveLength(1);
  });

  it("never restarts a broker this same run just spawned", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = fakeService();
    service.status_ = setupStatus({
      broker: { live: true, authState: { state: "unauthenticated" }, incidents: [] }
    });
    service.signInError = startFailed();
    const brokerClient = makeFakeBrokerClient();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake,
      // No descriptor existed before this `install` connected -- readDescriptor() reports "no
      // broker" the one time it is asked, up front, before anything else runs.
      readDescriptor: async () => undefined,
      connectExistingBroker: async () => brokerClient as never
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(3);
    expect(brokerClient.calls).toHaveLength(0);
  });
});

describe("install ISSUE-09: TerminalSetupHost.log() is persisted, and --verbose echoes it (docs/validation-log-2026-09-14-windows.md)", () => {
  it("appends log() lines to the app-data log file without echoing them by default", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps, stderrLines } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    const logText = await readFile(path.join(paths.logs, "cli.log"), "utf8");
    expect(logText).toContain("setup: started");
    expect(logText).toContain("setup: finished");
    // Never echoed without --verbose -- the phase/progress/error lines already printed are the
    // whole of a normal run's output.
    expect(stderrLines.some((line) => line.includes("[log]"))).toBe(false);
  });

  it("--verbose also echoes log() lines to stderr, prefixed [log]", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps, stderrLines } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements",
      verbose: true
    });

    expect(report.exitCode).toBe(0);
    expect(stderrLines.some((line) => line.includes("[log] setup: started"))).toBe(true);
    // Still persisted to the log file even under --verbose -- verbose only adds the echo.
    const logText = await readFile(path.join(paths.logs, "cli.log"), "utf8");
    expect(logText).toContain("setup: started");
  });
});

describe("install ISSUE-10: notify() is also persisted to cli.log (docs/validation-log-2026-09-14-windows-round3.md S2)", () => {
  it("persists the restart-and-retry notice to cli.log, prefixed notice:, not only stdout", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const service = fakeService();
    service.status_ = setupStatus({
      broker: { live: true, authState: { state: "unauthenticated" }, incidents: [] }
    });
    const startFailed = () =>
      new DomainError("BROWSER_START_FAILED", "The msedge browser did not start: spawn ENOENT", true, {
        remediation: "Run: m365-agent broker restart"
      });
    const signIn = failFirstSignIn(service, startFailed());
    const brokerClient = makeFakeBrokerClient();
    const { deps, stdoutLines } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => service,
      mcpHandshake: okHandshake,
      readDescriptor: async () => fakePreExistingDescriptor(deadPid()),
      connectExistingBroker: async () => brokerClient as never
    });

    const report = await runInstall(deps, {
      workspaces: [workspace],
      yes: true,
      approveAgents: true,
      home,
      clients: "vscode-workspace",
      agents: "agent-requirements"
    });

    expect(report.exitCode).toBe(0);
    expect(signIn.attempts()).toBe(3);
    // ISSUE-10: previously only stdout carried this line -- appendCliLog() never ran for notify().
    expect(stdoutLines.some((line) => line.includes("Restarting the previous broker and retrying"))).toBe(
      true
    );
    const logText = await readFile(path.join(paths.logs, "cli.log"), "utf8");
    expect(logText).toContain("notice: Restarting the previous broker and retrying");
  });
});

describe("install ISSUE-11: every broker this run spawns targets the staged install, not this process's own tree (docs/validation-log-2026-09-14-windows-round3.md S2)", () => {
  it("sets the broker spawn target to <home>/app/<version>/dist/broker/process.js and <home>/bin/node right after staging", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    const spy = vi.spyOn(brokerLifecycle, "setBrokerSpawnTarget");
    try {
      const report = await runInstall(deps, {
        workspaces: [workspace],
        yes: true,
        approveAgents: true,
        home,
        clients: "vscode-workspace",
        agents: "agent-requirements"
      });

      expect(report.exitCode).toBe(0);
      expect(spy).toHaveBeenCalledWith({
        entry: path.join(home, "app", deps.version, "dist", "broker", "process.js"),
        node: path.join(home, "bin", deps.platform === "win32" ? "node.exe" : "node")
      });
    } finally {
      spy.mockRestore();
      brokerLifecycle.setBrokerSpawnTarget(undefined);
    }
  });

  it("does not override the spawn target for --dev, whose default already resolves to this same checkout", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
    const packageRoot = await makePackageRoot();
    const workspace = await makeWorkspace();
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({
      paths,
      root: () => workspace,
      packageRoot: async () => packageRoot,
      createSetupService: () => fakeService(),
      mcpHandshake: okHandshake
    });
    const spy = vi.spyOn(brokerLifecycle, "setBrokerSpawnTarget");
    try {
      const report = await runInstall(deps, {
        workspaces: [workspace],
        yes: true,
        approveAgents: true,
        home,
        clients: "vscode-workspace",
        agents: "agent-requirements",
        dev: true
      });

      expect(report.exitCode).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      brokerLifecycle.setBrokerSpawnTarget(undefined);
    }
  });
});
