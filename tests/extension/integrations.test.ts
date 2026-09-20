import { promises as fs } from "node:fs";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyIntegrations,
  expandIntegrationValue,
  integrationEntryStatus,
  integrationNeedsRefresh,
  mergeClaudeMcpJson,
  mergeClaudeUserMcpJson,
  mergeCodexConfigToml,
  mergeVscodeMcpJson,
  mergeVscodeUserMcpJson,
  parseCodexEntry,
  parseJsonEntry,
  refreshStaleIntegrations,
  removeClaudeMcpJson,
  removeClaudeUserMcpJson,
  removeCodexConfigToml,
  removeIntegrations,
  removeVscodeMcpJson,
  removeVscodeUserMcpJson
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
    await writeFile(target, "// comment\n{ broken }\n", "utf8");
    const summary = await applyIntegrations(
      { definition: block, homeDirectory: home, workspaceRoot: workspace },
      { codex: false, claudeCode: false, vscodeMcpJson: true }
    );
    expect(summary.written).toEqual([]);
    expect(summary.skipped[0]).toContain("invalid JSONC");
    expect(await readFile(target, "utf8")).toBe("// comment\n{ broken }\n");
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
      expect(integrationNeedsRefresh("// comment\n{ broken }\n", block, "vscodeMcpJson")).toBe(false);
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

describe("Codex configuration preservation regressions", () => {
  it.each(["\n", "\r\n"])("preserves array tables, quoted keys and multiline strings (%j)", (eol) => {
    const unrelated = [
      "[[skills.config]]",
      'path = "/example/SKILL.md"',
      "enabled = false",
      'description = """',
      "[mcp_servers.m365-agents]",
      'command = "this is string content"',
      '"""',
      "[[skills.config]]",
      "path = '/second/SKILL.md'",
      "note = '''",
      "[mcp_servers.m365-agents.env]",
      "'''",
      '[mcp_servers."other]server"]',
      'command = "other"',
      ""
    ].join(eol);
    const existing = [
      "# keep comment",
      '[mcp_servers."m365-\\u0061gents"]',
      'command = "old"',
      "args = []",
      "",
      unrelated
    ].join(eol);
    const merged = mergeCodexConfigToml(existing, { ...block, env: { "key.with.dot": "value" } });
    expect(merged.endsWith(unrelated)).toBe(true);
    expect(getStaticTOMLValue(parseTOML(merged))).toMatchObject({
      skills: { config: [{ path: "/example/SKILL.md", enabled: false }, { path: "/second/SKILL.md" }] },
      mcp_servers: { "m365-agents": { command: block.command, env: { "key.with.dot": "value" } } }
    });
    expect(mergeCodexConfigToml(merged, { ...block, env: { "key.with.dot": "value" } })).toBe(merged);
  });

  it("preserves an interleaved unrelated table when replacing target descendants", () => {
    const existing =
      '[mcp_servers.m365-agents]\ncommand = "old"\n\n[[skills.config]]\npath = "keep"\n\n[mcp_servers.m365-agents.env]\nOLD = "old"\n';
    const merged = mergeCodexConfigToml(existing, block);
    expect(merged).toContain('[[skills.config]]\npath = "keep"');
    expect(merged).not.toContain("OLD =");
    expect(mergeCodexConfigToml(merged, block)).toBe(merged);
  });

  it.each(["[broken", 'mcp_servers = { m365-agents = { command = "old" } }'])(
    "refuses malformed or unsupported inline configuration: %s",
    (existing) => {
      expect(() => mergeCodexConfigToml(existing, block)).toThrow();
    }
  );

  it("parses quoted keys and multiline arguments when checking refresh", () => {
    const existing = `[mcp_servers.'m365-agents']\n'command' = "${block.command}"\nargs = [\n"${block.args[0]}", # comment\n"${block.args[1]}"\n]\n[[skills.config]]\ncommand = "unrelated"\n`;
    expect(integrationNeedsRefresh(existing, block, "codex")).toBe(false);
  });

  it("backs up original bytes before save (a legacy-shaped entry is overwritten)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-backup-"));
    const directory = path.join(home, ".codex");
    const file = path.join(directory, "config.toml");
    await mkdir(directory);
    // §4.7 C6: a shape AgentPickLink itself used to write ("legacy"), so Save still owns it. A bare
    // `command = "old"` with no args would now be foreign -- see the C6 write-path tests below.
    const original =
      '[mcp_servers.m365-agents]\r\ncommand = "/old/node"\r\nargs = ["/old/dist/cli/index.js", "serve"]\r\n[[skills.config]]\r\npath = "keep"\r\n';
    await writeFile(file, original);
    const context = { definition: block, homeDirectory: home };
    const settings = { codex: true, claudeCode: false, vscodeMcpJson: false };
    expect((await applyIntegrations(context, settings)).skipped).toEqual([]);
    const files = await readdir(directory);
    const backups = files.filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(directory, backups[0]), "utf8")).toBe(original);
    expect(await readFile(file, "utf8")).toContain('path = "keep"');
    expect(files.some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
  });

  // §4.7 C7: refresh only ever converges a "managed"/"legacy" entry -- unlike an explicit save, it
  // must never touch a "foreign" entry (a bare `command = "old"` with no `args` is not a shape
  // AgentPickLink itself ever wrote, so it is foreign, not legacy).
  it("backs up original bytes before refresh, for a legacy-shaped entry", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-backup-refresh-"));
    const directory = path.join(home, ".codex");
    const file = path.join(directory, "config.toml");
    await mkdir(directory);
    const original =
      '[mcp_servers.m365-agents]\r\ncommand = "/old/node"\r\nargs = ["/old/dist/cli/index.js", "serve"]\r\n[[skills.config]]\r\npath = "keep"\r\n';
    await writeFile(file, original);
    const context = { definition: block, homeDirectory: home };
    const settings = { codex: true, claudeCode: false, vscodeMcpJson: false };
    expect((await refreshStaleIntegrations(context, settings)).refreshed).toEqual([file]);
    const files = await readdir(directory);
    const backups = files.filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(directory, backups[0]), "utf8")).toBe(original);
    expect(await readFile(file, "utf8")).toContain('path = "keep"');
    expect(files.some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
  });

  it("never refreshes a genuinely foreign entry (§4.7 C7)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-foreign-refresh-"));
    const directory = path.join(home, ".codex");
    const file = path.join(directory, "config.toml");
    await mkdir(directory);
    const original = '[mcp_servers.m365-agents]\r\ncommand = "old"\r\n[[skills.config]]\r\npath = "keep"\r\n';
    await writeFile(file, original);
    const context = { definition: block, homeDirectory: home };
    const settings = { codex: true, claudeCode: false, vscodeMcpJson: false };
    expect((await refreshStaleIntegrations(context, settings)).refreshed).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("does not replace the configuration if the backup cannot be written", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-backup-failure-"));
    const directory = path.join(home, ".codex");
    const file = path.join(directory, "config.toml");
    await mkdir(directory);
    const original = 'model = "keep"\n';
    await writeFile(file, original);
    const originalOpen = fs.open;
    const open = vi
      .spyOn(fs, "open")
      .mockImplementationOnce(originalOpen)
      .mockRejectedValueOnce(new Error("backup failed"));
    try {
      const result = await applyIntegrations(
        { definition: block, homeDirectory: home },
        { codex: true, claudeCode: false, vscodeMcpJson: false }
      );
      expect(result.written).toEqual([]);
      expect(result.skipped[0]).toContain("backup failed");
    } finally {
      open.mockRestore();
    }
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await readdir(directory)).toEqual(["config.toml"]);
  });

  it("keeps the original and backup if atomic replacement fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-failed-write-"));
    const directory = path.join(home, ".codex");
    const file = path.join(directory, "config.toml");
    await mkdir(directory);
    const original = 'model = "keep"\n';
    await writeFile(file, original);
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
    try {
      const result = await applyIntegrations(
        { definition: block, homeDirectory: home },
        { codex: true, claudeCode: false, vscodeMcpJson: false }
      );
      expect(result.written).toEqual([]);
      expect(result.skipped[0]).toContain("rename failed");
    } finally {
      rename.mockRestore();
    }
    expect(await readFile(file, "utf8")).toBe(original);
    const files = await readdir(directory);
    expect(files.filter((name) => name.endsWith(".bak"))).toHaveLength(1);
    expect(files.some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
  });
});

