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
import { execFile } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import lockfile from "proper-lockfile";

const execFileAsync = promisify(execFile);
const defaultExec = async (command: string, args: string[]): Promise<{ stdout: string }> =>
  execFileAsync(command, args, { windowsHide: true, timeout: 15_000 });
/** §P2: how much of a failed vendor-CLI call's error text may reach a `summary.skipped` line. */
const MAX_CLAUDE_CLI_ERROR_CHARS = 200;

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_CLAUDE_CLI_ERROR_CHARS
    ? `${message.slice(0, MAX_CLAUDE_CLI_ERROR_CHARS)}…`
    : message;
}

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
  /** The opt-in project-scope `<workspace>/.mcp.json` writer (CLI token `claude-project`). */
  claudeCode: boolean;
  /** The opt-in workspace `.vscode/mcp.json` writer (CLI token `vscode-workspace`). */
  vscodeMcpJson: boolean;
  /** §4.4 user-profile `mcp.json` writer -- the default `vscode`/`vscode-user` CLI token. Optional
   * so every existing caller (which never enables it) keeps compiling unchanged. */
  vscodeUser?: boolean;
  /** §4.4/CLI user-scope Claude Code writer -- the default `claude`/`claude-user` CLI token.
   * Prefers `claude mcp add-json ... --scope user` (`IntegrationContext.claudeCliAvailable`/`exec`)
   * and falls back to editing `~/.claude.json`'s `mcpServers["m365-agents"]` directly. Optional for
   * the same reason as `vscodeUser`. */
  claudeUser?: boolean;
};

export type IntegrationKind = "codex" | "claudeCode" | "vscodeMcpJson" | "vscodeUser" | "claudeUser";

/**
 * §4.7 C9: the absolute prefixes a workspace-file writer substitutes for a host-supported
 * variable, when the definition's `command`/`args` start with one of them. Both are optional and
 * independently checked (`localAppData` first, since it is the more specific of the two on
 * Windows) so a caller can supply whichever it can actually resolve. Never derived from
 * `M365_AGENT_INSTALL_ROOT` (a GUI-launched host does not inherit shell exports) -- callers
 * compute these from `%LOCALAPPDATA%`/the home directory themselves (see
 * `integrationVariablesFor` in `install-home.ts`).
 */
export type IntegrationVariables = {
  /** Absolute `%LOCALAPPDATA%` on this machine (Windows only). */
  localAppData?: string;
  /** Absolute home directory. */
  userHome?: string;
};

export type IntegrationContext = {
  definition: IntegrationDefinition;
  /** Home directory used for `~/.codex/config.toml`. */
  homeDirectory: string;
  /** Absolute path of the single workspace folder, when one is open. */
  workspaceRoot?: string;
  /** §4.7 C9: when given, `mergeVscodeMcpJson`/`mergeClaudeMcpJson` substitute the matching
   * variable form for `definition`'s `command`/`args` prefix instead of writing the literal
   * absolute path, and `mergeCodexConfigToml` adds a `# machine-specific` comment above the table.
   * `integrationEntryStatus`/`integrationNeedsRefresh` expand a stored variable form back to the
   * literal path before comparing, so a file written this way reads back as current, not stale. */
  variables?: IntegrationVariables;
  /** §4.4: the VS Code user-profile directory (default profile only) to write `mcp.json` into for
   * the `vscodeUser` integration. `undefined` (or a directory that turns out not to exist) makes
   * the `vscodeUser` writer/remover skip with a reason instead of writing/removing anything. */
  vscodeUserDirectory?: string;
  /** §4.7 C14: `env` keys `refreshStaleIntegrations` compares in addition to `command`/`args`, so a
   * workspace whose identity is unchanged but whose cache-busting stamp is stale still gets
   * re-stamped. `install` passes `["M365_AGENT_MANAGED", "M365_AGENT_BUILD"]`; the extension passes
   * nothing, keeping its own "only the identity matters" semantics unchanged. */
  compareEnvKeys?: readonly string[];
  /** §4.4/CLI `claudeUser` writer: true when `claude` was detected on PATH (see
   * `client-detection.ts`'s `isClaudeCliOnPath`), so the writer prefers `claude mcp add-json ...
   * --scope user` (verified with `claude mcp get ...`) over editing `~/.claude.json` directly. Both
   * paths target the very same file/key (`claude mcp add-json --scope user` itself persists into
   * `~/.claude.json`'s `mcpServers`), so ownership classification always reads that file regardless
   * of which path wrote it. `undefined`/`false` always uses the direct file edit. */
  claudeCliAvailable?: boolean;
  /** Runs the `claude` vendor CLI for the `claudeUser` writer/remover; injectable so no test ever
   * execs a real binary. Defaults to a real `execFile` when omitted -- callers that never enable
   * `claudeUser` need supply neither this nor `claudeCliAvailable`. */
  exec?: (command: string, args: string[]) => Promise<{ stdout: string }>;
};

export type IntegrationSummary = {
  /** Absolute paths that were written. */
  written: string[];
  /** Human readable reasons an enabled integration was not written. */
  skipped: string[];
  /** Human readable notes about a file that *was* written -- currently only the `vscodeUser`
   * writer's "this entry used to point at another workspace" (§P2). Optional so the callers that
   * build a summary themselves keep compiling. */
  warnings?: string[];
};

/* ------------------------------------------------------------- §4.7 C9 variable forms */

type VariableTokens = { localAppData: string; userHome: string };

/** VS Code's MCP configuration reference: `${env:LOCALAPPDATA}` (Windows), `${userHome}`
 * (macOS/Linux). */
const VSCODE_TOKENS: VariableTokens = { localAppData: "${env:LOCALAPPDATA}", userHome: "${userHome}" };
/** Claude Code's `.mcp.json` variable expansion: `${LOCALAPPDATA}` / `${HOME}`. */
const CLAUDE_TOKENS: VariableTokens = { localAppData: "${LOCALAPPDATA}", userHome: "${HOME}" };

/** Only `vscodeMcpJson`/`claudeCode` get variable substitution: `vscodeUser` writes a per-machine
 * user profile that is never shared between teammates, and Codex TOML documents no expansion at
 * all (it gets the `# machine-specific` comment instead -- see `renderCodexBlock`). */
function tokensFor(kind: IntegrationKind): VariableTokens | undefined {
  if (kind === "vscodeMcpJson") return VSCODE_TOKENS;
  if (kind === "claudeCode") return CLAUDE_TOKENS;
  return undefined;
}

/** A drive-letter root (`C:\\`, `C:/`) or a UNC share -- the two shapes whose comparison has to
 * follow Windows rules (case-insensitive, `/` and `\\` interchangeable). Decided from the strings
 * themselves rather than `process.platform`, so a Windows-written file is classified the same way
 * wherever this module runs (including the tests, which exercise win32 paths from macOS). */
function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Drops trailing path separators, but never turns a path into the empty string (`"/"` stays). */
function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, "") || value;
}

/**
 * The part of `value` below `prefix` -- `""` for an exact match, a remainder that always starts
 * with a separator for a path underneath it, and `undefined` when `value` is neither. Returning
 * the remainder (rather than a bare boolean plus a `slice(prefix.length)` at the call site) is what
 * keeps `substituteVariable` correct when the two differ in case, in separator flavour, or in a
 * trailing separator on the prefix (§P2).
 */
