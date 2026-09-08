import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyIntegrations,
  integrationNeedsRefresh,
  mergeClaudeMcpJson,
  mergeCodexConfigToml,
  mergeVscodeMcpJson,
  refreshStaleIntegrations
} from "../../src/extension/integrations.js";

const block = {
  command: "/usr/local/bin/node",
  args: ["/ext/dist/cli/index.js", "serve"],
  startupTimeoutSec: 60,
  toolTimeoutSec: 600
};

describe("mergeCodexConfigToml", () => {
  it("appends the block to an empty file", () => {
    expect(mergeCodexConfigToml("", block)).toBe(
      [
        "[mcp_servers.m365-agents]",
        'command = "/usr/local/bin/node"',
        'args = ["/ext/dist/cli/index.js", "serve"]',
        "startup_timeout_sec = 60",
        "tool_timeout_sec = 600",
        ""
      ].join("\n")
    );
  });

  it("keeps every other byte of the file when appending", () => {
    const existing = '# my config\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const merged = mergeCodexConfigToml(existing, block);
    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).toContain("[mcp_servers.m365-agents]");
  });

  it("replaces an existing block and its env sub-table in place", () => {
    const existing = [
      "# leading comment",
      "",
      "[mcp_servers.m365-agents]",
      'command = "stale"',
      'args = ["stale"]',
      "",
      "[mcp_servers.m365-agents.env]",
      'STALE = "1"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      ""
    ].join("\n");
    const merged = mergeCodexConfigToml(existing, { ...block, env: { M365_AGENT_DEV_APP_URL: "http://x" } });
    expect(merged).toContain("# leading comment");
    expect(merged).toContain("[mcp_servers.other]");
    expect(merged).not.toContain("stale");
    expect(merged).not.toContain("STALE");
    expect(merged).toContain("[mcp_servers.m365-agents.env]");
    expect(merged).toContain('M365_AGENT_DEV_APP_URL = "http://x"');
    // The other table survives verbatim, including its trailing newline.
    expect(merged.endsWith('[mcp_servers.other]\ncommand = "other"\n')).toBe(true);
  });

  it("is idempotent", () => {
    const once = mergeCodexConfigToml('model = "gpt-5"\n', block);
    expect(mergeCodexConfigToml(once, block)).toBe(once);
  });

  it("escapes Windows paths as TOML basic strings", () => {
    const merged = mergeCodexConfigToml("", {
      ...block,
      command: "C:\\Program Files\\nodejs\\node.exe"
    });
    expect(merged).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
  });

  it("preserves CRLF line endings", () => {
    const merged = mergeCodexConfigToml('model = "gpt-5"\r\n', block);
    expect(merged.startsWith('model = "gpt-5"\r\n')).toBe(true);
    expect(merged).toContain("[mcp_servers.m365-agents]\r\n");
    expect(merged).not.toMatch(/[^\r]\n/);
  });
});

describe("mergeClaudeMcpJson", () => {
  it("creates the document when the file is missing", () => {
    expect(JSON.parse(mergeClaudeMcpJson(undefined, block))).toEqual({
      mcpServers: { "m365-agents": { command: block.command, args: block.args } }
    });
  });

  it("preserves unrelated keys and servers", () => {
    const existing = JSON.stringify({ other: 1, mcpServers: { keep: { command: "keep" } } });
    const merged = JSON.parse(mergeClaudeMcpJson(existing, { ...block, env: { A: "b" } }));
    expect(merged.other).toBe(1);
    expect(merged.mcpServers.keep).toEqual({ command: "keep" });
    expect(merged.mcpServers["m365-agents"].env).toEqual({ A: "b" });
  });

  it("refuses JSON with comments rather than destroying them", () => {
    expect(() => mergeClaudeMcpJson("// hi\n{}", block)).toThrow(/not plain JSON/);
  });
});

describe("mergeVscodeMcpJson", () => {
  it("writes a stdio server under servers", () => {
    const merged = JSON.parse(mergeVscodeMcpJson('{"inputs":[]}', block));
    expect(merged.inputs).toEqual([]);
    expect(merged.servers["m365-agents"]).toEqual({
      type: "stdio",
      command: block.command,
      args: block.args
    });
  });
});

describe("applyIntegrations", () => {
  it("writes only the enabled targets", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-home-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-ws-"));
    const summary = await applyIntegrations(
      { definition: block, homeDirectory: home, workspaceRoot: workspace },
      { codex: true, claudeCode: false, vscodeMcpJson: true }
    );
    expect(summary.skipped).toEqual([]);
    expect(summary.written.sort()).toEqual(
      [path.join(home, ".codex", "config.toml"), path.join(workspace, ".vscode", "mcp.json")].sort()
    );
    expect(await readFile(path.join(home, ".codex", "config.toml"), "utf8")).toContain(
      "[mcp_servers.m365-agents]"
    );
    await expect(readFile(path.join(workspace, ".mcp.json"), "utf8")).rejects.toThrow();
  });

  it("reports a workspace integration as skipped when no folder is open", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-home-"));
    const summary = await applyIntegrations(
      { definition: block, homeDirectory: home },
      { codex: false, claudeCode: true, vscodeMcpJson: true }
    );
    expect(summary.written).toEqual([]);
    expect(summary.skipped).toHaveLength(2);
  });

  it("reports an unparseable file as skipped and leaves it untouched", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-home-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-ws-"));
    await mkdir(path.join(workspace, ".vscode"), { recursive: true });
    const target = path.join(workspace, ".vscode", "mcp.json");
    await writeFile(target, "// comment\n{}\n", "utf8");
    const summary = await applyIntegrations(
      { definition: block, homeDirectory: home, workspaceRoot: workspace },
      { codex: false, claudeCode: false, vscodeMcpJson: true }
    );
    expect(summary.written).toEqual([]);
    expect(summary.skipped[0]).toContain("not plain JSON");
    expect(await readFile(target, "utf8")).toBe("// comment\n{}\n");
  });
});