/* -------------------------------------------------------------- WP-B: ownership + removal */

const managed = { ...block, env: { M365_AGENT_MANAGED: "1" } };

describe("parseJsonEntry / parseCodexEntry", () => {
  it("returns env alongside command/args when present", () => {
    const json = mergeVscodeMcpJson(undefined, managed);
    expect(parseJsonEntry(json, "vscodeMcpJson")).toEqual({
      command: block.command,
      args: block.args,
      env: { M365_AGENT_MANAGED: "1" }
    });
    const toml = mergeCodexConfigToml("", { ...managed, startupTimeoutSec: 60, toolTimeoutSec: 900 });
    expect(parseCodexEntry(toml)?.env).toEqual({ M365_AGENT_MANAGED: "1" });
  });
});

describe("integrationEntryStatus", () => {
  it("is absent when the file has no m365-agents entry, or does not exist", () => {
    expect(integrationEntryStatus(JSON.stringify({ servers: {} }), "vscodeMcpJson", block)).toBe("absent");
    expect(integrationEntryStatus("// comment\n{ broken }\n", "vscodeMcpJson", block)).toBe("absent");
  });

  it("is managed when the ownership marker is present", () => {
    const json = mergeVscodeMcpJson(undefined, managed);
    expect(integrationEntryStatus(json, "vscodeMcpJson", block)).toBe("managed");
  });

  it("is legacy for a pre-marker AgentPickLink shape (extension 0.1.x or archive bin/apl.js)", () => {
    const extensionShape = mergeClaudeMcpJson(undefined, {
      command: "/usr/local/bin/node",
      args: ["/ext/dist/cli/index.js", "serve"]
    });
    expect(integrationEntryStatus(extensionShape, "claudeCode", block)).toBe("legacy");
    const archiveShape = mergeVscodeMcpJson(undefined, {
      command: "/home/me/.local/share/AgentPickLink/bin/node",
      args: ["/home/me/.local/share/AgentPickLink/bin/apl.js", "serve"]
    });
    expect(integrationEntryStatus(archiveShape, "vscodeMcpJson", block)).toBe("legacy");
  });

  it("is legacy when a marker-less entry already matches the given definition exactly, even outside the two hardcoded legacy shapes", () => {
    // Neither "dist/cli/index.js" nor "bin/apl.js" -- isLegacyEntrypoint alone would call this
    // foreign; matching `definition` byte-for-byte is what promotes it to legacy instead.
    const custom = { command: "/opt/custom/mytool", args: ["/opt/custom/mytool-entry.js", "serve"] };
    const matching = mergeClaudeMcpJson(undefined, custom);
    expect(integrationEntryStatus(matching, "claudeCode", custom)).toBe("legacy");
  });

  it("is foreign for anything else under the m365-agents key", () => {
    const foreign = mergeVscodeMcpJson(undefined, { command: "/usr/bin/other-tool", args: ["serve"] });
    expect(integrationEntryStatus(foreign, "vscodeMcpJson", block)).toBe("foreign");
  });
});

describe("removeClaudeMcpJson / removeVscodeMcpJson", () => {
  it("deletes the entry and preserves every other key", () => {
    const existing = JSON.stringify({
      other: 1,
      mcpServers: { keep: { command: "keep" }, "m365-agents": managed }
    });
    const removed = JSON.parse(removeClaudeMcpJson(existing));
    expect(removed.other).toBe(1);
    expect(removed.mcpServers.keep).toEqual({ command: "keep" });
    expect(removed.mcpServers["m365-agents"]).toBeUndefined();
  });

  it("refuses a foreign entry unless force", () => {
    const foreign = mergeVscodeMcpJson(undefined, { command: "/usr/bin/other-tool", args: ["serve"] });
    expect(() => removeVscodeMcpJson(foreign)).toThrow(/foreign|force/i);
    const removed = JSON.parse(removeVscodeMcpJson(foreign, { force: true }));
    expect(removed.servers["m365-agents"]).toBeUndefined();
  });

  it("is a no-op when there is no m365-agents entry", () => {
    const existing = JSON.stringify({ servers: { other: { command: "keep" } } });
    expect(JSON.parse(removeVscodeMcpJson(existing)).servers.other).toEqual({ command: "keep" });
  });
});