function pathRemainder(value: string, prefix: string): string | undefined {
  if (!prefix) return undefined;
  const windows = isWindowsPath(value) && isWindowsPath(prefix);
  // `path.win32.resolve` normalizes separators and redundant segments without touching the disk;
  // both inputs are absolute here, so it never falls back to the (POSIX) working directory.
  const subject = windows ? path.win32.resolve(value) : value;
  const base = trimTrailingSeparators(windows ? path.win32.resolve(prefix) : prefix);
  const fold = (input: string): string => (windows ? input.toLowerCase() : input);
  if (fold(subject) === fold(base)) return "";
  if (!fold(subject).startsWith(fold(base))) return undefined;
  const remainder = subject.slice(base.length);
  return remainder.startsWith("/") || remainder.startsWith("\\") ? remainder : undefined;
}

function startsWithPath(value: string, prefix: string): boolean {
  return pathRemainder(value, prefix) !== undefined;
}

/** True when `value` (a `command` or one `args` entry) begins with either configured prefix --
 * used both to decide whether to substitute a variable and, for Codex, whether to add the
 * `# machine-specific` comment. */
function isHomeBased(value: string, variables: IntegrationVariables | undefined): boolean {
  if (!variables) return false;
  return (
    (!!variables.localAppData && startsWithPath(value, variables.localAppData)) ||
    (!!variables.userHome && startsWithPath(value, variables.userHome))
  );
}

function substituteVariable(value: string, variables: IntegrationVariables, tokens: VariableTokens): string {
  if (variables.localAppData) {
    const remainder = pathRemainder(value, variables.localAppData);
    if (remainder !== undefined) return tokens.localAppData + remainder;
  }
  if (variables.userHome) {
    const remainder = pathRemainder(value, variables.userHome);
    if (remainder !== undefined) return tokens.userHome + remainder;
  }
  return value;
}

/** The inverse of `substituteVariable`. §P2: a token this machine has no value for (no
 * `%LOCALAPPDATA%` outside Windows, say) leaves the stored text exactly as it is -- expanding it
 * against an absent value would produce the literal string `"undefined\\..."` and then classify a
 * perfectly good entry as foreign. */
function expandVariable(value: string, variables: IntegrationVariables, tokens: VariableTokens): string {
  if (variables.localAppData !== undefined && value.startsWith(tokens.localAppData))
    return variables.localAppData + value.slice(tokens.localAppData.length);
  if (variables.userHome !== undefined && value.startsWith(tokens.userHome))
    return variables.userHome + value.slice(tokens.userHome.length);
  return value;
}

/** §4.7 C9/C12: expands one stored `command`/`args` value (as read out of a client file) back to
 * the literal path it names on this machine, for a caller that has to do something with the path
 * itself rather than compare it -- `doctor`'s `commandResolvable` probe, which must `access()` the
 * real binary and not the `${userHome}/...` text. A value with no variable form, an unknown token,
 * or a token this machine has no value for is returned unchanged. */
export function expandIntegrationValue(
  value: string,
  kind: IntegrationKind,
  variables?: IntegrationVariables
): string {
  const tokens = variables && tokensFor(kind);
  if (!tokens || !variables) return value;
  return expandVariable(value, variables, tokens);
}

/** Rewrites `definition`'s `command`/`args` to the variable form for `kind`, when `variables` is
 * given and a prefix actually matches (§4.7 C9). `env` is never touched: only launch fields the
 * host itself resolves (`command`/`args`) benefit from a variable, and `M365_AGENT_BUILD`/
 * `M365_AGENT_MANAGED` must remain literal for `install`'s own re-stamping to keep working. */
function withVariables(
  definition: IntegrationDefinition,
  kind: IntegrationKind,
  variables?: IntegrationVariables
): IntegrationDefinition {
  const tokens = variables && tokensFor(kind);
  if (!tokens || !variables) return definition;
  return {
    ...definition,
    command: substituteVariable(definition.command, variables, tokens),
    args: definition.args.map((value) => substituteVariable(value, variables, tokens))
  };
}

/** The inverse of `withVariables`, applied to a *parsed* on-disk entry before it is compared
 * against `definition` -- so a file written in variable form reads back as `"managed"`/current
 * rather than `"foreign"`/stale (`integrationEntryStatus`, `integrationNeedsRefresh`). */
function expandEntryVariables(
  entry: ParsedIntegrationEntry,
  kind: IntegrationKind,
  variables?: IntegrationVariables
): ParsedIntegrationEntry {
  const tokens = variables && tokensFor(kind);
  if (!tokens || !variables) return entry;
  return {
    ...entry,
    ...(entry.command !== undefined ? { command: expandVariable(entry.command, variables, tokens) } : {}),
    ...(entry.args !== undefined
      ? { args: entry.args.map((value) => expandVariable(value, variables, tokens)) }
      : {})
  };
}

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

/** §4.7 C9: Codex TOML documents no variable expansion, so a home-based command instead gets this
 * comment directly above the table -- a hint for an administrator who finds the file copied onto
 * another machine. */
const CODEX_MACHINE_SPECIFIC_COMMENT = "# machine-specific";

function renderCodexBlock(block: CodexBlock, eol: string, variables?: IntegrationVariables): string {
  // §P2: the launcher path lives in `args` (`<home>/bin/apl.js`), so an entry whose `command` is a
  // system Node but whose args point into `<home>` is just as machine-specific as one whose
  // command is `<home>/bin/node`.
  const machineSpecific =
    isHomeBased(block.command, variables) || block.args.some((value) => isHomeBased(value, variables));
  const lines = machineSpecific ? [CODEX_MACHINE_SPECIFIC_COMMENT] : [];
  lines.push(
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(block.command)}`,
    `args = ${tomlArray(block.args)}`,
    `startup_timeout_sec = ${block.startupTimeoutSec}`,
    `tool_timeout_sec = ${block.toolTimeoutSec}`
  );
  const entries = Object.entries(block.env ?? {});
  if (entries.length > 0) {
    lines.push("", `[mcp_servers.${MCP_SERVER_NAME}.env]`);
    for (const [key, value] of entries)
      lines.push(`${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)} = ${tomlString(value)}`);
  }
  return `${lines.join(eol)}${eol}`;
}

/** Widens a target table's range to swallow an immediately preceding `# machine-specific` comment
 * line (and its own line ending), so replacing the table on a later write does not accumulate a
 * duplicate of that comment -- `renderCodexBlock` above adds its own copy, once, when still
 * applicable. */
function withPrecedingMachineComment(text: string, start: number, eol: string): number {
  const marker = `${CODEX_MACHINE_SPECIFIC_COMMENT}${eol}`;
  const from = start - marker.length;
  return from >= 0 && text.slice(from, start) === marker ? from : start;
}

/**
 * Replaces the `[mcp_servers.m365-agents]` table (and any of its sub-tables) in `existing`, or
 * appends it when absent. Every other byte of the file is preserved, including comments,
 * formatting and line endings. `variables` is §4.7 C9's machine-specific marker only (Codex TOML
 * has no variable syntax to substitute into `command`/`args`).
 */
