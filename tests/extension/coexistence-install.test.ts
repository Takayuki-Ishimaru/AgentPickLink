import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runInstall } from "../../src/cli/commands/install.js";
import { readInstallJson } from "../../src/services/install-home.js";
import { openMachineInstallTerminal } from "../../src/extension/machine-install.js";
import { candidate, createRuntimeHarness, FakeSetupService } from "./harness.js";
import { resetVscodeMock, vscodeMock } from "./vscode-mock.js";
import { makeCommandDeps, makeScriptedPrompter, makeTempPaths } from "../cli/helpers.js";

beforeEach(resetVscodeMock);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "apl-coexist-"));
  const home = path.join(root, "install");
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "extension");
  const archive = path.join(root, "archive");
  for (const pkg of [source, archive]) {
    await mkdir(path.join(pkg, "dist", "cli"), { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "agent-pick-link" }));
    await writeFile(path.join(pkg, "dist", "cli", "index.js"), "// fixture\n");
  }
  await mkdir(path.join(archive, "runtime"));
  await writeFile(path.join(archive, "runtime", "node"), "bundled-node");
  await writeFile(path.join(archive, "runtime", "node.exe"), "bundled-node");
  const node = path.join(root, "source-node");
  await writeFile(node, "path-node");
  await mkdir(workspace);
  const paths = await makeTempPaths();
  const service = new FakeSetupService();
  service.discovery = { candidates: [candidate({ key: "a", assigned: true })], warnings: [] };
  const { deps } = makeCommandDeps({
    paths,
    runtimeExecutable: node,
    root: () => workspace,
    packageRoot: async () => source,
    version: "1.0.0",
    createSetupService: () => service,
    prompter: makeScriptedPrompter({ interactive: true, confirmAnswer: true }),
    exec: async () => ({ stdout: "v24.21.0" }),
    mcpHandshake: async () => ({
      serverName: "agent-pick-link",
      serverVersion: "1.0.0",
      tools: ["m365_agent_ask", "m365_agent_list", "m365_agent_session"],
      instructionsPresent: true,
      stderr: ""
    })
  });
  const options = {
    workspaces: [workspace],
    home,
    yes: true,
    clients: "vscode,claude,codex",
    agents: "a",
    approveAgents: true
  };
  return { deps, options, home, workspace, source, archive, service };
}

describe("VSIX/archive coexistence C2-C4", () => {
  it("VSIX then archive replaces PATH Node with bundled Node", async () => {
    const ctx = await fixture();
    await runInstall(ctx.deps, { ...ctx.options, fromExtension: true });
    expect((await readInstallJson(ctx.home))?.installedBy).toBe("vsix");
    expect(ctx.service.calls).not.toContain("discover");
    await runInstall({ ...ctx.deps, version: "2.0.0", packageRoot: async () => ctx.archive }, ctx.options);
    const installed = (await readInstallJson(ctx.home))!;
    expect(installed.installedBy).toBe("archive");
    expect(installed.runtime.source).toBe("bundled");
    expect(await readFile(installed.runtime.path, "utf8")).toBe("bundled-node");
    expect(installed.version).toBe("2.0.0");
  });
  it("archive then newer VSIX retains the exact bundled Node bytes", async () => {
    const ctx = await fixture();
    await runInstall({ ...ctx.deps, packageRoot: async () => ctx.archive }, ctx.options);
    const before = (await readInstallJson(ctx.home))!;
    const runtime = await readFile(before.runtime.path);
    const codex = await readFile(path.join(ctx.deps.homedir(), ".codex", "config.toml"));
    await runInstall({ ...ctx.deps, version: "2.0.0" }, { ...ctx.options, fromExtension: true });
    const after = (await readInstallJson(ctx.home))!;
    expect(after.runtime.source).toBe("bundled");
    expect(after.version).toBe("2.0.0");
    expect(await readFile(after.runtime.path)).toEqual(runtime);
    expect(await readFile(path.join(ctx.deps.homedir(), ".codex", "config.toml"))).toEqual(codex);
  });
  it("VSIX updates its staged tree and refuses a later implicit downgrade", async () => {
    const ctx = await fixture();
    await runInstall(ctx.deps, { ...ctx.options, fromExtension: true });
    await writeFile(path.join(ctx.source, "dist", "cli", "index.js"), "// updated\n");
    await runInstall({ ...ctx.deps, version: "2.0.0" }, { ...ctx.options, fromExtension: true });
    expect(await readFile(path.join(ctx.home, "app", "2.0.0", "dist", "cli", "index.js"), "utf8")).toBe(
      "// updated\n"
    );
    expect((await readInstallJson(ctx.home))?.installedBy).toBe("vsix");
    await expect(runInstall(ctx.deps, { ...ctx.options, fromExtension: true })).rejects.toMatchObject({
      code: "POLICY_BLOCKED"
    });
  });
  it("does not copy Electron and records its original command plus marker", async () => {
    const ctx = await fixture();
    await runInstall(
      { ...ctx.deps, env: { ...ctx.deps.env, ELECTRON_RUN_AS_NODE: "1" } },
      { ...ctx.options, fromExtension: true }
    );
    const installed = (await readInstallJson(ctx.home))!;
    expect(installed.runtime.source).toBe("electron");
    expect(installed.runtime.path).toBe(ctx.deps.runtimeExecutable);
    expect(installed.identity.command).toBe(ctx.deps.runtimeExecutable);
    await expect(
      access(path.join(ctx.home, "bin", process.platform === "win32" ? "node.exe" : "node"))
    ).rejects.toThrow();
    expect(
      await readFile(path.join(ctx.home, "bin", process.platform === "win32" ? "apl.cmd" : "apl"), "utf8")
    ).toContain("ELECTRON_RUN_AS_NODE=1");
  });
  it("only starts the own-tree installer on explicit action and refuses untrusted workspaces", async () => {
    const harness = await createRuntimeHarness();
    try {
      expect(vscodeMock.terminals).toHaveLength(0);
      await openMachineInstallTerminal(harness.runtime);
      expect(vscodeMock.terminals).toHaveLength(1);
      expect(vscodeMock.terminals[0].shown).toBe(true);
      expect(vscodeMock.terminals[0].options.shellArgs).toEqual([
        path.join(harness.extensionRoot, "dist", "cli", "index.js"),
        "install",
        "--from-extension",
        "--workspace",
        harness.workspaceRoot
      ]);
      vscodeMock.isTrusted = false;
      await expect(openMachineInstallTerminal(harness.runtime)).rejects.toMatchObject({
        code: "WORKSPACE_ROOT_UNAVAILABLE"
      });
      expect(vscodeMock.terminals).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });
});