describe("removeCodexConfigToml", () => {
  it("deletes the table and its env sub-table, preserving every other byte", () => {
    const existing = [
      "# leading comment",
      "",
      "[mcp_servers.m365-agents]",
      'command = "old"',
      "",
      "[mcp_servers.m365-agents.env]",
      'M365_AGENT_MANAGED = "1"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      ""
    ].join("\n");
    const removed = removeCodexConfigToml(existing);
    expect(removed).toContain("# leading comment");
    expect(removed).toContain("[mcp_servers.other]");
    expect(removed).not.toContain("m365-agents");
  });

  it("refuses a foreign entry unless force", () => {
    const foreign = mergeCodexConfigToml("", {
      command: "/usr/bin/other-tool",
      args: ["serve"],
      startupTimeoutSec: 10,
      toolTimeoutSec: 10
    });
    expect(() => removeCodexConfigToml(foreign)).toThrow(/foreign|force/i);
    expect(removeCodexConfigToml(foreign, { force: true })).not.toContain("m365-agents");
  });

  it("is a no-op (returns the input unchanged) when there is no m365-agents table", () => {
    expect(removeCodexConfigToml('model = "gpt-5"\n')).toBe('model = "gpt-5"\n');
  });
});

describe("applyIntegrations strips M365_AGENT_BUILD from the Codex target only", () => {
  it("keeps the stamp for claudeCode/vscodeMcpJson but drops it for codex", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-stamp-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-stamp-ws-"));
    const stamped = { ...block, env: { M365_AGENT_MANAGED: "1", M365_AGENT_BUILD: "1.2.3" } };
    await applyIntegrations(
      { definition: stamped, homeDirectory: home, workspaceRoot: workspace },
      { codex: true, claudeCode: true, vscodeMcpJson: false }
    );
    const codexText = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
    expect(codexText).not.toContain("M365_AGENT_BUILD");
    expect(codexText).toContain("M365_AGENT_MANAGED");
    const claudeJson = JSON.parse(await readFile(path.join(workspace, ".mcp.json"), "utf8"));
    expect(claudeJson.mcpServers["m365-agents"].env.M365_AGENT_BUILD).toBe("1.2.3");
  });
});

describe("removeIntegrations", () => {
  it("mirrors applyIntegrations: removes only the enabled targets that have an entry", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-remove-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-remove-ws-"));
    await applyIntegrations(
      { definition: managed, homeDirectory: home, workspaceRoot: workspace },
      { codex: true, claudeCode: true, vscodeMcpJson: true }
    );

    const summary = await removeIntegrations(
      { definition: managed, homeDirectory: home, workspaceRoot: workspace },
      { codex: true, claudeCode: true, vscodeMcpJson: true }
    );

    expect(summary.written.sort()).toEqual(
      [
        path.join(home, ".codex", "config.toml"),
        path.join(workspace, ".mcp.json"),
        path.join(workspace, ".vscode", "mcp.json")
      ].sort()
    );
    const codexAfter = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
    expect(codexAfter).not.toContain("m365-agents");
  });

  it("refuses a foreign entry without force, backs it up once and removes it with force", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-remove-foreign-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-remove-foreign-ws-"));
    await mkdir(path.join(workspace, ".vscode"), { recursive: true });
    const foreign = mergeVscodeMcpJson(undefined, { command: "/usr/bin/other-tool", args: ["serve"] });
    await writeFile(path.join(workspace, ".vscode", "mcp.json"), foreign, "utf8");

    const refused = await removeIntegrations(
      { definition: block, homeDirectory: home, workspaceRoot: workspace },
      { codex: false, claudeCode: false, vscodeMcpJson: true }
    );
    expect(refused.written).toEqual([]);
    expect(await readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8")).toBe(foreign);

    const forced = await removeIntegrations(
      { definition: block, homeDirectory: home, workspaceRoot: workspace },
      { codex: false, claudeCode: false, vscodeMcpJson: true },
      { force: true }
    );
    expect(forced.written).toEqual([path.join(workspace, ".vscode", "mcp.json")]);
    const backupFiles = (await readdir(path.join(workspace, ".vscode"))).filter((name) =>
      name.endsWith(".apl-backup")
    );
    expect(backupFiles).toHaveLength(1);
    expect(await readFile(path.join(workspace, ".vscode", backupFiles[0]), "utf8")).toBe(foreign);
  });

  it("is a no-op (not an error) when the file does not exist", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-remove-absent-"));
    const summary = await removeIntegrations(
      { definition: block, homeDirectory: home },
      { codex: true, claudeCode: false, vscodeMcpJson: false }
    );
    expect(summary.written).toEqual([]);
    expect(summary.skipped).toEqual([]);
  });
});

/* ------------------------------------------------------------------ §4.7 C9 variable forms */

