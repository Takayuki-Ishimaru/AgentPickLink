/**
 * Per-client policy detection (docs/extension-less-onboarding.md §4.4): whether a *detected*
 * client (see `client-detection.ts`) actually allows AgentPickLink to register, so `doctor` and
 * the install plan can name the policy ("MCP is disabled by the ChatMCP policy on this machine")
 * instead of failing with a generic error.
 *
 * Every finding is metadata only -- a policy name, its value, and the file/registry key it came
 * from -- never the surrounding file content. Administrator-managed files (Claude Code's
 * `managed-mcp.json`) are checked for presence only and are never parsed.
 *
 * All I/O is injectable (`ClientPolicyIo`) so the Windows registry branch and the per-OS
 * `managed-mcp.json` paths can all be exercised from a single-OS test run.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import type { ClientId } from "./client-detection.js";
import { pathModuleFor, vscodeUserDir } from "./client-detection.js";

const execFileAsync = promisify(execFile);
const REGISTRY_TIMEOUT_MS = 5_000;

export type PolicyFinding = {
  client: ClientId;
  /** The setting/policy name, e.g. "chat.mcp.access" or "mcp_servers.m365-agents.enabled". */
  policy: string;
  /** The observed value, as text (never the raw file). */
  value: string;
  /** True when this finding, by itself, prevents AgentPickLink from being usable by this client. */
  blocks: boolean;
  /** Where the value was read from: an absolute file path or a registry key. */
  source: string;
};

export type RegistryHive = "HKCU" | "HKLM";

/** Everything `checkClientPolicies` needs from the host; overridden wholesale in tests. */
export type ClientPolicyIo = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  /** Resolves the file's text, or `undefined` when it does not exist. Rejects on any other I/O error. */
  readFile: (target: string) => Promise<string | undefined>;
  pathExists: (target: string) => Promise<boolean>;
  /** `reg query <hive>\<key> /v <valueName>` equivalent; `undefined` when the value (or the
   * command itself) is unavailable. Only ever called on win32. */
  queryRegistry: (hive: RegistryHive, key: string, valueName: string) => Promise<string | undefined>;
};

export function defaultClientPolicyIo(): ClientPolicyIo {
  return {
    env: process.env,
    platform: process.platform,
    homedir: os.homedir(),
    readFile: async (target) => {
      try {
        return await fs.readFile(target, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    pathExists: async (target) => {
      try {
        await fs.access(target);
        return true;
      } catch {
        return false;
      }
    },
    queryRegistry: defaultQueryRegistry
  };
}

/** Escapes regex metacharacters so a value can be interpolated into a `RegExp` literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function defaultQueryRegistry(
  hive: RegistryHive,
  key: string,
  valueName: string
): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const { stdout } = await execFileAsync("reg", ["query", `${hive}\\${key}`, "/v", valueName], {
      windowsHide: true,
      timeout: REGISTRY_TIMEOUT_MS
    });
    const match = new RegExp(`${escapeRegExp(valueName)}\\s+REG_\\w+\\s+(.+)`).exec(stdout);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ JSONC (VS Code settings.json) */

/** Strips `//` and `/* *\/` comments, respecting double-quoted strings, ahead of `JSON.parse`.
 * VS Code's `settings.json` is JSONC; this is deliberately lenient rather than a full JSONC
 * parser -- an input it cannot make sense of falls through to the caller's "unreadable" finding. */
function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += next;
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    result += ch;
  }
  return result;
}

/** Drops a trailing comma before `}`/`]`, respecting string content -- a blind
 * `text.replace(/,(\s*[}\]])/g, "$1")` would also match `,]`/`,}` sequences that happen to appear
 * *inside* a string value (e.g. `"a,]"`), corrupting the data it is supposed to only reformat.
 * Runs after `stripJsonComments`, so only string state (not comments) needs tracking here. */
function stripTrailingCommas(text: string): string {
  let result = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue; // Drop: it is a trailing comma.
    }
    result += ch;
  }
  return result;
}

function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** VS Code stores these as literal dotted keys in the JSON object, e.g. `{"chat.mcp.access": "none"}`. */
function readStringSetting(document: Record<string, unknown>, key: string): string | undefined {
  const value = document[key];
  return typeof value === "string" ? value : undefined;
}

const MAX_FINDING_VALUE_LENGTH = 64;

/** Renders an arbitrary settings.json value as bounded text for a `PolicyFinding`. Settings values
 * come straight from user-controlled configuration and must never be echoed back unbounded (an
 * enormous string) or as a non-string type into a finding meant for display/reporting. Returns
 * `undefined` only when the setting itself is absent. */
function findingValueText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean" || value === null
        ? String(value)
        : JSON.stringify(value);
  return text.length > MAX_FINDING_VALUE_LENGTH ? `${text.slice(0, MAX_FINDING_VALUE_LENGTH)}…` : text;
}

