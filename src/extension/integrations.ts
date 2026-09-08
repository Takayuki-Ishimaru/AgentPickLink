/**
 * Opt-in AI-client integrations. Every writer is a pure function over the existing file text so it
 * can be unit tested without a filesystem (`tests/extension/integrations.test.ts`) and so an
 * unexpected shape can never silently destroy a user's configuration:
 *
 * - Codex     : `~/.codex/config.toml`            -> `[mcp_servers.m365-agents]`
 * - Claude Code: `<workspace>/.mcp.json`          -> `mcpServers["m365-agents"]`
 * - VS Code    : `<workspace>/.vscode/mcp.json`   -> `servers["m365-agents"]` (type "stdio")
 *
 * None of these files ever receives a secret: only the Node command, the CLI entry point and the
 * few `M365_AGENT_*` environment variables the broker/frontend need.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import lockfile from "proper-lockfile";

/** The server name used in every integration file. */
export const MCP_SERVER_NAME = "m365-agents";

export type IntegrationDefinition = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type CodexBlock = IntegrationDefinition & {
  startupTimeoutSec: number;
  toolTimeoutSec: number;
};

export type IntegrationSettings = {
  codex: boolean;
  claudeCode: boolean;
  vscodeMcpJson: boolean;
};

export type IntegrationKind = "codex" | "claudeCode" | "vscodeMcpJson";

export type IntegrationContext = {
  definition: IntegrationDefinition;
  /** Home directory used for `~/.codex/config.toml`. */
  homeDirectory: string;
  /** Absolute path of the single workspace folder, when one is open. */
  workspaceRoot?: string;
};

export type IntegrationSummary = {
  /** Absolute paths that were written. */
  written: string[];
  /** Human readable reasons an enabled integration was not written. */
  skipped: string[];
};

/* ------------------------------------------------------------------ TOML */