describe("§4.7 C9 variable forms", () => {
  const windowsHome = {
    command: "C:\\Users\\me\\AppData\\Local\\AgentPickLink\\bin\\node.exe",
    args: ["C:\\Users\\me\\AppData\\Local\\AgentPickLink\\bin\\apl.js", "serve"]
  };
  const windowsVariables = { localAppData: "C:\\Users\\me\\AppData\\Local", userHome: "C:\\Users\\me" };
  const posixHome = {
    command: "/home/me/.local/share/AgentPickLink/bin/node",
    args: ["/home/me/.local/share/AgentPickLink/bin/apl.js", "serve"]
  };
  const posixVariables = { userHome: "/home/me" };

  it("mergeVscodeMcpJson writes ${env:LOCALAPPDATA} on a Windows home under %LOCALAPPDATA%", () => {
    const json = JSON.parse(mergeVscodeMcpJson(undefined, windowsHome, windowsVariables));
    const entry = json.servers["m365-agents"];
    expect(entry.command).toBe("${env:LOCALAPPDATA}\\AgentPickLink\\bin\\node.exe");
    expect(entry.args[0]).toBe("${env:LOCALAPPDATA}\\AgentPickLink\\bin\\apl.js");
  });

  it("mergeVscodeMcpJson writes ${userHome} on a macOS/Linux home under the home directory", () => {
    const json = JSON.parse(mergeVscodeMcpJson(undefined, posixHome, posixVariables));
    const entry = json.servers["m365-agents"];
    expect(entry.command).toBe("${userHome}/.local/share/AgentPickLink/bin/node");
    expect(entry.args[0]).toBe("${userHome}/.local/share/AgentPickLink/bin/apl.js");
  });

  it("mergeClaudeMcpJson writes ${LOCALAPPDATA}/${HOME} the same way", () => {
    const windowsJson = JSON.parse(mergeClaudeMcpJson(undefined, windowsHome, windowsVariables));
    expect(windowsJson.mcpServers["m365-agents"].command).toBe(
      "${LOCALAPPDATA}\\AgentPickLink\\bin\\node.exe"
    );
    const posixJson = JSON.parse(mergeClaudeMcpJson(undefined, posixHome, posixVariables));
    expect(posixJson.mcpServers["m365-agents"].command).toBe("${HOME}/.local/share/AgentPickLink/bin/node");
  });

  it("mergeCodexConfigToml never substitutes a variable, but adds a # machine-specific comment above the table", () => {
    const rendered = mergeCodexConfigToml(
      "",
      { ...posixHome, startupTimeoutSec: 60, toolTimeoutSec: 900 },
      posixVariables
    );
    expect(rendered).toContain("# machine-specific\n[mcp_servers.m365-agents]");
    expect(rendered).toContain(`command = "${posixHome.command}"`);
  });

  it("does not add the comment when the command is not home-based", () => {
    const rendered = mergeCodexConfigToml(
      "",
      {
        command: "/usr/local/bin/node",
        args: ["/opt/x/index.js", "serve"],
        startupTimeoutSec: 60,
        toolTimeoutSec: 900
      },
      posixVariables
    );
    expect(rendered).not.toContain("machine-specific");
  });

  it("is idempotent: rewriting with variables again does not accumulate a second comment", () => {
    const block1 = { ...posixHome, startupTimeoutSec: 60, toolTimeoutSec: 900 };
    const once = mergeCodexConfigToml("", block1, posixVariables);
    const twice = mergeCodexConfigToml(once, block1, posixVariables);
    expect(twice.match(/machine-specific/g)?.length).toBe(1);
  });

  it("removeCodexConfigToml removes the preceding machine-specific comment along with the table", () => {
    const block1 = { ...posixHome, startupTimeoutSec: 60, toolTimeoutSec: 900 };
    const written = mergeCodexConfigToml('model = "gpt-5"\n', block1, posixVariables);
    expect(written).toContain("machine-specific");
    const removed = removeCodexConfigToml(written);
    expect(removed).not.toContain("machine-specific");
    expect(removed).toContain('model = "gpt-5"');
  });

  it("integrationEntryStatus reads a variable-form vscode entry back as managed, not foreign", () => {
    const definition = { ...posixHome, env: { M365_AGENT_MANAGED: "1" } };
    const json = mergeVscodeMcpJson(undefined, definition, posixVariables);
    expect(integrationEntryStatus(json, "vscodeMcpJson", definition, posixVariables)).toBe("managed");
  });

  it("without expanding variables, an unmarked variable-form entry misreports foreign instead of legacy", () => {
    // A custom entrypoint (not "dist/cli/index.js" or "bin/apl.js") and no ownership marker: this
    // entry is classified purely by matching `definition` byte-for-byte, so it demonstrates why
    // integrationEntryStatus must expand a stored variable form back before comparing.
    const custom = { command: "/home/me/.local/share/AgentPickLink/bin/custom.js", args: ["serve"] };
    const json = mergeVscodeMcpJson(undefined, custom, posixVariables);
    expect(integrationEntryStatus(json, "vscodeMcpJson", custom, posixVariables)).toBe("legacy");
    expect(integrationEntryStatus(json, "vscodeMcpJson", custom)).toBe("foreign");
  });

  it("integrationNeedsRefresh is false for a current variable-form entry and true for a stale one", () => {
    const definition = { ...posixHome, env: { M365_AGENT_MANAGED: "1" } };
    const current = mergeClaudeMcpJson(undefined, definition, posixVariables);
    expect(integrationNeedsRefresh(current, definition, "claudeCode", posixVariables)).toBe(false);
    const stale = mergeClaudeMcpJson(
      undefined,
      { ...definition, command: "/home/me/.local/share/AgentPickLink-old/bin/node" },
      posixVariables
    );
    expect(integrationNeedsRefresh(stale, definition, "claudeCode", posixVariables)).toBe(true);
  });

  it("applyIntegrations writes the variable form end to end via context.variables", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-c9-home-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-c9-ws-"));
    // `home` is a real, host-native temp path -- on win32 that's a drive-letter path, which
    // `pathRemainder` (src/services/integrations.ts) normalizes through `path.win32.resolve`
    // before matching, so a command built by hand-concatenating "/" (rather than `path.join`,
    // like every real caller does) would come back re-normalized to "\" and never match the
    // forward-slash literal below.
    const definition = {
      command: path.join(home, "bin", "node"),
      args: [path.join(home, "bin", "apl.js"), "serve"]
    };
    await applyIntegrations(
      { definition, homeDirectory: home, workspaceRoot: workspace, variables: { userHome: home } },
      { codex: false, claudeCode: false, vscodeMcpJson: true }
    );
    const json = JSON.parse(await readFile(path.join(workspace, ".vscode", "mcp.json"), "utf8"));
    expect(json.servers["m365-agents"].command).toBe(`\${userHome}${path.sep}bin${path.sep}node`);
  });
});

/* ------------------------------------------------------------------ vscodeUser writer (§4.4) */

describe("mergeVscodeUserMcpJson / removeVscodeUserMcpJson", () => {
  it("writes servers[m365-agents] with no cwd", () => {
    const json = JSON.parse(mergeVscodeUserMcpJson(undefined, block));
    const entry = json.servers["m365-agents"];
    expect(entry.command).toBe(block.command);
    expect(entry.cwd).toBeUndefined();
    expect(entry.type).toBe("stdio");
  });

  it("never gets a §4.7 C9 variable form even when variables are given elsewhere in the same run", () => {
    // mergeVscodeUserMcpJson takes no `variables` parameter at all -- this is a compile-time
    // guarantee, not a runtime check; this test documents the intent.
    const json = JSON.parse(mergeVscodeUserMcpJson(undefined, block));
    expect(json.servers["m365-agents"].command).toBe(block.command);
  });

  it("removes the entry, preserving every other key", () => {
    const written = mergeVscodeUserMcpJson(JSON.stringify({ other: 1 }), block);
    const removed = JSON.parse(removeVscodeUserMcpJson(written));
    expect(removed.other).toBe(1);
    expect(removed.servers["m365-agents"]).toBeUndefined();
  });

  it("refuses a foreign entry unless force", () => {
    const foreign = mergeVscodeUserMcpJson(undefined, { command: "/usr/bin/other", args: [] });
    expect(() => removeVscodeUserMcpJson(foreign)).toThrow(/foreign|force/i);
    expect(
      JSON.parse(removeVscodeUserMcpJson(foreign, { force: true })).servers["m365-agents"]
    ).toBeUndefined();
  });
});