describe("integrationNeedsRefresh", () => {
  describe("codex (TOML)", () => {
    const current = mergeCodexConfigToml("", block);

    it("is false when the stored command/args already match", () => {
      expect(integrationNeedsRefresh(current, block, "codex")).toBe(false);
    });

    it("is true when the stored command differs (extension moved / Node runtime changed)", () => {
      const stale = mergeCodexConfigToml("", { ...block, command: "/old/path/to/node" });
      expect(integrationNeedsRefresh(stale, block, "codex")).toBe(true);
    });

    it("is true when the stored args differ", () => {
      const stale = mergeCodexConfigToml("", { ...block, args: ["/old/dist/cli/index.js", "serve"] });
      expect(integrationNeedsRefresh(stale, block, "codex")).toBe(true);
    });

    it("is false when there is no m365-agents table at all", () => {
      expect(integrationNeedsRefresh('model = "gpt-5"\n', block, "codex")).toBe(false);
    });
  });

  describe("claudeCode / vscodeMcpJson (JSON)", () => {
    it("is false when the stored entry already matches", () => {
      const current = mergeClaudeMcpJson(undefined, block);
      expect(integrationNeedsRefresh(current, block, "claudeCode")).toBe(false);
    });

    it("is true when the stored command/args are stale", () => {
      const stale = mergeClaudeMcpJson(undefined, { ...block, command: "/old/node" });
      expect(integrationNeedsRefresh(stale, block, "claudeCode")).toBe(true);
    });

    it("is true for a stale vscodeMcpJson entry too", () => {
      const stale = mergeVscodeMcpJson(undefined, { ...block, args: ["/old/dist/cli/index.js", "serve"] });
      expect(integrationNeedsRefresh(stale, block, "vscodeMcpJson")).toBe(true);
    });

    it("is false when the file has no m365-agents entry", () => {
      expect(integrationNeedsRefresh(JSON.stringify({ mcpServers: {} }), block, "claudeCode")).toBe(false);
    });

    it("is false (never throws) for unparseable JSON", () => {
      expect(integrationNeedsRefresh("// comment\n{}\n", block, "vscodeMcpJson")).toBe(false);
    });
  });
});

describe("refreshStaleIntegrations", () => {
  it("rewrites only the stale entry of an enabled integration, in place", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-home-"));
    const configPath = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `# kept comment\n${mergeCodexConfigToml("", { ...block, command: "/old/node" })}`,
      "utf8"
    );
    const summary = await refreshStaleIntegrations(
      { definition: block, homeDirectory: home },
      { codex: true, claudeCode: false, vscodeMcpJson: false }
    );
    expect(summary.refreshed).toEqual([configPath]);
    const rewritten = await readFile(configPath, "utf8");
    expect(rewritten).toContain("# kept comment");
    expect(rewritten).toContain(`command = "${block.command}"`);
  });

  it("never creates a file or entry that does not already exist", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-home-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-ws-"));
    const summary = await refreshStaleIntegrations(
      { definition: block, homeDirectory: home, workspaceRoot: workspace },
      { codex: true, claudeCode: true, vscodeMcpJson: true }
    );
    expect(summary.refreshed).toEqual([]);
    await expect(readFile(path.join(home, ".codex", "config.toml"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(workspace, ".mcp.json"), "utf8")).rejects.toThrow();
  });

  it("never touches a disabled integration's file even when it is stale", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-home-"));
    const configPath = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    const stale = mergeCodexConfigToml("", { ...block, command: "/old/node" });
    await writeFile(configPath, stale, "utf8");
    const summary = await refreshStaleIntegrations(
      { definition: block, homeDirectory: home },
      { codex: false, claudeCode: false, vscodeMcpJson: false }
    );
    expect(summary.refreshed).toEqual([]);
    expect(await readFile(configPath, "utf8")).toBe(stale);
  });

  it("leaves an already up-to-date entry untouched", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-home-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-ws-"));
    const target = path.join(workspace, ".mcp.json");
    const current = mergeClaudeMcpJson(undefined, block);
    await writeFile(target, current, "utf8");
    const summary = await refreshStaleIntegrations(
      { definition: block, homeDirectory: home, workspaceRoot: workspace },
      { codex: false, claudeCode: true, vscodeMcpJson: false }
    );
    expect(summary.refreshed).toEqual([]);
    expect(await readFile(target, "utf8")).toBe(current);
  });
});