async function vscodeFindings(io: ClientPolicyIo): Promise<PolicyFinding[]> {
  const findings: PolicyFinding[] = [];
  const settingsPath = pathModuleFor(io.platform).join(vscodeUserDir(io), "settings.json");
  const raw = await io.readFile(settingsPath);
  if (raw !== undefined) {
    let document: Record<string, unknown> | undefined;
    try {
      document = asRecord(parseJsonc(raw));
    } catch {
      document = undefined;
    }
    if (!document) {
      findings.push({
        client: "vscode",
        policy: "settings.json",
        value: "unreadable",
        blocks: false,
        source: settingsPath
      });
    } else {
      const access = readStringSetting(document, "chat.mcp.access");
      if (access === "none")
        findings.push({
          client: "vscode",
          policy: "chat.mcp.access",
          value: "none",
          blocks: true,
          source: settingsPath
        });
      else if (access === "registry")
        findings.push({
          client: "vscode",
          policy: "chat.mcp.access",
          value: "registry",
          blocks: false,
          source: settingsPath
        });

      const collisionBehavior = readStringSetting(document, "chat.mcp.collisionBehavior");
      if (collisionBehavior === "suffix")
        findings.push({
          client: "vscode",
          policy: "chat.mcp.collisionBehavior",
          value: "suffix",
          blocks: false,
          source: settingsPath
        });

      const autostart = findingValueText(document["chat.mcp.autostart"]);
      if (autostart !== undefined)
        findings.push({
          client: "vscode",
          policy: "chat.mcp.autostart",
          value: autostart,
          blocks: false,
          source: settingsPath
        });
    }
  }

  if (io.platform === "win32") {
    const registryKey = "SOFTWARE\\Policies\\Microsoft\\VSCode";
    for (const hive of ["HKCU", "HKLM"] as const) {
      const value = await io.queryRegistry(hive, registryKey, "ChatMCP");
      if (value !== undefined)
        findings.push({
          client: "vscode",
          policy: "ChatMCP (Group Policy)",
          value,
          blocks: /^(0|none|disabled)$/i.test(value.trim()),
          source: `${hive}\\${registryKey}\\ChatMCP`
        });
    }
  }

  return findings;
}

function managedMcpJsonPath(io: Pick<ClientPolicyIo, "platform" | "env">): string {
  if (io.platform === "win32") {
    const programData = io.env.ProgramData ?? "C:\\ProgramData";
    return pathModuleFor(io.platform).join(programData, "ClaudeCode", "managed-mcp.json");
  }
  if (io.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-mcp.json";
  return "/etc/claude-code/managed-mcp.json";
}

async function claudeFindings(io: ClientPolicyIo): Promise<PolicyFinding[]> {
  const managedPath = managedMcpJsonPath(io);
  if (!(await io.pathExists(managedPath))) return [];
  // Presence only: its content is an administrator's managed configuration and is never parsed
  // here, so whether it actually restricts AgentPickLink is left for the administrator to confirm.
  return [
    { client: "claude", policy: "managed-mcp.json", value: "present", blocks: false, source: managedPath }
  ];
}

function readCodexEnabled(value: unknown): boolean | undefined {
  const servers = asRecord(value)?.mcp_servers;
  const entry = asRecord(servers)?.["m365-agents"];
  const enabled = asRecord(entry)?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

async function codexFindings(io: ClientPolicyIo): Promise<PolicyFinding[]> {
  const configPath = pathModuleFor(io.platform).join(io.homedir, ".codex", "config.toml");
  const raw = await io.readFile(configPath);
  if (raw === undefined) return [];
  let enabled: boolean | undefined;
  try {
    enabled = readCodexEnabled(getStaticTOMLValue(parseTOML(raw)));
  } catch {
    return [
      { client: "codex", policy: "config.toml", value: "unreadable", blocks: false, source: configPath }
    ];
  }
  if (enabled === false)
    return [
      {
        client: "codex",
        policy: "mcp_servers.m365-agents.enabled",
        value: "false",
        blocks: true,
        source: configPath
      }
    ];
  return [];
}

/** Runs every client's policy check and returns the combined findings. Detection (§4.3) and
 * policy (§4.4) are deliberately separate steps: a client can be installed and still
 * policy-blocked, and that must be shown as such rather than silently skipped. */
export async function checkClientPolicies(
  io: ClientPolicyIo = defaultClientPolicyIo()
): Promise<PolicyFinding[]> {
  const [vscode, claude, codex] = await Promise.all([
    vscodeFindings(io),
    claudeFindings(io),
    codexFindings(io)
  ]);
  return [...vscode, ...claude, ...codex];
}