describe("applyIntegrations / removeIntegrations wire the vscodeUser integration", () => {
  it("writes to <vscodeUserDirectory>/mcp.json with no workspace open and no cwd", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-vsu-home-"));
    const vscodeUserDirectory = await mkdtemp(path.join(os.tmpdir(), "apl-vsu-userdir-"));
    const summary = await applyIntegrations(
      { definition: block, homeDirectory: home, vscodeUserDirectory },
      { codex: false, claudeCode: false, vscodeMcpJson: false, vscodeUser: true }
    );
    expect(summary.written).toEqual([path.join(vscodeUserDirectory, "mcp.json")]);
    const json = JSON.parse(await readFile(path.join(vscodeUserDirectory, "mcp.json"), "utf8"));
    expect(json.servers["m365-agents"].cwd).toBeUndefined();
  });

  it("skips with a reason when the VS Code user directory was not found", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-vsu-home2-"));
    const summary = await applyIntegrations(
      { definition: block, homeDirectory: home },
      { codex: false, claudeCode: false, vscodeMcpJson: false, vscodeUser: true }
    );
    expect(summary.written).toEqual([]);
    expect(summary.skipped[0]).toMatch(/vscode-user|user directory/i);
  });

  it("removeIntegrations removes the vscodeUser entry it wrote", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-vsu-home3-"));
    const vscodeUserDirectory = await mkdtemp(path.join(os.tmpdir(), "apl-vsu-userdir3-"));
    await applyIntegrations(
      { definition: managed, homeDirectory: home, vscodeUserDirectory },
      { codex: false, claudeCode: false, vscodeMcpJson: false, vscodeUser: true }
    );
    const summary = await removeIntegrations(
      { definition: managed, homeDirectory: home, vscodeUserDirectory },
      { codex: false, claudeCode: false, vscodeMcpJson: false, vscodeUser: true }
    );
    expect(summary.written).toEqual([path.join(vscodeUserDirectory, "mcp.json")]);
  });
});

/* ------------------------------------------------------------------ claudeUser writer (§4.4/CLI) */

describe("mergeClaudeUserMcpJson / removeClaudeUserMcpJson", () => {
  it("writes mcpServers[m365-agents] with no type field and no cwd", () => {
    const json = JSON.parse(mergeClaudeUserMcpJson(undefined, block));
    const entry = json.mcpServers["m365-agents"];
    expect(entry.command).toBe(block.command);
    expect(entry.type).toBeUndefined();
    expect(entry.cwd).toBeUndefined();
  });

  it("removes the entry, preserving every other key", () => {
    const written = mergeClaudeUserMcpJson(JSON.stringify({ other: 1 }), block);
    const removed = JSON.parse(removeClaudeUserMcpJson(written));
    expect(removed.other).toBe(1);
    expect(removed.mcpServers["m365-agents"]).toBeUndefined();
  });

  it("refuses a foreign entry unless force", () => {
    const foreign = mergeClaudeUserMcpJson(undefined, { command: "/usr/bin/other", args: [] });
    expect(() => removeClaudeUserMcpJson(foreign)).toThrow(/foreign|force/i);
    expect(
      JSON.parse(removeClaudeUserMcpJson(foreign, { force: true })).mcpServers["m365-agents"]
    ).toBeUndefined();
  });
});

describe("applyIntegrations / removeIntegrations wire the claudeUser integration", () => {
  it("prefers the vendor CLI when claudeCliAvailable, passing the JSON as one argv element", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-clu-home-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { stdout: "" };
    };
    const summary = await applyIntegrations(
      { definition: block, homeDirectory: home, claudeCliAvailable: true, exec },
      { codex: false, claudeCode: false, vscodeMcpJson: false, claudeUser: true }
    );
    expect(summary.written).toEqual([path.join(home, ".claude.json")]);
    expect(calls[0]).toEqual({
      command: "claude",
      args: [
        "mcp",
        "add-json",
        "m365-agents",
        JSON.stringify({ command: block.command, args: block.args }),
        "--scope",
        "user"
      ]
    });
    expect(calls.at(-1)).toEqual({ command: "claude", args: ["mcp", "get", "m365-agents"] });
    // Never actually touches ~/.claude.json when the vendor CLI succeeds.
    await expect(readFile(path.join(home, ".claude.json"), "utf8")).rejects.toThrow();
  });

  it("retries after `mcp remove` when add-json refuses an existing name, then verifies", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-clu-retry-"));
    let addAttempts = 0;
    const calls: string[][] = [];
    const exec = async (command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "mcp" && args[1] === "add-json") {
        addAttempts += 1;
        if (addAttempts === 1) throw new Error("already exists");
      }
      return { stdout: "" };
    };
    const summary = await applyIntegrations(
      { definition: block, homeDirectory: home, claudeCliAvailable: true, exec },
      { codex: false, claudeCode: false, vscodeMcpJson: false, claudeUser: true }
    );
    expect(summary.written).toEqual([path.join(home, ".claude.json")]);
    expect(addAttempts).toBe(2);
    expect(calls.some((args) => args[0] === "mcp" && args[1] === "remove")).toBe(true);
  });

  it("falls back to editing ~/.claude.json directly when the vendor CLI is unavailable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-clu-fallback-"));
    const summary = await applyIntegrations(
      { definition: block, homeDirectory: home },
      { codex: false, claudeCode: false, vscodeMcpJson: false, claudeUser: true }
    );
    expect(summary.written).toEqual([path.join(home, ".claude.json")]);
    const json = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
    expect(json.mcpServers["m365-agents"].command).toBe(block.command);
  });

  it("falls back to the direct file edit when every vendor CLI attempt fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-clu-cli-fails-"));
    const exec = async () => {
      throw new Error("claude: command not found");
    };
    const summary = await applyIntegrations(
      { definition: block, homeDirectory: home, claudeCliAvailable: true, exec },
      { codex: false, claudeCode: false, vscodeMcpJson: false, claudeUser: true }
    );
    expect(summary.written).toEqual([path.join(home, ".claude.json")]);
    const json = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
    expect(json.mcpServers["m365-agents"].command).toBe(block.command);
  });

  it("refuses a foreign ~/.claude.json entry unless force, via the ownership check ahead of the CLI", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-clu-foreign-"));
    const original = mergeClaudeUserMcpJson(undefined, { command: "/usr/bin/other", args: [] });
    await writeFile(path.join(home, ".claude.json"), original, "utf8");
    const exec = async () => {
      throw new Error("must not be called");
    };
    const summary = await applyIntegrations(
      { definition: managed, homeDirectory: home, claudeCliAvailable: true, exec },
      { codex: false, claudeCode: false, vscodeMcpJson: false, claudeUser: true }
    );
    expect(summary.written).toEqual([]);
    expect(summary.skipped[0]).toContain("AgentPickLink did not write");
    expect(await readFile(path.join(home, ".claude.json"), "utf8")).toBe(original);
  });

  it("removeIntegrations removes the claudeUser entry via the vendor CLI when available", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-clu-remove-"));
    await writeFile(path.join(home, ".claude.json"), mergeClaudeUserMcpJson(undefined, managed), "utf8");
    const calls: string[][] = [];
    const exec = async (_command: string, args: string[]) => {
      calls.push(args);
      return { stdout: "" };
    };
    const summary = await removeIntegrations(
      { definition: managed, homeDirectory: home, claudeCliAvailable: true, exec },
      { codex: false, claudeCode: false, vscodeMcpJson: false, claudeUser: true }
    );
    expect(summary.written).toEqual([path.join(home, ".claude.json")]);
    expect(calls).toEqual([["mcp", "remove", "m365-agents", "--scope", "user"]]);
  });

  it("removeIntegrations falls back to the direct file edit when the vendor CLI fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-clu-remove-fallback-"));
    await writeFile(path.join(home, ".claude.json"), mergeClaudeUserMcpJson(undefined, managed), "utf8");
    const exec = async () => {
      throw new Error("claude: command not found");
    };
    const summary = await removeIntegrations(
      { definition: managed, homeDirectory: home, claudeCliAvailable: true, exec },
      { codex: false, claudeCode: false, vscodeMcpJson: false, claudeUser: true }
    );
    expect(summary.written).toEqual([path.join(home, ".claude.json")]);
    const json = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
    expect(json.mcpServers["m365-agents"]).toBeUndefined();
  });

  it("removeIntegrations is a no-op when ~/.claude.json does not exist", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-clu-remove-absent-"));
    const summary = await removeIntegrations(
      { definition: managed, homeDirectory: home },
      { codex: false, claudeCode: false, vscodeMcpJson: false, claudeUser: true }
    );
    expect(summary.written).toEqual([]);
    expect(summary.skipped).toEqual([]);
  });
});