export function mergeCodexConfigToml(
  existing: string,
  block: CodexBlock,
  variables?: IntegrationVariables
): string {
  const ast = parseTOML(existing);
  const before = getStaticTOMLValue(ast);
  const eol = /\r\n/.test(existing) ? "\r\n" : "\n";
  const rendered = renderCodexBlock(block, eol, variables);
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
  if (ranges.length > 0) ranges[0][0] = withPrecedingMachineComment(existing, ranges[0][0], eol);
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

/** The shape every parser below returns: whatever of `command`/`args`/`env` the existing file's
 * `m365-agents` entry actually has, string-typed and nothing else. */
export type ParsedIntegrationEntry = { command?: string; args?: string[]; env?: Record<string, string> };

/** Keeps only the string-valued properties of a plain object -- used for an entry's `env` table,
 * which every writer here only ever populates with strings. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(record))
    if (typeof entryValue === "string") result[key] = entryValue;
  return result;
}

export function parseCodexEntry(existing: string): ParsedIntegrationEntry | undefined {
  const entry = codexServer(getStaticTOMLValue(parseTOML(existing)));
  if (!entry) return undefined;
  return {
    command: typeof entry.command === "string" ? entry.command : undefined,
    args:
      Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === "string")
        ? (entry.args as string[])
        : undefined,
    env: stringRecord(entry.env)
  };
}

/** JSON-file-based integration kinds: `claudeCode`/`claudeUser` use Claude Code's `mcpServers`
 * container, `vscodeMcpJson`/`vscodeUser` use VS Code's `servers` container. */
type JsonIntegrationKind = Extract<
  IntegrationKind,
  "claudeCode" | "vscodeMcpJson" | "vscodeUser" | "claudeUser"
>;

function containerKeyFor(kind: JsonIntegrationKind): "mcpServers" | "servers" {
  return kind === "claudeCode" || kind === "claudeUser" ? "mcpServers" : "servers";
}

/** The label used in this module's own "not plain JSON" / "not an object" error text -- purely
 * cosmetic (it never affects parsing or classification). */
function jsonFileLabel(kind: JsonIntegrationKind): string {
  if (kind === "claudeCode") return ".mcp.json";
  if (kind === "claudeUser") return "~/.claude.json";
  if (kind === "vscodeMcpJson") return ".vscode/mcp.json";
  return "mcp.json";
}

/**
 * Reads `command`/`args`/`env` out of `mcpServers["m365-agents"]` (Claude Code project file or the
 * user-scope `~/.claude.json` -- same container key, same shape, different location) or
 * `servers["m365-agents"]` (VS Code workspace file or user-profile `vscodeUser` file -- likewise).
 * Throws the same "not plain JSON" / "not an object" errors as `parseJsonObject` for an unparseable
 * file -- callers decide what "unreadable" means for them.
 */
export function parseJsonEntry(
  existing: string,
  kind: JsonIntegrationKind
): ParsedIntegrationEntry | undefined {
  const containerKey = containerKeyFor(kind);
  const document = parseJsonObject(existing, jsonFileLabel(kind));
  const container = document[containerKey];
  if (typeof container !== "object" || container === null || Array.isArray(container)) return undefined;
  const entry = (container as Record<string, unknown>)[MCP_SERVER_NAME];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  return {
    command: typeof record.command === "string" ? record.command : undefined,
    args: Array.isArray(record.args)
      ? record.args.filter((value): value is string => typeof value === "string")
      : undefined,
    env: stringRecord(record.env)
  };
}

/* ------------------------------------------------------------------ ownership classification */

export type IntegrationEntryStatus = "absent" | "managed" | "legacy" | "foreign";

/** True when `args`' last two elements are `[<entrypoint>, "serve"]` and the entrypoint ends with
 * one of the two shapes a pre-marker AgentPickLink ever wrote: the extension's own
 * `dist/cli/index.js` (0.1.x), or the archive's `bin/apl.js` (docs/extension-less-onboarding.md
 * §4.7 C6). Path-separator-agnostic so a Windows-written entry is recognized on any platform. */
function isLegacyEntrypoint(args: string[] | undefined): boolean {
  if (!args || args.length < 2) return false;
  if (args[args.length - 1] !== "serve") return false;
  const entry = args[args.length - 2].replace(/\\/g, "/");
  return entry.endsWith("dist/cli/index.js") || entry.endsWith("bin/apl.js");
}

function sameArgs(a: string[] | undefined, b: readonly string[]): boolean {
  return !!a && a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Ownership, independent of whether the entry matches any particular `IntegrationDefinition`:
 * `"managed"` carries the `M365_AGENT_MANAGED` marker (§4.7 C6); `"legacy"` has no marker but its
 * shape is one AgentPickLink itself used to write; anything else under the `m365-agents` key is
 * `"foreign"`. */
function classifyEntry(entry: ParsedIntegrationEntry | undefined): IntegrationEntryStatus {
  if (!entry) return "absent";
  if (entry.env?.M365_AGENT_MANAGED === "1") return "managed";
  if (isLegacyEntrypoint(entry.args)) return "legacy";
  return "foreign";
}

/**
 * `"absent"` (no `m365-agents` entry in this file), `"managed"` (carries the ownership marker),
 * `"legacy"` (a pre-marker AgentPickLink shape, or -- since a hand-copied or older entry can
 * already match today's identity byte-for-byte without ever having carried the marker -- one whose
 * `command`/`args` already equal `definition`), or `"foreign"` (anything else). An unparseable file
 * is reported `"absent"`: it has nothing this module can classify, and Save-time writing already
 * reports that failure on its own (see `applyIntegrations`).
 */
export function integrationEntryStatus(
  existingText: string,
  kind: IntegrationKind,
  definition: IntegrationDefinition,
  variables?: IntegrationVariables
): IntegrationEntryStatus {
  let entry: ParsedIntegrationEntry | undefined;
  try {
    entry = kind === "codex" ? parseCodexEntry(existingText) : parseJsonEntry(existingText, kind);
  } catch {
    return "absent";
  }
  const expanded = entry && expandEntryVariables(entry, kind, variables);
  const status = classifyEntry(expanded);
  if (status !== "foreign") return status;
  return expanded!.command === definition.command && sameArgs(expanded!.args, definition.args)
    ? "legacy"
    : "foreign";
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
  kind: IntegrationKind,
  variables?: IntegrationVariables,
  compareEnvKeys?: readonly string[]
): boolean {
  let stored: ParsedIntegrationEntry | undefined;
  try {
    stored = kind === "codex" ? parseCodexEntry(existingText) : parseJsonEntry(existingText, kind);
  } catch {
    return false;
  }
  if (!stored) return false;
  const expanded = expandEntryVariables(stored, kind, variables);
  const argsMatch =
    expanded.args !== undefined &&
    expanded.args.length === definition.args.length &&
    expanded.args.every((value, index) => value === definition.args[index]);
  if (expanded.command !== definition.command || !argsMatch) return true;
  // §4.7 C14: with a version-independent identity, `command`/`args` no longer change across
  // versions, so a caller that re-stamps `M365_AGENT_BUILD` has to be able to say "compare these
  // env keys too" -- otherwise a workspace recorded in `install.json` but not named on this run
  // would keep VS Code's cached tool list forever.
  return (compareEnvKeys ?? []).some((key) => expanded.env?.[key] !== definition.env?.[key]);
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

/** Only used by `setJsonMember`'s fast path below, when there is no pre-existing text worth
 * preserving (the file does not exist yet, or is blank) -- everywhere else a document already has
 * bytes to preserve, see the position-aware scanner further down. */
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

function stdioEntry(
  definition: IntegrationDefinition,
  type?: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(type ? { type } : {}),
    command: definition.command,
    args: [...definition.args],
    ...(extra ?? {}),
    ...(definition.env && Object.keys(definition.env).length > 0 ? { env: { ...definition.env } } : {})
  };
}

/* -------------------------------------------------- ISSUE-02: position-aware JSON scanner
 *
 * `JSON.parse()` + `JSON.stringify()` re-flows the *whole* document on every write (see the
 * `serialize()` fast path above, still used when there is no pre-existing text at all): removing or
 * adding `m365-agents` changed every other entry's spacing even though its key order and values
 * stayed the same (docs/validation-log-2026-09-14-windows.md's `ISSUE-2026-09-14-02`). Below is a
 * small recursive-descent JSON scanner -- exactly like `mergeCodexConfigToml`'s TOML-AST range
 * replacement above, but hand-rolled since there is no permissive JSON.stringify()`, whose own
 * newlines are then reindented onto the file's own indentation before splicing in. JSON has no
 * comments and no trailing commas, so once `JSON.parse` (via `parseJsonObject`) already accepted the
 * text, the grammar is completely unambiguous -- this only ever runs on text already known to be
 * valid.
 */

type JsonRange = readonly [number, number];

type JsonMember = {
  key: string;
  keyRange: JsonRange;
  value: JsonNode;
  /** `"key": value`, excluding any separating comma/whitespace on either side -- what a
   * merge/replace touches; a remove additionally has to fix up a neighbouring comma (see
   * `memberRemovalRange`). */
  entryRange: JsonRange;
};

type JsonNode =
  | { kind: "object"; range: JsonRange; members: JsonMember[]; commas: readonly number[] }
  | { kind: "other"; range: JsonRange };

type JsonObjectNode = Extract<JsonNode, { kind: "object" }>;

function isJsonWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function skipJsonWhitespace(text: string, at: number): number {
  let i = at;
  while (i < text.length && isJsonWhitespace(text[i])) i++;
  return i;
}

/** `text[at]` is the opening `"`. Returns the index right after the matching closing `"`. */
function skipJsonString(text: string, at: number): number {
  let i = at + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  throw new Error(`Unterminated JSON string at offset ${at}`);
}

/** Decodes the JSON string literal at `text.slice(...range)` -- used only for a member's own key
 * (to compare it against `servers`/`mcpServers`/`m365-agents`), never for a value: every other kind
 * of node is only ever skipped over as an opaque span (`scanJsonValue`), never inspected. */
function decodeJsonString(text: string, range: JsonRange): string {
  return JSON.parse(text.slice(range[0], range[1])) as string;
}

function scanJsonArrayEnd(text: string, at: number): number {
  let i = skipJsonWhitespace(text, at + 1);
  if (text[i] === "]") return i + 1;
  for (;;) {
    const value = scanJsonValue(text, i);
    i = skipJsonWhitespace(text, value.range[1]);
    if (text[i] === ",") {
      i = skipJsonWhitespace(text, i + 1);
      continue;
    }
    if (text[i] === "]") return i + 1;
    throw new Error(`Malformed JSON array at offset ${i}`);
  }
}

/** Parses one JSON value at `at`. Only an object's own direct members are ever addressed by this
 * module (`mcpServers`/`servers`, then `m365-agents`), so every other kind (array/string/number/
 * literal) is scanned only far enough to find its end, as an opaque `"other"` span. */
function scanJsonValue(text: string, at: number): JsonNode {
  const ch = text[at];
  if (ch === "{") return scanJsonObject(text, at);
  if (ch === "[") return { kind: "other", range: [at, scanJsonArrayEnd(text, at)] };
  if (ch === '"') return { kind: "other", range: [at, skipJsonString(text, at)] };
  let i = at;
  while (i < text.length && !",}] \t\r\n".includes(text[i])) i++;
  if (i === at) throw new Error(`Malformed JSON at offset ${at}`);
  return { kind: "other", range: [at, i] };
}

/** `text[at]` is the opening `{`. */
function scanJsonObject(text: string, at: number): JsonObjectNode {
  let i = skipJsonWhitespace(text, at + 1);
  const members: JsonMember[] = [];
  const commas: number[] = [];
  if (text[i] === "}") return { kind: "object", range: [at, i + 1], members, commas };
  for (;;) {
    const keyStart = i;
    if (text[i] !== '"') throw new Error(`Malformed JSON object at offset ${i} (expected a key)`);
    const keyEnd = skipJsonString(text, i);
    const key = decodeJsonString(text, [keyStart, keyEnd]);
    let j = skipJsonWhitespace(text, keyEnd);
    if (text[j] !== ":") throw new Error(`Malformed JSON object at offset ${j} (expected ':')`);
    j = skipJsonWhitespace(text, j + 1);
    const value = scanJsonValue(text, j);
    members.push({ key, keyRange: [keyStart, keyEnd], value, entryRange: [keyStart, value.range[1]] });
    i = skipJsonWhitespace(text, value.range[1]);
    if (text[i] === ",") {
      commas.push(i);
      i = skipJsonWhitespace(text, i + 1);
      continue;
    }
    if (text[i] === "}") {
      i += 1;
      break;
    }
    throw new Error(`Malformed JSON object at offset ${i}`);
  }
  return { kind: "object", range: [at, i], members, commas };
}

function scanJsonDocument(text: string): JsonNode {
  return scanJsonValue(text, skipJsonWhitespace(text, 0));
}

function asJsonObject(node: JsonNode): JsonObjectNode | undefined {
  return node.kind === "object" ? node : undefined;
}

/** The *last* member named `key` (mirroring `JSON.parse`'s own last-write-wins semantics for a
 * document with a duplicate key -- vanishingly rare, but this is the only correct choice when it
 * happens), or `-1`. */
function lastMemberIndex(members: readonly JsonMember[], key: string): number {
  for (let i = members.length - 1; i >= 0; i--) if (members[i].key === key) return i;
  return -1;
}

/** The indentation (spaces/tabs only) at the start of the line containing `at`, or `""` when `at`
 * is not the first non-whitespace character on its line (a minified or single-line document, most
 * often) -- preferred over a freshly computed indentation wherever an existing sibling's own line
 * can be reused verbatim instead. */
function lineIndentAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const prefix = text.slice(lineStart, at);
  return /^[ \t]*$/.test(prefix) ? prefix : "";
}

function detectEol(text: string): string {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}

/** One nesting level's worth of indentation, guessed from the first indented `"key":` line in the
 * file -- two spaces (this module's own long-standing default, matching `serialize()` above) when
 * nothing is found, e.g. a single-line or still-empty document. */
function detectIndentUnit(text: string): string {
  const match = /\n([ \t]+)"/.exec(text);
  return match ? match[1] : "  ";
}

/** Renders `"<key>": <value>`, with `value`'s own nested lines (courtesy of `JSON.stringify`'s
 * `indentUnit`) each additionally prefixed by `indent` -- ready to be spliced in at a position
 * already at column `indent.length`, using the file's own `eol`. */
function renderJsonMember(
  key: string,
  value: unknown,
  indentUnit: string,
  indent: string,
  eol: string
): string {
  const rendered = JSON.stringify(value, undefined, indentUnit) ?? "null";
  const text = `${JSON.stringify(key)}: ${rendered.replace(/\n/g, `\n${indent}`)}`;
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

function spliceRange(text: string, range: JsonRange, replacement: string): string {
  return text.slice(0, range[0]) + replacement + text.slice(range[1]);
}

/**
 * Range to splice out to delete member `index` of `object.members`, fixing up whichever
 * neighbouring comma keeps the document valid: the member's own trailing comma when a sibling
 * follows it, otherwise (it is the last member) the comma that precedes it. A lone member takes
 * neither -- deleting it leaves the bare `{}` the object started with (modulo whitespace).
 */
function memberRemovalRange(object: JsonObjectNode, index: number): JsonRange {
  const openEnd = object.range[0] + 1;
  const closeStart = object.range[1] - 1;
  if (object.members.length === 1) return [openEnd, closeStart];
  if (index === object.members.length - 1) return [object.commas[index - 1], closeStart];
  const start = index === 0 ? openEnd : object.commas[index - 1] + 1;
  return [start, object.commas[index] + 1];
}

/** Where (and with how much indentation) a *new*, last property belongs in `object`: a genuinely
 * empty `{}` needs a fresh `eol`+indent pair of its own (one level deeper than `outerIndent`, the
 * indentation of `object`'s own line); anything else reuses its current last member's own
 * indentation verbatim, so the new property lines up with its new siblings exactly. */
function insertionIndent(
  text: string,
  object: JsonObjectNode,
  outerIndent: string,
  indentUnit: string
): { memberIndent: string; closeIndent: string } {
  if (object.members.length === 0)
    return { memberIndent: `${outerIndent}${indentUnit}`, closeIndent: outerIndent };
  const last = object.members[object.members.length - 1];
  return {
    memberIndent: lineIndentAt(text, last.keyRange[0]) || `${outerIndent}${indentUnit}`,
    closeIndent: outerIndent
  };
}

/** Inserts `renderedMember` (from `renderJsonMember`, no leading/trailing comma of its own) as the
 * *last* property of `object`, per `indent` (from `insertionIndent`, computed -- and rendered into
 * `renderedMember` -- by the caller so both agree on the exact same indentation). */
function insertLastMember(
  text: string,
  object: JsonObjectNode,
  renderedMember: string,
  eol: string,
  indent: { memberIndent: string; closeIndent: string }
): string {
  if (object.members.length === 0)
    return spliceRange(
      text,
      [object.range[0] + 1, object.range[1] - 1],
      `${eol}${indent.memberIndent}${renderedMember}${eol}${indent.closeIndent}`
    );
  const last = object.members[object.members.length - 1];
  return spliceRange(
    text,
    [last.value.range[1], last.value.range[1]],
    `,${eol}${indent.memberIndent}${renderedMember}`
  );
}

/** `value` with `containerKey[MCP_SERVER_NAME]` removed (and `containerKey` itself dropped once
 * that empties it) -- the "everything else" side of the before/after equality check every writer
 * below runs prior to returning its result, mirroring `mergeCodexConfigToml`'s `withoutCodexServer`. */
function withoutJsonMember(value: Record<string, unknown>, containerKey: string): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  const container = objectValue(copy[containerKey]);
  if (container) {
    delete container[MCP_SERVER_NAME];
    if (Object.keys(container).length === 0) delete copy[containerKey];
  }
  return copy;
}

/**
 * Sets `<containerKey>[MCP_SERVER_NAME]` to `value` in `existing`'s text, preserving every other
 * byte of the file -- JSON has no comments, so formatting/whitespace/key order is all that is ever
 * at stake. `existing` missing or blank has nothing to preserve, so that case still goes through the
 * original `JSON.parse` + `JSON.stringify` document rebuild (`serialize()` above). Throws (refusing
 * to write) if the result would change anything besides that one member, or if the member ends up a
 * different shape than `value` -- the same safety net `mergeCodexConfigToml` has for TOML.
 */
function setJsonMember(
  existing: string | undefined,
  file: string,
  containerKey: "mcpServers" | "servers",
  value: Record<string, unknown>
): string {
  const before = parseJsonObject(existing, file);
  if (existing === undefined || existing.trim().length === 0) {
    nestedObject(before, containerKey)[MCP_SERVER_NAME] = value;
    return serialize(before);
  }
  const root = asJsonObject(scanJsonDocument(existing));
  if (!root) throw new Error(`${file} does not contain a JSON object.`);
  const eol = detectEol(existing);
  const indentUnit = detectIndentUnit(existing);
  const containerIndex = lastMemberIndex(root.members, containerKey);
  const containerMember = containerIndex === -1 ? undefined : root.members[containerIndex];
  const container = containerMember ? asJsonObject(containerMember.value) : undefined;
  let merged: string;
  if (containerMember && !container) {
    // A non-object value for the container key (e.g. a stray `"servers": null`) -- replace it
    // wholesale, mirroring `nestedObject()`'s own fallback (a fresh `{}`) on the fast path above.
    const outerIndent = lineIndentAt(existing, containerMember.keyRange[0]);
    const indent = `${outerIndent}${indentUnit}`;
    const rendered = renderJsonMember(MCP_SERVER_NAME, value, indentUnit, indent, eol);
    const replacement = `${JSON.stringify(containerKey)}: {${eol}${indent}${rendered}${eol}${outerIndent}}`;
    merged = spliceRange(existing, containerMember.entryRange, replacement);
  } else if (container) {
    const memberIndex = lastMemberIndex(container.members, MCP_SERVER_NAME);
    const outerIndent = lineIndentAt(existing, containerMember!.keyRange[0]);
    if (memberIndex !== -1) {
      const existingMember = container.members[memberIndex];
      const indent = lineIndentAt(existing, existingMember.keyRange[0]) || `${outerIndent}${indentUnit}`;
      merged = spliceRange(
        existing,
        existingMember.entryRange,
        renderJsonMember(MCP_SERVER_NAME, value, indentUnit, indent, eol)
      );
    } else {
      const indent = insertionIndent(existing, container, outerIndent, indentUnit);
      const rendered = renderJsonMember(MCP_SERVER_NAME, value, indentUnit, indent.memberIndent, eol);
      merged = insertLastMember(existing, container, rendered, eol, indent);
    }
  } else {
    // No `mcpServers`/`servers` key at all yet: create the container itself as the last top-level
    // property, with `m365-agents` as its own only member.
    const rootIndent = insertionIndent(existing, root, "", indentUnit);
    const nestedIndent = `${rootIndent.memberIndent}${indentUnit}`;
    const nestedRendered = renderJsonMember(MCP_SERVER_NAME, value, indentUnit, nestedIndent, eol);
    const containerText = `{${eol}${nestedIndent}${nestedRendered}${eol}${rootIndent.memberIndent}}`;
    merged = insertLastMember(
      existing,
      root,
      `${JSON.stringify(containerKey)}: ${containerText}`,
      eol,
      rootIndent
    );
  }
  const after = parseJsonObject(merged, file);
  if (!isDeepStrictEqual(withoutJsonMember(before, containerKey), withoutJsonMember(after, containerKey)))
    throw new Error(`${file} update would change unrelated settings; file was not written.`);
  if (!isDeepStrictEqual(objectValue(after[containerKey])?.[MCP_SERVER_NAME], value))
    throw new Error(`${file} update produced an unexpected shape; file was not written.`);
  return merged;
}

/**
 * Deletes `<containerKey>[MCP_SERVER_NAME]` from `existing`'s text, fixing up the neighbouring
 * comma (`memberRemovalRange`) so the document stays valid -- every other byte is untouched. A
 * no-op (returns `existing` unchanged) when there is nothing to remove, matching
 * `removeCodexConfigToml`'s own contract below.
 */
function deleteJsonMember(existing: string, file: string, containerKey: "mcpServers" | "servers"): string {
  const before = parseJsonObject(existing, file);
  const root = asJsonObject(scanJsonDocument(existing));
  if (!root) throw new Error(`${file} does not contain a JSON object.`);
  const containerMember = root.members[lastMemberIndex(root.members, containerKey)];
  const container = containerMember ? asJsonObject(containerMember.value) : undefined;
  if (!container) return existing;
  const memberIndex = lastMemberIndex(container.members, MCP_SERVER_NAME);
  if (memberIndex === -1) return existing;
  const removed = spliceRange(existing, memberRemovalRange(container, memberIndex), "");
  const after = parseJsonObject(removed, file);
  if (!isDeepStrictEqual(withoutJsonMember(before, containerKey), withoutJsonMember(after, containerKey)))
    throw new Error(`${file} update would change unrelated settings; file was not written.`);
  return removed;
}

/** Sets `mcpServers["m365-agents"]` in a Claude Code `.mcp.json`, preserving every other byte.
 * §4.7 C9: when `definition`'s `command`/`args` start with `variables.localAppData`/`userHome`,
 * writes `${LOCALAPPDATA}`/`${HOME}` instead of the literal absolute path. */
export function mergeClaudeMcpJson(
  existing: string | undefined,
  definition: IntegrationDefinition,
  variables?: IntegrationVariables
): string {
  return setJsonMember(
    existing,
    ".mcp.json",
    "mcpServers",
    stdioEntry(withVariables(definition, "claudeCode", variables))
  );
}

/** Sets `servers["m365-agents"]` in a VS Code `.vscode/mcp.json`, preserving every other byte.
 * §4.7 C9: when `definition`'s `command`/`args` start with `variables.localAppData`/`userHome`,
 * writes `${env:LOCALAPPDATA}`/`${userHome}` instead of the literal absolute path. */
export function mergeVscodeMcpJson(
  existing: string | undefined,
  definition: IntegrationDefinition,
  variables?: IntegrationVariables
): string {
  return setJsonMember(
    existing,
    ".vscode/mcp.json",
    "servers",
    stdioEntry(withVariables(definition, "vscodeMcpJson", variables), "stdio")
  );
}

/** Sets `servers["m365-agents"]` in the VS Code *user-profile* `mcp.json` (§4.4, default profile
 * only, the default `vscode`/`vscode-user` writer). No `cwd`: VS Code defaults a file-defined
 * stdio server's `cwd` to the workspace folder when it runs in one, so a single per-machine entry
 * correctly serves whichever workspace is open -- an explicit `cwd` here would instead pin every
 * workspace to whichever one happened to write this file last (§P2 of the earlier design). Never
 * gets a §4.7 C9 variable form either: this file lives in the user's own profile and is never
 * shared with a teammate the way a committed workspace file is. */
export function mergeVscodeUserMcpJson(
  existing: string | undefined,
  definition: IntegrationDefinition
): string {
  return setJsonMember(existing, "mcp.json", "servers", stdioEntry(definition, "stdio"));
}

/** Sets `mcpServers["m365-agents"]` in the Claude Code *user-scope* `~/.claude.json` (§4.4/CLI, the
 * default `claude`/`claude-user` writer) -- the very same file and container key `claude mcp
 * add-json m365-agents ... --scope user` itself writes, so this module's ownership classification
 * and `doctor`/`integrations status` read the vendor CLI's own entries as `"managed"` without any
 * extra plumbing (see `applyClaudeUser`/`removeClaudeUser` below, which try the vendor CLI first
 * and fall back to this function). Never gets a §4.7 C9 variable form: same reasoning as
 * `mergeVscodeUserMcpJson`. */
export function mergeClaudeUserMcpJson(
  existing: string | undefined,
  definition: IntegrationDefinition
): string {
  return setJsonMember(existing, "~/.claude.json", "mcpServers", stdioEntry(definition));
}

/* ------------------------------------------------------------------ remove writers */

export type RemoveOptions = { force?: boolean };

function refuseForeign(
  file: string,
  existing: ParsedIntegrationEntry | undefined,
  force: boolean | undefined
): void {
  if (!force && classifyEntry(existing) === "foreign")
    throw new Error(
      `${file} has an m365-agents entry AgentPickLink did not write; refusing to remove it without --force.`
    );
}

function removeJsonServerEntry(existing: string, kind: JsonIntegrationKind, opts: RemoveOptions): string {
  const containerKey = containerKeyFor(kind);
  const file = jsonFileLabel(kind);
  refuseForeign(file, parseJsonEntry(existing, kind), opts.force);
  return deleteJsonMember(existing, file, containerKey);
}

/** Deletes `mcpServers["m365-agents"]` from a Claude Code `.mcp.json`, leaving every other key
 * (and the serializer's own formatting) exactly as `mergeClaudeMcpJson` would write it. Refuses a
 * foreign entry (§4.7 C6) unless `force`. */
export function removeClaudeMcpJson(existing: string, opts: RemoveOptions = {}): string {
  return removeJsonServerEntry(existing, "claudeCode", opts);
}

/** Deletes `servers["m365-agents"]` from a VS Code `.vscode/mcp.json`. Refuses a foreign entry
 * unless `force`. */
export function removeVscodeMcpJson(existing: string, opts: RemoveOptions = {}): string {
  return removeJsonServerEntry(existing, "vscodeMcpJson", opts);
}

/** Deletes `servers["m365-agents"]` from the VS Code user-profile `mcp.json` (§4.4). Refuses a
 * foreign entry unless `force`. */
export function removeVscodeUserMcpJson(existing: string, opts: RemoveOptions = {}): string {
  return removeJsonServerEntry(existing, "vscodeUser", opts);
}

/** Deletes `mcpServers["m365-agents"]` from the Claude Code user-scope `~/.claude.json` -- the
 * direct-file-edit fallback for `removeClaudeUser` below, and what `claude mcp remove m365-agents
 * --scope user` itself achieves through the vendor CLI. Refuses a foreign entry unless `force`. */
export function removeClaudeUserMcpJson(existing: string, opts: RemoveOptions = {}): string {
  return removeJsonServerEntry(existing, "claudeUser", opts);
}

/** Deletes the `[mcp_servers.m365-agents]` table (and any sub-table) from a Codex `config.toml` by
 * the same AST-range replacement `mergeCodexConfigToml` uses -- every other byte, comment and
 * table is preserved untouched. Refuses a foreign entry unless `force`. A no-op (returns `existing`
 * unchanged) when there is nothing to remove. */
export function removeCodexConfigToml(existing: string, opts: RemoveOptions = {}): string {
  const ast = parseTOML(existing);
  const before = getStaticTOMLValue(ast);
  const entry = codexServer(before);
  if (!entry) return existing;
  refuseForeign("~/.codex/config.toml", parseCodexEntry(existing), opts.force);
  const eol = /\r\n/.test(existing) ? "\r\n" : "\n";
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
  if (ranges.length > 0) ranges[0][0] = withPrecedingMachineComment(existing, ranges[0][0], eol);
  let merged = existing;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [start, end] = ranges[i];
    merged = merged.slice(0, start) + merged.slice(end);
  }
  const after = getStaticTOMLValue(parseTOML(merged));
  if (!isDeepStrictEqual(withoutCodexServer(before), withoutCodexServer(after)))
    throw new Error("Codex configuration update would change unrelated settings; file was not written.");
  return merged;
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

/** §4.7 C14: the cache-busting `M365_AGENT_BUILD` stamp is a workspace-file concern (VS Code needs
 * it to notice a version-independent identity has actually changed) -- Codex spawns the server
 * fresh per session and needs no stamp, so the codex writer/refresher always drop it, even though
 * the caller-supplied `definition` (built once per `install`/Save) carries it for every other
 * target. */
function withoutBuildStamp(definition: IntegrationDefinition): IntegrationDefinition {
  if (!definition.env || !("M365_AGENT_BUILD" in definition.env)) return definition;
  const env = { ...definition.env };
  delete env.M365_AGENT_BUILD;
  return { ...definition, env };
}

/* ------------------------------------------------------------------ claudeUser (§4.4/CLI) */

const CLAUDE_USER_FILE = ".claude.json";

function claudeUserFile(homeDirectory: string): string {
  return path.join(homeDirectory, CLAUDE_USER_FILE);
}

function claudeAddJsonArgs(definition: IntegrationDefinition): string[] {
  const json = JSON.stringify({
    command: definition.command,
    args: definition.args,
    ...(definition.env ? { env: definition.env } : {})
  });
  return ["mcp", "add-json", MCP_SERVER_NAME, json, "--scope", "user"];
}

/**
 * Writes the `claudeUser` integration: ownership is always decided by reading `~/.claude.json`
 * directly (the same file both write paths below ultimately target), so a foreign entry is refused
 * exactly like every other kind's writer, regardless of which path ends up performing the write.
 * When `context.claudeCliAvailable`, prefers `claude mcp add-json m365-agents '<json>' --scope
 * user` (retrying once after `claude mcp remove ... --scope user` if the first call fails -- the
 * vendor CLI can refuse to add a name that already exists, which would otherwise make a second
 * `install` run on the same machine not idempotent) and verifies with `claude mcp get m365-agents`
 * (its output is never parsed -- success is exit code 0). Falls back to editing the file directly
 * (`mergeClaudeUserMcpJson`, the same merge/refuse/backup rules as every other JSON writer here)
 * when the CLI is unavailable, or when it is available but every attempt above still failed.
 */
async function applyClaudeUser(
  context: Pick<IntegrationContext, "definition" | "homeDirectory" | "claudeCliAvailable" | "exec">,
  opts: ApplyIntegrationsOptions,
  summary: { written: string[]; skipped: string[] }
): Promise<void> {
  const file = claudeUserFile(context.homeDirectory);
  try {
    const existing = await readIfPresent(file);
    if (existing !== undefined) {
      const status = integrationEntryStatus(existing, "claudeUser", context.definition);
      if (status === "foreign") {
        if (!opts.force) {
          summary.skipped.push(
            `${file}: has an m365-agents entry AgentPickLink did not write; left untouched (pass --force to overwrite it).`
          );
          return;
        }
        await backupOnce(file, existing);
      }
    }
    if (context.claudeCliAvailable) {
      const exec = context.exec ?? defaultExec;
      const args = claudeAddJsonArgs(context.definition);
      try {
        await exec("claude", args);
      } catch {
        // Idempotent re-run / upgrade: `add-json` can refuse a name that already exists. Remove
        // (best effort -- ENOENT-shaped "nothing to remove" is not a real failure) and retry once
        // before giving up on the vendor CLI entirely.
        await exec("claude", ["mcp", "remove", MCP_SERVER_NAME, "--scope", "user"]).catch(() => undefined);
        await exec("claude", args);
      }
      // §P2: never parsed -- success is exit code 0 (see the doc comment above).
      await exec("claude", ["mcp", "get", MCP_SERVER_NAME]);
      summary.written.push(file);
      return;
    }
    await writeFile(file, mergeClaudeUserMcpJson(existing, context.definition), existing);
    summary.written.push(file);
  } catch (error) {
    if (context.claudeCliAvailable) {
      // The vendor CLI failed end to end (or the verification step did): fall back to the direct
      // file edit rather than reporting a skip when a perfectly good alternative exists.
      try {
        const existing = await readIfPresent(file);
        await writeFile(file, mergeClaudeUserMcpJson(existing, context.definition), existing);
        summary.written.push(file);
        return;
      } catch (fallbackError) {
        summary.skipped.push(
          `${file}: ${truncateError(fallbackError)} (vendor CLI: ${truncateError(error)})`
        );
        return;
      }
    }
    summary.skipped.push(`${file}: ${truncateError(error)}`);
  }
}

/**
 * Removes the `claudeUser` integration: `claude mcp remove m365-agents --scope user` when the
 * vendor CLI is available (falling back to the direct file edit on failure), otherwise the direct
 * file edit (`removeClaudeUserMcpJson`) -- same ownership/backup rules as `applyClaudeUser` above.
 * A file with no `m365-agents` entry at all is left alone, matching every other remover here.
 */
async function removeClaudeUser(
  context: Pick<IntegrationContext, "definition" | "homeDirectory" | "claudeCliAvailable" | "exec">,
  opts: RemoveOptions,
  summary: { written: string[]; skipped: string[] }
): Promise<void> {
  const file = claudeUserFile(context.homeDirectory);
  try {
    const existing = await readIfPresent(file);
    if (existing === undefined) return;
    const status = integrationEntryStatus(existing, "claudeUser", context.definition);
    if (status === "absent") return;
    if (status === "foreign" && !opts.force) {
      summary.skipped.push(
        `${file}: has an m365-agents entry AgentPickLink did not write; left untouched (pass --force to remove it).`
      );
      return;
    }
    if (status === "foreign" && opts.force) await backupOnce(file, existing);
    if (context.claudeCliAvailable) {
      try {
        await (context.exec ?? defaultExec)("claude", ["mcp", "remove", MCP_SERVER_NAME, "--scope", "user"]);
        summary.written.push(file);
        return;
      } catch {
        // Fall through to the direct file edit rather than leaving a managed entry in place just
        // because the vendor CLI call failed.
      }
    }
    await writeFile(file, removeClaudeUserMcpJson(existing, { force: true }), existing);
    summary.written.push(file);
  } catch (error) {
    summary.skipped.push(`${file}: ${truncateError(error)}`);
  }
}

export type ApplyIntegrationsOptions = {
  /** §4.7 C6: overwrite an `m365-agents` entry AgentPickLink did not write. Without it such an
   * entry is reported in `skipped` and left byte-identical; with it, the original bytes are
   * preserved once at `<file>.apl-backup` before the overwrite -- the same contract
   * `removeIntegrations` already has. */
  force?: boolean;
};

/**
 * Writes the files for the enabled integrations only. A failure on one integration is reported in
 * `skipped` and never prevents the others (or the rest of Save) from completing.
 *
 * §4.7 C6 (ownership) is enforced here, not only on the remove path: an existing entry that this
 * module did not write ("foreign") is never silently clobbered by a Save -- worst of all in the
 * user-profile `mcp.json`, which is shared with every other workspace and every other tool.
 */
export async function applyIntegrations(
  context: IntegrationContext,
  settings: IntegrationSettings,
  opts: ApplyIntegrationsOptions = {}
): Promise<IntegrationSummary> {
  const summary: IntegrationSummary & { warnings: string[] } = {
    written: [],
    skipped: [],
    warnings: []
  };
  const run = async (
    file: string,
    kind: IntegrationKind,
    definition: IntegrationDefinition,
    produce: (existing: string | undefined) => string
  ): Promise<void> => {
    try {
      const existing = await readIfPresent(file);
      if (existing !== undefined) {
        const status = integrationEntryStatus(existing, kind, definition, context.variables);
        if (status === "foreign") {
          if (!opts.force) {
            summary.skipped.push(
              `${file}: has an m365-agents entry AgentPickLink did not write; left untouched (pass --force to overwrite it).`
            );
            return;
          }
          await backupOnce(file, existing);
        }
      }
      await writeFile(file, produce(existing), existing);
      summary.written.push(file);
    } catch (error) {
      summary.skipped.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (settings.codex) {
    const file = path.join(context.homeDirectory, ".codex", "config.toml");
    const definition = withoutBuildStamp(context.definition);
    await run(file, "codex", definition, (existing) =>
      mergeCodexConfigToml(
        existing ?? "",
        { ...definition, startupTimeoutSec: 60, toolTimeoutSec: 900 },
        context.variables
      )
    );
  }
  if (settings.claudeCode) {
    if (!context.workspaceRoot) summary.skipped.push(".mcp.json: no workspace folder is open.");
    else
      await run(path.join(context.workspaceRoot, ".mcp.json"), "claudeCode", context.definition, (existing) =>
        mergeClaudeMcpJson(existing, context.definition, context.variables)
      );
  }
  if (settings.vscodeMcpJson) {
    if (!context.workspaceRoot) summary.skipped.push(".vscode/mcp.json: no workspace folder is open.");
    else
      await run(
        path.join(context.workspaceRoot, ".vscode", "mcp.json"),
        "vscodeMcpJson",
        context.definition,
        (existing) => mergeVscodeMcpJson(existing, context.definition, context.variables)
      );
  }
  if (settings.vscodeUser) {
    if (!context.vscodeUserDirectory)
      summary.skipped.push(
        "mcp.json (vscode-user): the VS Code user directory was not found; run `apl integrations snippet --client vscode-user`."
      );
    else {
      const file = path.join(context.vscodeUserDirectory, "mcp.json");
      await run(file, "vscodeUser", context.definition, (existing) =>
        mergeVscodeUserMcpJson(existing, context.definition)
      );
    }
  }
  if (settings.claudeUser) await applyClaudeUser(context, opts, summary);
  return summary;
}

export type IntegrationRefreshSummary = {
  /** Absolute paths of files whose `m365-agents` entry was rewritten in place. */
  refreshed: string[];
};

/**
 * P1-9 / §4.7 C6-C7: called once at activation and once per `install` (never during an explicit
 * Save, which always writes unconditionally via `applyIntegrations` above) to converge an
 * *already existing* `m365-agents` entry onto `context.definition` -- e.g. the extension moved
 * install paths, the resolved Node runtime changed, or a legacy (pre-marker) entry from an older
 * AgentPickLink needs to move onto today's identity. Only `"managed"` and `"legacy"` entries are
 * ever touched (`integrationEntryStatus`); a `"foreign"` entry -- one this module did not write,
 * §4.7 C6 -- is always left alone here, with no `--force` escape hatch (that only exists on the
 * explicit `integrations remove`/`self uninstall` path). Disabled integrations, and files/entries
 * that do not exist yet, are left completely untouched: this never creates a first-time entry,
 * only converges an existing one.
 */
export async function refreshStaleIntegrations(
  context: IntegrationContext,
  settings: IntegrationSettings
): Promise<IntegrationRefreshSummary> {
  const refreshed: string[] = [];
  // The definition compared against each file is the one that file would be *written* with: the
  // codex writer drops the §4.7 C14 build stamp, so comparing its env against a stamped definition
  // (see `context.compareEnvKeys`) would otherwise report an eternal, byte-identical "refresh".
  const maybeRefresh = async (
    file: string,
    kind: IntegrationKind,
    definition: IntegrationDefinition,
    produce: (existing: string) => string
  ): Promise<void> => {
    try {
      const existing = await readIfPresent(file);
      if (existing === undefined) return;
      const status = integrationEntryStatus(existing, kind, definition, context.variables);
      if (status !== "managed" && status !== "legacy") return;
      if (!integrationNeedsRefresh(existing, definition, kind, context.variables, context.compareEnvKeys))
        return;
      await writeFile(file, produce(existing), existing);
      refreshed.push(file);
    } catch {
      // Never fail activation over a stale-integration refresh; a real problem with the file
      // surfaces the next time the user presses Save, through applyIntegrations' own reporting.
    }
  };

  if (settings.codex) {
    const definition = withoutBuildStamp(context.definition);
    await maybeRefresh(
      path.join(context.homeDirectory, ".codex", "config.toml"),
      "codex",
      definition,
      (existing) =>
        mergeCodexConfigToml(
          existing,
          { ...definition, startupTimeoutSec: 60, toolTimeoutSec: 900 },
          context.variables
        )
    );
  }
  if (settings.claudeCode && context.workspaceRoot)
    await maybeRefresh(
      path.join(context.workspaceRoot, ".mcp.json"),
      "claudeCode",
      context.definition,
      (existing) => mergeClaudeMcpJson(existing, context.definition, context.variables)
    );
  if (settings.vscodeMcpJson && context.workspaceRoot)
    await maybeRefresh(
      path.join(context.workspaceRoot, ".vscode", "mcp.json"),
      "vscodeMcpJson",
      context.definition,
      (existing) => mergeVscodeMcpJson(existing, context.definition, context.variables)
    );
  if (settings.vscodeUser && context.vscodeUserDirectory)
    await maybeRefresh(
      path.join(context.vscodeUserDirectory, "mcp.json"),
      "vscodeUser",
      context.definition,
      (existing) => mergeVscodeUserMcpJson(existing, context.definition)
    );
  if (settings.claudeUser)
    // §4.4/CLI: refreshing an existing entry is a plain file edit even when the vendor CLI is
    // available -- there is nothing to verify beyond writing the same bytes `applyClaudeUser`
    // would, and a background refresh (activation, `install`'s migration pass) should not spawn a
    // process for that.
    await maybeRefresh(claudeUserFile(context.homeDirectory), "claudeUser", context.definition, (existing) =>
      mergeClaudeUserMcpJson(existing, context.definition)
    );
  return { refreshed };
}

/** Writes `<file>.apl-backup` with `content`, but only the first time -- an existing backup is
 * never overwritten, so it keeps recording the state from before the *first* forced removal of a
 * foreign entry rather than the most recent one. */
async function backupOnce(file: string, content: string): Promise<void> {
  const backupPath = `${file}.apl-backup`;
  try {
    await fs.access(backupPath);
    return;
  } catch {
    /* no existing backup: write one below */
  }
  await fs.writeFile(backupPath, content, "utf8");
}

/**
 * The inverse of `applyIntegrations`: deletes the `m365-agents` entry from every enabled
 * integration's file (`removeCodexConfigToml`/`removeClaudeMcpJson`/`removeVscodeMcpJson`), used by
 * `self uninstall` and `integrations remove`. A file that does not exist, or has no `m365-agents`
 * entry, is left alone and is not reported as a failure. A `"foreign"` entry (§4.7 C6) is reported
 * in `skipped` and left untouched unless `opts.force` is set, in which case its original bytes are
 * preserved once at `<file>.apl-backup` before it is removed.
 */
export async function removeIntegrations(
  context: IntegrationContext,
  settings: IntegrationSettings,
  opts: RemoveOptions = {}
): Promise<IntegrationSummary> {
  const summary: IntegrationSummary = { written: [], skipped: [] };
  const run = async (
    file: string,
    kind: IntegrationKind,
    remove: (existing: string, opts: RemoveOptions) => string
  ): Promise<void> => {
    try {
      const existing = await readIfPresent(file);
      if (existing === undefined) return;
      const status = integrationEntryStatus(existing, kind, context.definition, context.variables);
      if (status === "absent") return;
      if (status === "foreign" && !opts.force) {
        summary.skipped.push(
          `${file}: has an m365-agents entry AgentPickLink did not write; left untouched (pass --force to remove it).`
        );
        return;
      }
      if (status === "foreign" && opts.force) await backupOnce(file, existing);
      // Ownership was already decided above (against the caller's own `definition`, which the
      // low-level `force`-gated check in each remove function cannot see); always pass `force:
      // true` here so that check never re-refuses what this loop just approved.
      await writeFile(file, remove(existing, { force: true }), existing);
      summary.written.push(file);
    } catch (error) {
      summary.skipped.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (settings.codex)
    await run(path.join(context.homeDirectory, ".codex", "config.toml"), "codex", removeCodexConfigToml);
  if (settings.claudeCode) {
    if (!context.workspaceRoot) summary.skipped.push(".mcp.json: no workspace folder is open.");
    else await run(path.join(context.workspaceRoot, ".mcp.json"), "claudeCode", removeClaudeMcpJson);
  }
  if (settings.vscodeMcpJson) {
    if (!context.workspaceRoot) summary.skipped.push(".vscode/mcp.json: no workspace folder is open.");
    else
      await run(
        path.join(context.workspaceRoot, ".vscode", "mcp.json"),
        "vscodeMcpJson",
        removeVscodeMcpJson
      );
  }
  if (settings.vscodeUser) {
    if (!context.vscodeUserDirectory)
      summary.skipped.push("mcp.json (vscode-user): the VS Code user directory was not found.");
    else await run(path.join(context.vscodeUserDirectory, "mcp.json"), "vscodeUser", removeVscodeUserMcpJson);
  }
  if (settings.claudeUser) await removeClaudeUser(context, opts, summary);
  return summary;
}
