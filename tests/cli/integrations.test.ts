/**
 * `m365-agent integrations write|status|remove|snippet` (docs/extension-less-onboarding.md §4.3).
 */
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileFor,
  resolveStandaloneDefinition,
  runIntegrationsRemove,
  runIntegrationsSnippet,
  runIntegrationsStatus,
  runIntegrationsWrite
} from "../../src/cli/commands/integrations.js";
import { vscodeUserDir } from "../../src/services/client-detection.js";
import { mergeCodexConfigToml, mergeVscodeMcpJson } from "../../src/services/integrations.js";
import { makeCommandDeps, makeTempPaths } from "./helpers.js";

async function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "apl-integrations-ws-"));
}

async function makeOsHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "apl-integrations-home-"));
}

describe("integrations write / status", () => {
  it("writes the opt-in vscode-workspace and claude-project files and reports them as managed", async () => {
    const paths = await makeTempPaths();
    const workspace = await makeWorkspace();
    const osHome = await makeOsHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });

    const written = await runIntegrationsWrite(deps, {
      client: "vscode-workspace,claude-project",
      workspace
    });
    expect(written.written).toHaveLength(2);

    const status = await runIntegrationsStatus(deps, {
      client: "vscode-workspace,claude-project,codex",
      workspace
    });
    const byClient = Object.fromEntries(
      (status.clients as Array<{ client: string; status: string }>).map((entry) => [
        entry.client,
        entry.status
      ])
    );
    expect(byClient["vscode-workspace"]).toBe("managed");
    expect(byClient["claude-project"]).toBe("managed");
    expect(byClient.codex).toBe("absent");
  });

  it("classifies a foreign entry and a legacy (pre-marker) entry", async () => {
    const paths = await makeTempPaths();
    const workspace = await makeWorkspace();
    const osHome = await makeOsHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });
    const definition = await resolveStandaloneDefinition(deps);

    await mkdir(path.join(workspace, ".vscode"), { recursive: true });
    await writeFile(
      path.join(workspace, ".vscode", "mcp.json"),
      mergeVscodeMcpJson(undefined, { command: "/usr/bin/some-other-tool", args: ["serve"] }),
      "utf8"
    );
    await writeFile(
      path.join(workspace, ".mcp.json"),
      mergeVscodeMcpJson(undefined, { command: definition.command, args: [...definition.args] }).replace(
        "servers",
        "mcpServers"
      ),
      "utf8"
    );

    const status = await runIntegrationsStatus(deps, {
      client: "vscode-workspace,claude-project",
      workspace
    });
    const byClient = Object.fromEntries(
      (status.clients as Array<{ client: string; status: string }>).map((entry) => [
        entry.client,
        entry.status
      ])
    );
    expect(byClient["vscode-workspace"]).toBe("foreign");
    // No marker, but command/args already match today's identity byte-for-byte.
    expect(byClient["claude-project"]).toBe("legacy");
  });
});

describe("integrations write / status: vscode/vscode-user (§4.4, default)", () => {
  it("creates the VS Code user directory and writes mcp.json when vscode-user is requested on a machine where VS Code has never started (ISSUE-2026-09-14-14)", async () => {
    const paths = await makeTempPaths();
    const workspace = await makeWorkspace();
    const osHome = await makeOsHome();
    const { deps, stdoutLines } = makeCommandDeps({ paths, homedir: () => osHome });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    const containedIn = deps.platform === "win32" ? (deps.env.APPDATA ?? osHome) : osHome;

    const written = await runIntegrationsWrite(deps, { client: "vscode-user", workspace });

    expect(written.written).toEqual([path.join(userDir, "mcp.json")]);
    expect(written.skipped).toEqual([]);
    expect(path.relative(containedIn, userDir).startsWith("..")).toBe(false);
    const entry = JSON.parse(await readFile(path.join(userDir, "mcp.json"), "utf8")).servers["m365-agents"];
    expect(entry.env.M365_AGENT_MANAGED).toBe("1");
    expect(stdoutLines.join("")).toMatch(/user settings folder|ユーザー設定フォルダー/);
  });

  it("writes mcp.json with no cwd once the user directory exists, and vscode is an alias of vscode-user", async () => {
    const paths = await makeTempPaths();
    const workspace = await makeWorkspace();
    const osHome = await makeOsHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    await mkdir(userDir, { recursive: true });

    const written = await runIntegrationsWrite(deps, { client: "vscode", workspace });
    expect(written.written).toEqual([path.join(userDir, "mcp.json")]);
    const entry = JSON.parse(await readFile(path.join(userDir, "mcp.json"), "utf8")).servers["m365-agents"];
    expect(entry.cwd).toBeUndefined();

    const status = await runIntegrationsStatus(deps, { client: "vscode-user", workspace });
    expect((status.clients as Array<{ status: string }>)[0].status).toBe("managed");
  });
});