/* ------------------------------------------------------------------ §4.7 C6 on the write path */

const ownedDefinition = { ...block, env: { M365_AGENT_MANAGED: "1" } };

/** A `m365-agents` entry AgentPickLink did not write: a shape it never used, with no marker. */
const foreignEntry = { command: "/usr/bin/some-other-tool", args: ["--serve-everything"] };

describe("applyIntegrations ownership (§4.7 C6, P1-8)", () => {
  it("refuses a foreign .vscode/mcp.json entry and leaves it byte-identical", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-own-home-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-own-ws-"));
    const file = path.join(workspace, ".vscode", "mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    const original = mergeVscodeMcpJson(undefined, foreignEntry);
    await writeFile(file, original, "utf8");

    const summary = await applyIntegrations(
      { definition: ownedDefinition, homeDirectory: home, workspaceRoot: workspace },
      { codex: false, claudeCode: false, vscodeMcpJson: true }
    );

    expect(summary.written).toEqual([]);
    expect(summary.skipped[0]).toContain("AgentPickLink did not write");
    expect(summary.skipped[0]).toContain("--force");
    expect(await readFile(file, "utf8")).toBe(original);
    await expect(readFile(`${file}.apl-backup`, "utf8")).rejects.toThrow();
  });

  it("overwrites a foreign entry with force, after preserving the original bytes once", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-own-home-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-own-ws-"));
    const file = path.join(workspace, ".vscode", "mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    const original = mergeVscodeMcpJson(undefined, foreignEntry);
    await writeFile(file, original, "utf8");

    const summary = await applyIntegrations(
      { definition: ownedDefinition, homeDirectory: home, workspaceRoot: workspace },
      { codex: false, claudeCode: false, vscodeMcpJson: true },
      { force: true }
    );

    expect(summary.written).toEqual([file]);
    expect(summary.skipped).toEqual([]);
    expect(await readFile(`${file}.apl-backup`, "utf8")).toBe(original);
    expect(parseJsonEntry(await readFile(file, "utf8"), "vscodeMcpJson")?.command).toBe(
      ownedDefinition.command
    );
  });

  // The user-profile file is the worst place to clobber someone else's entry: it is shared by every
  // workspace and every other tool on the machine.
  it("refuses a foreign user-profile mcp.json entry (vscodeUser) and leaves it byte-identical", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-own-home-"));
    const userDirectory = await mkdtemp(path.join(os.tmpdir(), "apl-own-user-"));
    const file = path.join(userDirectory, "mcp.json");
    const original = mergeVscodeUserMcpJson(undefined, foreignEntry);
    await writeFile(file, original, "utf8");

    const summary = await applyIntegrations(
      { definition: ownedDefinition, homeDirectory: home, vscodeUserDirectory: userDirectory },
      { codex: false, claudeCode: false, vscodeMcpJson: false, vscodeUser: true }
    );

    expect(summary.written).toEqual([]);
    expect(summary.skipped[0]).toContain("AgentPickLink did not write");
    expect(await readFile(file, "utf8")).toBe(original);
  });
});

/* ------------------------------------------------------ §4.7 C14 re-stamping (P1-4) */