/** TOML basic-string escaping (backslashes matter on Windows paths). */
function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function renderCodexBlock(block: CodexBlock, eol: string): string {
  const lines = [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(block.command)}`,
    `args = ${tomlArray(block.args)}`,
    `startup_timeout_sec = ${block.startupTimeoutSec}`,
    `tool_timeout_sec = ${block.toolTimeoutSec}`
  ];
  const entries = Object.entries(block.env ?? {});
  if (entries.length > 0) {
    lines.push("", `[mcp_servers.${MCP_SERVER_NAME}.env]`);
    for (const [key, value] of entries)
      lines.push(`${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)} = ${tomlString(value)}`);
  }
  return `${lines.join(eol)}${eol}`;
}

/**
 * Replaces the `[mcp_servers.m365-agents]` table (and any of its sub-tables) in `existing`, or
 * appends it when absent. Every other byte of the file is preserved, including comments,
 * formatting and line endings.
 */
export function mergeCodexConfigToml(existing: string, block: CodexBlock): string {
  const ast = parseTOML(existing);
  const before = getStaticTOMLValue(ast);
  const eol = /\r\n/.test(existing) ? "\r\n" : "\n";
  const rendered = renderCodexBlock(block, eol);
  const ranges: [number, number][] = [];
  let previousWasTarget = false;
  for (const node of ast.body[0].body) {
    const target =
      node.type === "TOMLTable" &&
      node.resolvedKey[0] === "mcp_servers" &&
      node.resolvedKey[1] === MCP_SERVER_NAME;
    if (target) {
      if (previousWasTarget) ranges[ranges.length - 1][1] = node.range[1];
      else ranges.push([...node.range]);
    }
    previousWasTarget = target;
  }
  let merged = existing;
  if (ranges.length === 0) {
    merged += `${existing && !existing.endsWith("\n") ? eol : ""}${existing ? eol : ""}${rendered}`;
  } else {
    // AST ranges cannot mistake table-looking text in multiline strings for a header.
    // Replace backwards so offsets remain valid. Unrelated tables remain byte-identical.
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [start, end] = ranges[i];
      merged = merged.slice(0, start) + (i === 0 ? rendered.trimEnd() : "") + merged.slice(end);
    }
  }
  const after = getStaticTOMLValue(parseTOML(merged));
  if (!isDeepStrictEqual(withoutCodexServer(before), withoutCodexServer(after)))
    throw new Error("Codex configuration update would change unrelated settings; file was not written.");
  const expected = getStaticTOMLValue(parseTOML(rendered));
  if (!isDeepStrictEqual(codexServer(after), codexServer(expected)))
    throw new Error("Codex configuration uses an unsupported server shape; file was not written.");
  return merged;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function codexServer(value: unknown): Record<string, unknown> | undefined {
  return objectValue(objectValue(objectValue(value)?.mcp_servers)?.[MCP_SERVER_NAME]);
}

function withoutCodexServer(value: unknown): unknown {
  const copy = structuredClone(value);
  const root = objectValue(copy);
  const servers = objectValue(root?.mcp_servers);
  if (root && servers) {
    delete servers[MCP_SERVER_NAME];
    if (Object.keys(servers).length === 0) delete root.mcp_servers;
  }
  return copy;
}

function parseCodexEntry(existing: string): { command?: string; args?: string[] } | undefined {
  const entry = codexServer(getStaticTOMLValue(parseTOML(existing)));
  if (!entry) return undefined;
  return {
    command: typeof entry.command === "string" ? entry.command : undefined,
    args:
      Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === "string")
        ? (entry.args as string[])
        : undefined
  };
}

/**
 * Reads `command`/`args` out of `mcpServers["m365-agents"]` (Claude Code) or
 * `servers["m365-agents"]` (VS Code). Throws the same "not plain JSON" / "not an object" errors as
 * `parseJsonObject` for an unparseable file -- callers decide what "unreadable" means for them.
 */
function parseJsonEntry(
  existing: string,
  kind: Extract<IntegrationKind, "claudeCode" | "vscodeMcpJson">
): { command?: string; args?: string[] } | undefined {
  const containerKey = kind === "claudeCode" ? "mcpServers" : "servers";
  const document = parseJsonObject(existing, kind === "claudeCode" ? ".mcp.json" : ".vscode/mcp.json");
  const container = document[containerKey];
  if (typeof container !== "object" || container === null || Array.isArray(container)) return undefined;
  const entry = (container as Record<string, unknown>)[MCP_SERVER_NAME];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  return {
    command: typeof record.command === "string" ? record.command : undefined,
    args: Array.isArray(record.args)
      ? record.args.filter((value): value is string => typeof value === "string")
      : undefined
  };
}

/**
 * True when `existingText` already has an `m365-agents` entry (for the given file `kind`) whose
 * `command`/`args` no longer match the extension's current `definition` -- i.e. a previous version
 * of the extension wrote this file and the extension has since moved (a different Node runtime was
 * resolved, or the install path changed). An unparseable file, or one with no `m365-agents` entry
 * at all, is never "stale": the former is left for `applyIntegrations`'s own Save-time error
 * reporting, and the latter has nothing to refresh (a first write only happens through an explicit
 * Save, never silently at activation).
 */
export function integrationNeedsRefresh(
  existingText: string,
  definition: IntegrationDefinition,
  kind: IntegrationKind
): boolean {
  let stored: { command?: string; args?: string[] } | undefined;
  try {
    stored = kind === "codex" ? parseCodexEntry(existingText) : parseJsonEntry(existingText, kind);
  } catch {
    return false;
  }
  if (!stored) return false;
  const argsMatch =
    stored.args !== undefined &&
    stored.args.length === definition.args.length &&
    stored.args.every((value, index) => value === definition.args[index]);
  return stored.command !== definition.command || !argsMatch;
}

/* ------------------------------------------------------------------ JSON */

function parseJsonObject(existing: string | undefined, file: string): Record<string, unknown> {
  if (existing === undefined || existing.trim().length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(existing);
  } catch {
    throw new Error(`${file} is not plain JSON (comments or trailing commas are not supported).`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${file} does not contain a JSON object.`);
  return value as Record<string, unknown>;
}

function nestedObject(container: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = container[key];
  if (typeof current === "object" && current !== null && !Array.isArray(current))
    return current as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  container[key] = created;
  return created;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function stdioEntry(definition: IntegrationDefinition, type?: string): Record<string, unknown> {
  return {
    ...(type ? { type } : {}),
    command: definition.command,
    args: [...definition.args],
    ...(definition.env && Object.keys(definition.env).length > 0 ? { env: { ...definition.env } } : {})
  };
}

/** Sets `mcpServers["m365-agents"]` in a Claude Code `.mcp.json`, preserving every other key. */
export function mergeClaudeMcpJson(existing: string | undefined, definition: IntegrationDefinition): string {
  const document = parseJsonObject(existing, ".mcp.json");
  nestedObject(document, "mcpServers")[MCP_SERVER_NAME] = stdioEntry(definition);
  return serialize(document);
}

/** Sets `servers["m365-agents"]` in a VS Code `.vscode/mcp.json`, preserving every other key. */
export function mergeVscodeMcpJson(existing: string | undefined, definition: IntegrationDefinition): string {
  const document = parseJsonObject(existing, ".vscode/mcp.json");
  nestedObject(document, "servers")[MCP_SERVER_NAME] = stdioEntry(definition, "stdio");
  return serialize(document);
}

/* ------------------------------------------------------------------ writers */

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Same-directory replacement, with an exclusive, durable backup of every changed original.
 * Serialize our writers and reject edits made since the merge input was read. */
async function writeFile(file: string, content: string, expected: string | undefined): Promise<void> {
  if (content === expected) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const release = await lockfile.lock(file, { realpath: false, retries: 0 });
  const temporary = `${file}.agentpicklink-${randomUUID()}.tmp`;
  try {
    const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink()))
      throw new Error("Integration configuration must be a regular file.");
    if ((await readIfPresent(file)) !== expected)
      throw new Error("Integration configuration changed during update; please retry.");
    const writeSynced = async (target: string, text: string, mode: number) => {
      const handle = await fs.open(target, "wx", mode);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    await writeSynced(temporary, content, info ? info.mode & 0o777 : 0o600);
    if (expected !== undefined)
      await writeSynced(`${file}.agentpicklink-${randomUUID()}.bak`, expected, 0o600);
    if ((await readIfPresent(file)) !== expected)
      throw new Error("Integration configuration changed during update; please retry.");
    await fs.rename(temporary, file);
  } finally {
    try {
      await fs.rm(temporary, { force: true });
    } finally {
      await release();
    }
  }
}