describe("integrations remove", () => {
  it("refuses a foreign entry without --force, and removes it (with a backup) when forced", async () => {
    const paths = await makeTempPaths();
    const workspace = await makeWorkspace();
    const osHome = await makeOsHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });

    const foreign = mergeVscodeMcpJson(undefined, { command: "/usr/bin/some-other-tool", args: ["serve"] });
    await mkdir(path.join(workspace, ".vscode"), { recursive: true });
    await writeFile(path.join(workspace, ".vscode", "mcp.json"), foreign, "utf8");

    const refused = await runIntegrationsRemove(deps, { client: "vscode-workspace", workspace });
    expect(refused.removed).toEqual([]);
    expect((refused.skipped as string[])[0]).toMatch(/foreign|force/i);
    expect(await readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).toBe(foreign);

    const forced = await runIntegrationsRemove(deps, { client: "vscode-workspace", workspace, force: true });
    expect(forced.removed).toEqual([path.join(workspace, ".vscode", "mcp.json")]);
    const afterJson = JSON.parse(await readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8"));
    expect(afterJson.servers?.["m365-agents"]).toBeUndefined();
    const files = await readdir(path.join(workspace, ".vscode"));
    const backup = files.find((name) => name.endsWith(".apl-backup"));
    expect(backup).toBeTruthy();
    expect(await readFile(path.join(workspace, ".vscode", backup!), "utf8")).toBe(foreign);
  });

  it("removes a managed entry without needing --force", async () => {
    const paths = await makeTempPaths();
    const workspace = await makeWorkspace();
    const osHome = await makeOsHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });
    await runIntegrationsWrite(deps, { client: "vscode-workspace", workspace });

    const result = await runIntegrationsRemove(deps, { client: "vscode-workspace", workspace });

    expect(result.removed).toEqual([path.join(workspace, ".vscode", "mcp.json")]);
  });
});

describe("integrations snippet", () => {
  it("renders a vendor one-liner for codex and claude, and a file entry for vscode/vscode-workspace/claude-project", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeOsHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });

    const snippets = await runIntegrationsSnippet(deps, {
      client: "vscode,vscode-workspace,claude,claude-project,codex"
    });

    expect(snippets.codex).toMatch(/^codex mcp add m365-agents --/);
    // §4.4: the vendor CLI's own blessed form -- the JSON is one argv element -- plus a fallback
    // JSON block (not a single-quoted shell one-liner, which is not valid cmd.exe/PowerShell
    // syntax) for Windows.
    const claudeSnippet = snippets.claude as string;
    expect(claudeSnippet).toMatch(/^claude mcp add-json m365-agents '.*' --scope user/);
    // The one-liner's own JSON argument is compact (no embedded newline); the pretty-printed
    // fallback block is the only thing starting a line with "{".
    const pretty = claudeSnippet.slice(claudeSnippet.indexOf("\n{") + 1);
    expect(JSON.parse(pretty).command).toBeTruthy();
    // vscode/vscode-workspace share the same JSON shape today (neither carries a cwd any more).
    expect(JSON.parse(snippets.vscode as string).servers["m365-agents"]).toBeTruthy();
    expect(JSON.parse(snippets["vscode-workspace"] as string).servers["m365-agents"]).toBeTruthy();
    // claude-project uses Claude Code's own container key, with no vendor-CLI one-liner.
    expect(JSON.parse(snippets["claude-project"] as string).mcpServers["m365-agents"]).toBeTruthy();
  });
});