describe("integrationNeedsRefresh with compareEnvKeys (§4.7 C14)", () => {
  const stamped = { ...block, env: { M365_AGENT_MANAGED: "1", M365_AGENT_BUILD: "2.0.0" } };
  const previous = mergeVscodeMcpJson(undefined, {
    ...block,
    env: { M365_AGENT_MANAGED: "1", M365_AGENT_BUILD: "1.0.0" }
  });

  it("ignores env by default, so the extension's semantics are unchanged", () => {
    expect(integrationNeedsRefresh(previous, stamped, "vscodeMcpJson")).toBe(false);
  });

  it("reports a stale build stamp when the caller asks for it", () => {
    expect(
      integrationNeedsRefresh(previous, stamped, "vscodeMcpJson", undefined, [
        "M365_AGENT_MANAGED",
        "M365_AGENT_BUILD"
      ])
    ).toBe(true);
  });

  it("is false again once the stamp matches", () => {
    const current = mergeVscodeMcpJson(undefined, stamped);
    expect(
      integrationNeedsRefresh(current, stamped, "vscodeMcpJson", undefined, [
        "M365_AGENT_MANAGED",
        "M365_AGENT_BUILD"
      ])
    ).toBe(false);
  });

  // The codex writer drops the stamp, so comparing it there has to compare the *effective*
  // definition -- otherwise every install reports an eternal, byte-identical "refresh".
  it("never reports an eternal refresh for Codex, which carries no stamp", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-stamp-home-"));
    const file = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(file), { recursive: true });
    const written = mergeCodexConfigToml("", {
      ...block,
      env: { M365_AGENT_MANAGED: "1" },
      startupTimeoutSec: 60,
      toolTimeoutSec: 900
    });
    await writeFile(file, written, "utf8");

    const summary = await refreshStaleIntegrations(
      {
        definition: stamped,
        homeDirectory: home,
        compareEnvKeys: ["M365_AGENT_MANAGED", "M365_AGENT_BUILD"]
      },
      { codex: true, claudeCode: false, vscodeMcpJson: false }
    );

    expect(summary.refreshed).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(written);
  });
});

/* ------------------------------------------------------ §4.7 C9 variable forms (P0-2, §P2) */

describe("variable forms", () => {
  const posixVariables = { userHome: "/Users/dev" };
  const homeBased = {
    command: "/Users/dev/.local/share/AgentPickLink/bin/node",
    args: ["/Users/dev/.local/share/AgentPickLink/bin/apl.js", "serve"],
    env: { M365_AGENT_MANAGED: "1" }
  };

  it("a refresh that is handed the same variables writes nothing at all", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-var-home-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-var-ws-"));
    const file = path.join(workspace, ".vscode", "mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    const portable = mergeVscodeMcpJson(undefined, homeBased, posixVariables);
    expect(portable).toContain("${userHome}");
    await writeFile(file, portable, "utf8");

    const withVariables = await refreshStaleIntegrations(
      { definition: homeBased, homeDirectory: home, workspaceRoot: workspace, variables: posixVariables },
      { codex: false, claudeCode: false, vscodeMcpJson: true }
    );
    expect(withVariables.refreshed).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(portable);

    // Without them the very same file reads as stale -- the ping-pong P0-2 describes.
    const withoutVariables = await refreshStaleIntegrations(
      { definition: homeBased, homeDirectory: home, workspaceRoot: workspace },
      { codex: false, claudeCode: false, vscodeMcpJson: true }
    );
    expect(withoutVariables.refreshed).toEqual([file]);
  });

  // §P2: win32 paths compare case-insensitively, treat `/` and `\` as the same separator, and must
  // not care whether the configured prefix carries a trailing one.
  it("substitutes on Windows-shaped paths regardless of case, separator or a trailing separator", () => {
    const merged = JSON.parse(
      mergeVscodeMcpJson(
        undefined,
        {
          command: "C:/Users/Dev/AppData/local/AgentPickLink/bin/node.exe",
          args: ["C:\\Users\\dev\\AppData\\Local\\AgentPickLink\\bin\\apl.js", "serve"]
        },
        { localAppData: "C:\\Users\\DEV\\AppData\\Local\\" }
      )
    ) as { servers: { "m365-agents": { command: string; args: string[] } } };
    const entry = merged.servers["m365-agents"];

    expect(entry.command).toBe("${env:LOCALAPPDATA}\\AgentPickLink\\bin\\node.exe");
    expect(entry.args[0]).toBe("${env:LOCALAPPDATA}\\AgentPickLink\\bin\\apl.js");
  });

  it("never substitutes a sibling directory that merely shares the prefix as a string", () => {
    const merged = JSON.parse(
      mergeVscodeMcpJson(undefined, { command: "/Users/developer/bin/node", args: [] }, posixVariables)
    ) as { servers: { "m365-agents": { command: string } } };
    expect(merged.servers["m365-agents"].command).toBe("/Users/developer/bin/node");
  });

  // §P2: expanding a token this machine has no value for used to produce the literal text
  // "undefined\..." and classify a perfectly good entry as foreign.
  it("leaves a token with no value on this machine exactly as written", () => {
    expect(
      expandIntegrationValue(
        "${env:LOCALAPPDATA}\\AgentPickLink\\bin\\node.exe",
        "vscodeMcpJson",
        posixVariables
      )
    ).toBe("${env:LOCALAPPDATA}\\AgentPickLink\\bin\\node.exe");
    expect(expandIntegrationValue("${userHome}/bin/node", "vscodeMcpJson", posixVariables)).toBe(
      "/Users/dev/bin/node"
    );
    // Codex has no variable syntax at all, so nothing is ever expanded for it.
    expect(expandIntegrationValue("${userHome}/bin/node", "codex", posixVariables)).toBe(
      "${userHome}/bin/node"
    );
  });

  // §P2: the launcher path lives in `args`, so a system-Node command with home-based args is just
  // as machine-specific as a home-based command.
  it("marks a Codex block machine-specific when only its args are home-based", () => {
    const rendered = mergeCodexConfigToml(
      "",
      {
        command: "/usr/local/bin/node",
        args: ["/Users/dev/.local/share/AgentPickLink/bin/apl.js", "serve"],
        startupTimeoutSec: 60,
        toolTimeoutSec: 900
      },
      posixVariables
    );
    expect(rendered.startsWith("# machine-specific\n[mcp_servers.m365-agents]")).toBe(true);
  });

  it("leaves a Codex block unmarked when nothing about it is home-based", () => {
    const rendered = mergeCodexConfigToml(
      "",
      { ...block, startupTimeoutSec: 60, toolTimeoutSec: 900 },
      posixVariables
    );
    expect(rendered).not.toContain("# machine-specific");
  });
});

/* -------------------------------------------------------------- ISSUE-02: JSON byte preservation */

