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

/** Splits a TOML table header (`[a.b."c"]`) into its key path, or `undefined` when not a header. */
function tableHeaderPath(line: string): string[] | undefined {
  const match = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line.replace(/\r?\n$/, ""));
  if (!match || match[1].startsWith("[")) return undefined;
  const segments: string[] = [];
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/g;
  let consumed = 0;
  let token: RegExpExecArray | null;
  while ((token = pattern.exec(match[1])) !== null) {
    segments.push(token[1] !== undefined ? token[1].replace(/\\(.)/g, "$1") : (token[2] ?? token[3]));
    consumed = pattern.lastIndex;
    if (token[4] !== ".") break;
  }
  return consumed === match[1].length && segments.length > 0 ? segments : undefined;
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
    for (const [key, value] of entries) lines.push(`${key} = ${tomlString(value)}`);
  }
  return `${lines.join(eol)}${eol}`;
}

/**
 * Replaces the `[mcp_servers.m365-agents]` table (and any of its sub-tables) in `existing`, or
 * appends it when absent. Every other byte of the file is preserved, including comments,
 * formatting and line endings.
 */
export function mergeCodexConfigToml(existing: string, block: CodexBlock): string {
  const eol = /\r\n/.test(existing) ? "\r\n" : "\n";
  const rendered = renderCodexBlock(block, eol);
  if (existing.trim().length === 0) return rendered;

  // Keep terminators attached so the untouched parts stay byte-identical.
  const lines = existing.split(/(?<=\n)/);
  const kept: string[] = [];
  let insertAt: number | undefined;
  let dropping = false;
  for (const line of lines) {
    const header = tableHeaderPath(line);
    if (header) {
      dropping = header[0] === "mcp_servers" && header[1] === MCP_SERVER_NAME;
      if (dropping && insertAt === undefined) insertAt = kept.length;
    }
    if (!dropping) kept.push(line);
  }

  if (insertAt === undefined) {
    const head = existing.endsWith(eol) ? existing : `${existing}${eol}`;
    return `${head}${eol}${rendered}`;
  }
  // Trim the blank lines that belonged to the removed table so repeated writes are stable.
  let end = insertAt;
  while (end > 0 && kept[end - 1].trim() === "") end -= 1;
  const before = kept.slice(0, end).join("");
  const after = kept.slice(insertAt).join("");
  const separator = before.length === 0 ? "" : before.endsWith(eol) ? eol : `${eol}${eol}`;
  return `${before}${separator}${rendered}${after.length === 0 ? "" : eol}${after}`;
}

/** Reverses `tomlString()` for the narrow subset this file ever writes (backslash/quote/n/r/t
 * escapes only). Returns `undefined` for anything that is not a single basic string literal. */
function parseTomlStringLiteral(raw: string): string | undefined {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(raw.trim());
  if (!match) return undefined;
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
  return match[1].replace(/\\(.)/g, (_, char: string) => escapes[char] ?? char);
}

/** Reverses `tomlArray()` for an array of basic string literals only (which is all this file ever
 * writes for `args`). Returns `undefined` when the raw text is not `[...]`-shaped. */
function parseTomlStringArray(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1);
  if (inner.trim().length === 0) return [];
  const values: string[] = [];
  const pattern = /"(?:[^"\\]|\\.)*"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) values.push(parseTomlStringLiteral(match[0]) ?? "");
  return values;
}

/**
 * Reads `command`/`args` out of the `[mcp_servers.m365-agents]` table only (never its `.env`
 * sub-table, which cannot hold either field this file writes). Returns `undefined` when the table
 * itself is absent -- as opposed to present but missing a field, which returns `{}`-shaped values
 * (both fields `undefined`) so a caller can still tell "entry exists but looks nothing like ours"
 * from "entry does not exist at all".
 */
function parseCodexEntry(existing: string): { command?: string; args?: string[] } | undefined {
  let inTargetTable = false;
  let found = false;
  let command: string | undefined;
  let args: string[] | undefined;
  for (const line of existing.split(/\r?\n/)) {
    const header = tableHeaderPath(line);
    if (header) {
      inTargetTable = header.length === 2 && header[0] === "mcp_servers" && header[1] === MCP_SERVER_NAME;
      if (inTargetTable) found = true;
      continue;
    }
    if (!inTargetTable) continue;
    const commandMatch = /^\s*command\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (commandMatch) command = parseTomlStringLiteral(commandMatch[1]);
    const argsMatch = /^\s*args\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (argsMatch) args = parseTomlStringArray(argsMatch[1]);
  }
  return found ? { command, args } : undefined;
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

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
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
      await writeFile(file, produce(await readIfPresent(file)));
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
      await writeFile(file, produce(existing));
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