describe("integrations --home (§P1-9)", () => {
  it("resolves the definition and workspace status from the overridden home, not the platform default", async () => {
    const paths = await makeTempPaths();
    const workspace = await makeWorkspace();
    const osHome = await makeOsHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });
    const overrideHome = await makeOsHome();

    const definition = await resolveStandaloneDefinition(deps, overrideHome);
    expect(definition.command.startsWith(overrideHome)).toBe(true);

    const written = await runIntegrationsWrite(deps, {
      client: "vscode-workspace",
      workspace,
      home: overrideHome
    });
    expect(written.written).toEqual([path.join(workspace, ".vscode", "mcp.json")]);
    const entry = JSON.parse(await readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).servers[
      "m365-agents"
    ];
    expect(entry.command.startsWith(overrideHome)).toBe(true);

    const status = await runIntegrationsStatus(deps, {
      client: "vscode-workspace",
      workspace,
      home: overrideHome
    });
    expect((status.clients as Array<{ status: string }>)[0].status).toBe("managed");
    expect((status.clients as Array<{ file: string }>)[0].file).toBe(
      path.join(workspace, ".vscode", "mcp.json")
    );

    // The default home's definition never matched what was actually written, proving --home (not
    // the platform default) drove the write above.
    const definitionDefaultHome = await resolveStandaloneDefinition(deps);
    expect(definitionDefaultHome.command).not.toBe(entry.command);
  });
});

describe("fileFor", () => {
  const io = { env: {}, platform: process.platform, homedir: () => "/home/me" };

  it("resolves codex to the OS home and the opt-in workspace/project files to the workspace", () => {
    expect(fileFor("codex", io, "/ws")).toBe(path.join("/home/me", ".codex", "config.toml"));
    expect(fileFor("vscode-workspace", io, "/ws")).toBe(path.join("/ws", ".vscode", "mcp.json"));
    expect(fileFor("claude-project", io, "/ws")).toBe(path.join("/ws", ".mcp.json"));
  });

  it("resolves vscode/vscode-user to the VS Code user directory, independent of the workspace", () => {
    const expected = path.join(
      vscodeUserDir({ env: io.env, platform: io.platform, homedir: io.homedir() }),
      "mcp.json"
    );
    expect(fileFor("vscode", io, "/ws")).toBe(expected);
    expect(fileFor("vscode-user", io, "/ws")).toBe(expected);
  });

  it("resolves claude/claude-user to ~/.claude.json, independent of the workspace", () => {
    const expected = path.join("/home/me", ".claude.json");
    expect(fileFor("claude", io, "/ws")).toBe(expected);
    expect(fileFor("claude-user", io, "/ws")).toBe(expected);
  });
});

describe("resolveStandaloneDefinition", () => {
  it("carries the ownership marker and a build stamp derived from the running package version", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeOsHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome, version: "7.7.7" });

    const definition = await resolveStandaloneDefinition(deps);

    expect(definition.env?.M365_AGENT_MANAGED).toBe("1");
    expect(definition.env?.M365_AGENT_BUILD).toBe("7.7.7");
  });
});

// Exercises mergeCodexConfigToml only to keep the "legacy" classification test above honest about
// what a real Codex TOML entry (rather than a JSON stand-in) looks like when read back.
describe("codex TOML sanity", () => {
  it("round-trips through integrationEntryStatus's codex parser", async () => {
    const paths = await makeTempPaths();
    const osHome = await makeOsHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });
    const definition = await resolveStandaloneDefinition(deps);
    await mkdir(path.join(osHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(osHome, ".codex", "config.toml"),
      mergeCodexConfigToml("", { ...definition, startupTimeoutSec: 60, toolTimeoutSec: 900 }),
      "utf8"
    );

    const status = await runIntegrationsStatus(deps, { client: "codex", workspace: osHome });

    expect((status.clients as Array<{ status: string }>)[0].status).toBe("managed");
  });
});

describe("integrations write ownership (§4.7 C6, P1-8)", () => {
  it("refuses a foreign entry, then overwrites it with --force after backing it up", async () => {
    const paths = await makeTempPaths();
    const workspace = await makeWorkspace();
    const osHome = await makeOsHome();
    const { deps } = makeCommandDeps({ paths, homedir: () => osHome });
    const file = path.join(workspace, ".vscode", "mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    const foreign = mergeVscodeMcpJson(undefined, {
      command: "/usr/bin/some-other-tool",
      args: ["--serve-everything"]
    });
    await writeFile(file, foreign, "utf8");

    const refused = await runIntegrationsWrite(deps, { client: "vscode-workspace", workspace });
    expect(refused.written).toEqual([]);
    expect((refused.skipped as string[])[0]).toContain("AgentPickLink did not write");
    expect(await readFile(file, "utf8")).toBe(foreign);

    const forced = await runIntegrationsWrite(deps, { client: "vscode-workspace", workspace, force: true });
    expect(forced.written).toEqual([file]);
    expect(await readFile(`${file}.apl-backup`, "utf8")).toBe(foreign);
    const status = await runIntegrationsStatus(deps, { client: "vscode-workspace", workspace });
    expect((status.clients as Array<{ status: string }>)[0].status).toBe("managed");
  });
});