describe("ISSUE-02: JSON writers preserve every other byte", () => {
  // docs/validation-log-2026-09-14-windows.md's own repro shape: tabs, a blank line between
  // entries, and a hand-written "other" entry with deliberate double spaces / a trailing space
  // before its comma -- none of that is ever supposed to move.
  const otherToolLines = [
    '\t\t"other-tool": {',
    '\t\t\t"command":   "run-other"  ,',
    '\t\t\t"args": [',
    '\t\t\t\t"--flag"',
    "\t\t\t]",
    "\t\t},",
    "",
    '\t\t"m365-agents": {',
    '\t\t\t"command": "/old/node",',
    '\t\t\t"args": ["/old/dist/cli/index.js", "serve"]',
    "\t\t}"
  ];
  const windowsStyleFixture = `{\n\t"servers": {\n${otherToolLines.join("\n")}\n\t}\n}\n`;

  it("replaces the managed member, leaving a tab-indented, oddly-spaced sibling and its blank line untouched", () => {
    const merged = mergeVscodeMcpJson(windowsStyleFixture, block);
    expect(
      merged.includes(
        '\t\t"other-tool": {\n\t\t\t"command":   "run-other"  ,\n\t\t\t"args": [\n\t\t\t\t"--flag"\n\t\t\t]\n\t\t},\n\n'
      )
    ).toBe(true);
    expect(merged.startsWith('{\n\t"servers": {\n')).toBe(true);
    const parsed = JSON.parse(merged);
    expect(parsed.servers["other-tool"]).toEqual({ command: "run-other", args: ["--flag"] });
    expect(parsed.servers["m365-agents"]).toEqual({
      type: "stdio",
      command: block.command,
      args: block.args
    });
    // The replaced member keeps its own former indentation (two tabs) rather than the file-wide
    // detected unit being applied to it directly.
    expect(merged).toContain(
      `\t\t"m365-agents": {\n\t\t\t"type": "stdio",\n\t\t\t"command": ${JSON.stringify(block.command)}`
    );
  });

  it("round-trips byte identity of the untouched sibling across merge, replace and remove", () => {
    const commaIndex = windowsStyleFixture.indexOf(',\n\n\t\t"m365-agents"');
    const siblingPrefix = windowsStyleFixture.slice(0, commaIndex);

    const merged = mergeVscodeMcpJson(windowsStyleFixture, block);
    expect(merged.startsWith(siblingPrefix)).toBe(true);

    const replacedAgain = mergeVscodeMcpJson(merged, { ...block, command: "/new/node" });
    expect(replacedAgain.startsWith(siblingPrefix)).toBe(true);
    expect(JSON.parse(replacedAgain).servers["m365-agents"].command).toBe("/new/node");

    const removed = removeVscodeMcpJson(replacedAgain);
    expect(removed.startsWith(siblingPrefix)).toBe(true);
    expect(JSON.parse(removed).servers).toEqual({ "other-tool": { command: "run-other", args: ["--flag"] } });
  });

  it("preserves CRLF line endings end-to-end (merge and remove)", () => {
    const existing =
      '{\r\n  "other": 1,\r\n  "servers": {\r\n    "m365-agents": {\r\n      "command": "/old/node",\r\n      "args": []\r\n    }\r\n  }\r\n}\r\n';
    const merged = mergeVscodeMcpJson(existing, block);
    expect(merged).not.toMatch(/[^\r]\n/);
    expect(merged).toContain('"other": 1,\r\n');
    expect(JSON.parse(merged).servers["m365-agents"].command).toBe(block.command);

    const removed = removeVscodeMcpJson(merged);
    expect(removed).not.toMatch(/[^\r]\n/);
    expect(JSON.parse(removed).servers).toEqual({});
    expect(removed).toContain('"other": 1,\r\n');
  });

  it("creates the mcpServers/servers container as the last top-level property when it does not exist yet", () => {
    const existing = '{\n  "other": true\n}\n';
    const merged = mergeClaudeMcpJson(existing, block);
    expect(merged.startsWith('{\n  "other": true,\n  "mcpServers": {\n    "m365-agents"')).toBe(true);
    expect(JSON.parse(merged)).toEqual({
      other: true,
      mcpServers: { "m365-agents": { command: block.command, args: block.args } }
    });
    expect(Object.keys(JSON.parse(merged))).toEqual(["other", "mcpServers"]);
  });

  it("creates the container from scratch in a literally empty {} file, using 2-space indentation", () => {
    const merged = mergeVscodeMcpJson("{}", block);
    expect(JSON.parse(merged)).toEqual({
      servers: { "m365-agents": { type: "stdio", command: block.command, args: block.args } }
    });
    expect(merged).toBe(
      [
        "{",
        '  "servers": {',
        '    "m365-agents": {',
        '      "type": "stdio",',
        `      "command": ${JSON.stringify(block.command)},`,
        '      "args": [',
        `        ${JSON.stringify(block.args[0])},`,
        `        ${JSON.stringify(block.args[1])}`,
        "      ]",
        "    }",
        "  }",
        "}"
      ].join("\n")
    );
  });

  it("inserts m365-agents as the last property (key order) when the container exists without it", () => {
    const existing = '{\n  "mcpServers": {\n    "keep": { "command": "keep" }\n  }\n}\n';
    const merged = mergeClaudeMcpJson(existing, block);
    const parsed = JSON.parse(merged);
    expect(Object.keys(parsed.mcpServers)).toEqual(["keep", "m365-agents"]);
    expect(merged).toContain('"keep": { "command": "keep" },\n    "m365-agents"');
    // The untouched sibling's own single-line formatting survives exactly.
    expect(merged).toContain('"mcpServers": {\n    "keep": { "command": "keep" },\n');
  });

  it("mergeClaudeUserMcpJson (the ~/.claude.json fallback merge) preserves a hand-written sibling's exact spacing", () => {
    const existing = '{\n  "mcpServers": {\n    "other": {\n      "command":  "keep"  \n    }\n  }\n}\n';
    const merged = mergeClaudeUserMcpJson(existing, block);
    expect(merged).toContain('"other": {\n      "command":  "keep"  \n    },');
    expect(JSON.parse(merged).mcpServers.other).toEqual({ command: "keep" });
    expect(JSON.parse(merged).mcpServers["m365-agents"]).toEqual({
      command: block.command,
      args: block.args
    });
  });

  it("removeVscodeMcpJson is a byte-identical no-op when there is no servers container at all", () => {
    const existing = '{\n  "other": 1\n}\n';
    expect(removeVscodeMcpJson(existing)).toBe(existing);
  });

  it("removeClaudeMcpJson is a byte-identical no-op when mcpServers exists without m365-agents", () => {
    const existing = '{\n  "mcpServers": {\n    "keep": { "command": "keep" }\n  }\n}\n';
    expect(removeClaudeMcpJson(existing)).toBe(existing);
  });

  it("is idempotent (merging the same definition twice yields byte-identical output)", () => {
    const once = mergeVscodeMcpJson(windowsStyleFixture, block);
    expect(mergeVscodeMcpJson(once, block)).toBe(once);
  });
});