/**
 * Writes the files for the enabled integrations only. A failure on one integration is reported in
 * `skipped` and never prevents the others (or the rest of Save) from completing.
 */
export async function applyIntegrations(
  context: IntegrationContext,
  settings: IntegrationSettings
): Promise<IntegrationSummary> {
  const summary: IntegrationSummary = { written: [], skipped: [] };
  const run = async (file: string, produce: (existing: string | undefined) => string): Promise<void> => {
    try {
      const existing = await readIfPresent(file);
      await writeFile(file, produce(existing), existing);
      summary.written.push(file);
    } catch (error) {
      summary.skipped.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (settings.codex) {
    const file = path.join(context.homeDirectory, ".codex", "config.toml");
    await run(file, (existing) =>
      mergeCodexConfigToml(existing ?? "", {
        ...context.definition,
        startupTimeoutSec: 60,
        toolTimeoutSec: 900
      })
    );
  }
  if (settings.claudeCode) {
    if (!context.workspaceRoot) summary.skipped.push(".mcp.json: no workspace folder is open.");
    else
      await run(path.join(context.workspaceRoot, ".mcp.json"), (existing) =>
        mergeClaudeMcpJson(existing, context.definition)
      );
  }
  if (settings.vscodeMcpJson) {
    if (!context.workspaceRoot) summary.skipped.push(".vscode/mcp.json: no workspace folder is open.");
    else
      await run(path.join(context.workspaceRoot, ".vscode", "mcp.json"), (existing) =>
        mergeVscodeMcpJson(existing, context.definition)
      );
  }
  return summary;
}

export type IntegrationRefreshSummary = {
  /** Absolute paths of files whose `m365-agents` entry was rewritten in place. */
  refreshed: string[];
};

/**
 * P1-9: called once at activation (never during Save, which always writes unconditionally via
 * `applyIntegrations` above) to re-synchronize an *already existing* `m365-agents` entry left by a
 * previous version of the extension -- e.g. the extension moved install paths, or the resolved Node
 * runtime changed -- so upgrading silently does not leave Codex/Claude Code/VS Code pointed at a
 * stale `dist/cli/index.js`. Disabled integrations, and files/entries that do not exist yet, are
 * left completely untouched: this never creates a first-time entry, only repairs a stale one.
 */
export async function refreshStaleIntegrations(
  context: IntegrationContext,
  settings: IntegrationSettings
): Promise<IntegrationRefreshSummary> {
  const refreshed: string[] = [];
  const maybeRefresh = async (
    file: string,
    kind: IntegrationKind,
    produce: (existing: string) => string
  ): Promise<void> => {
    try {
      const existing = await readIfPresent(file);
      if (existing === undefined) return;
      if (!integrationNeedsRefresh(existing, context.definition, kind)) return;
      await writeFile(file, produce(existing), existing);
      refreshed.push(file);
    } catch {
      // Never fail activation over a stale-integration refresh; a real problem with the file
      // surfaces the next time the user presses Save, through applyIntegrations' own reporting.
    }
  };

  if (settings.codex)
    await maybeRefresh(path.join(context.homeDirectory, ".codex", "config.toml"), "codex", (existing) =>
      mergeCodexConfigToml(existing, { ...context.definition, startupTimeoutSec: 60, toolTimeoutSec: 900 })
    );
  if (settings.claudeCode && context.workspaceRoot)
    await maybeRefresh(path.join(context.workspaceRoot, ".mcp.json"), "claudeCode", (existing) =>
      mergeClaudeMcpJson(existing, context.definition)
    );
  if (settings.vscodeMcpJson && context.workspaceRoot)
    await maybeRefresh(path.join(context.workspaceRoot, ".vscode", "mcp.json"), "vscodeMcpJson", (existing) =>
      mergeVscodeMcpJson(existing, context.definition)
    );
  return { refreshed };
}
