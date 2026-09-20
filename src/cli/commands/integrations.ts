/**
 * `m365-agent integrations write|status|remove|snippet` -- the client-file step alone, for scripts
 * and docs (docs/extension-less-onboarding.md §4.3). Shares the writers/removers/classifier in
 * `src/services/integrations.ts` with `install`'s "Clients" step and `self uninstall`.
 */
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../../domain/errors.js";
import {
  defaultClientDetectionIo,
  isClaudeCliOnPath,
  vscodeUserDir
} from "../../services/client-detection.js";
import {
  identityFor,
  buildStamp,
  integrationVariablesFor,
  readInstallJson,
  resolveInstallHome
} from "../../services/install-home.js";
import { persistedEnvironment } from "../../services/env-policy.js";
import {
  applyIntegrations,
  integrationEntryStatus,
  integrationNeedsRefresh,
  removeIntegrations,
  type IntegrationContext,
  type IntegrationDefinition,
  type IntegrationKind,
  type IntegrationSettings
} from "../../services/integrations.js";
import { pickLocaleFromEnv, translator } from "../../services/localize.js";
import type { CommandDeps } from "../command-deps.js";

/**
 * §4.4: `vscode`/`vscode-user` and `claude`/`claude-user` are aliases of the same default,
 * zero-touch user-scope writer; `vscode-workspace`/`claude-project` are their opt-in
 * workspace/project-scope counterparts. `codex` is unchanged.
 */
export type IntegrationsClientId =
  "vscode" | "vscode-user" | "vscode-workspace" | "claude" | "claude-user" | "claude-project" | "codex";
const ALL_CLIENTS: readonly IntegrationsClientId[] = ["vscode", "claude", "codex"];
const KNOWN_CLIENTS: readonly IntegrationsClientId[] = [
  "vscode",
  "vscode-user",
  "vscode-workspace",
  "claude",
  "claude-user",
  "claude-project",
  "codex"
];

function parseClientList(raw: string | undefined): IntegrationsClientId[] {
  if (!raw) return [...ALL_CLIENTS];
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  const unknown = tokens.filter((token) => !(KNOWN_CLIENTS as readonly string[]).includes(token));
  if (unknown.length > 0)
    throw new DomainError("INVALID_ARGUMENT", `Unknown client(s): ${unknown.join(", ")}`, false, {
      remediation: `Use --client ${KNOWN_CLIENTS.join(",")} (comma-separated), or omit it for vscode,claude,codex.`
    });
  return tokens as IntegrationsClientId[];
}

function kindFor(client: IntegrationsClientId): IntegrationKind {
  if (client === "codex") return "codex";
  if (client === "claude-project") return "claudeCode";
  if (client === "claude" || client === "claude-user") return "claudeUser";
  if (client === "vscode-workspace") return "vscodeMcpJson";
  return "vscodeUser"; // "vscode" | "vscode-user"
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path `client`'s file lives at: Codex's and the two default user-scope writers'
 * are per-OS-user (`homedir`/the VS Code user-profile directory, §4.4, default profile only,
 * independent of the workspace); `vscode-workspace`/`claude-project` are per-workspace. */
export function fileFor(
  client: IntegrationsClientId,
  io: Pick<CommandDeps, "env" | "platform" | "homedir">,
  workspaceRoot: string
): string {
  if (client === "codex") return path.join(io.homedir(), ".codex", "config.toml");
  if (client === "claude" || client === "claude-user") return path.join(io.homedir(), ".claude.json");
  if (client === "claude-project") return path.join(workspaceRoot, ".mcp.json");
  if (client === "vscode-workspace") return path.join(workspaceRoot, ".vscode", "mcp.json");
  return path.join(vscodeUserDir({ env: io.env, platform: io.platform, homedir: io.homedir() }), "mcp.json");
}

function settingsFor(clients: readonly IntegrationsClientId[]): IntegrationSettings {
  return {
    codex: clients.includes("codex"),
    claudeCode: clients.includes("claude-project"),
    claudeUser: clients.includes("claude") || clients.includes("claude-user"),
    vscodeMcpJson: clients.includes("vscode-workspace"),
    vscodeUser: clients.includes("vscode") || clients.includes("vscode-user")
  };
}

/** The identity + ownership marker `install` itself would write, derived the same way
 * (`src/cli/setup-host-terminal.ts`'s `integrationDefinition()`) but usable without an active
 * `SetupController` -- `integrations write/status/remove/snippet` are meant to run standalone. */
export async function resolveStandaloneDefinition(
  deps: CommandDeps,
  homeOverride?: string
): Promise<IntegrationDefinition> {
  const home = resolveInstallHome({
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir(),
    override: homeOverride
  });
  const identity = identityFor({ home, platform: deps.platform });
  const persisted = persistedEnvironment({}, deps.env.M365_AGENT_APP_DATA);
  const installJson = await readInstallJson(home).catch(() => undefined);
  return {
    ...(installJson?.identity ?? identity),
    env: {
      ...persisted,
      ...(installJson?.runtime.source === "electron" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      M365_AGENT_MANAGED: "1",
      M365_AGENT_BUILD: buildStamp(installJson?.version ?? deps.version)
    }
  };
}

/** Everything `applyIntegrations`/`removeIntegrations`/`integrationEntryStatus` need for a
 * standalone run: the identity, §4.7 C9's variable prefixes (so a committed workspace file
 * resolves for a teammate on the same OS), and the VS Code user directory for the opt-in
 * `vscodeUser` client -- `undefined` when it does not exist on this machine, so that writer skips
 * with a reason instead of creating a directory no VS Code profile actually reads. */
export async function resolveIntegrationContext(
  deps: CommandDeps,
  workspaceRoot: string,
  homeOverride?: string
): Promise<IntegrationContext> {
  const definition = await resolveStandaloneDefinition(deps, homeOverride);
  const variables = integrationVariablesFor({
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir()
  });
  const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
  const vscodeUserDirectory = (await pathExists(userDir)) ? userDir : undefined;
  const claudeCliAvailable = await isClaudeCliOnPath({
    ...defaultClientDetectionIo(),
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir()
  });
  return {
    definition,
    homeDirectory: deps.homedir(),
    workspaceRoot,
    variables,
    vscodeUserDirectory,
    claudeCliAvailable,
    exec: deps.exec
  };
}

export async function runIntegrationsWrite(
  deps: CommandDeps,
  options: { client?: string; workspace?: string; force?: boolean; home?: string }
): Promise<Record<string, unknown>> {
  const clients = parseClientList(options.client);
  const workspaceRoot = path.resolve(options.workspace ?? deps.root());
  const context = await resolveIntegrationContext(deps, workspaceRoot, options.home);
  // ISSUE-2026-09-14-14: an explicit `vscode` / `vscode-user` request must not be skipped just because
  // VS Code has never been started on this machine -- create its user settings folder (plain mkdir,
  // like VS Code itself does on first run; it is not an AgentPickLink-private store) and write there.
  if (
    (clients.includes("vscode") || clients.includes("vscode-user")) &&
    context.vscodeUserDirectory === undefined
  ) {
    const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
    await mkdir(userDir, { recursive: true });
    context.vscodeUserDirectory = userDir;
    deps.stdout(`${translator(pickLocaleFromEnv(deps.env))("installVscodeUserDirCreated")}\n`);
  }
  // §4.7 C6 (P1-8): without `--force`, a foreign entry is reported in `skipped` and left alone.
  const summary = await applyIntegrations(context, settingsFor(clients), { force: options.force });
  return {
    written: summary.written,
    skipped: summary.skipped,
    ...(summary.warnings && summary.warnings.length > 0 ? { warnings: summary.warnings } : {})
  };
}

export async function runIntegrationsStatus(
  deps: CommandDeps,
  options: { client?: string; workspace?: string; home?: string }
): Promise<Record<string, unknown>> {
  const clients = parseClientList(options.client);
  const workspaceRoot = path.resolve(options.workspace ?? deps.root());
  const context = await resolveIntegrationContext(deps, workspaceRoot, options.home);
  const results = await Promise.all(
    clients.map(async (client) => {
      const file = fileFor(client, deps, workspaceRoot);
      const kind = kindFor(client);
      let text: string | undefined;
      try {
        text = await readFile(file, "utf8");
      } catch {
        text = undefined;
      }
      const status =
        text === undefined
          ? "absent"
          : integrationEntryStatus(text, kind, context.definition, context.variables);
      const needsRefresh =
        text !== undefined
          ? integrationNeedsRefresh(text, context.definition, kind, context.variables)
          : false;
      return { client, file, status, needsRefresh };
    })
  );
  return { clients: results };
}

export async function runIntegrationsRemove(
  deps: CommandDeps,
  options: { client?: string; workspace?: string; force?: boolean; home?: string }
): Promise<Record<string, unknown>> {
  const clients = parseClientList(options.client);
  const workspaceRoot = path.resolve(options.workspace ?? deps.root());
  const context = await resolveIntegrationContext(deps, workspaceRoot, options.home);
  const summary = await removeIntegrations(context, settingsFor(clients), { force: options.force });
  return { removed: summary.written, skipped: summary.skipped };
}

/** The vendor one-liner for a client that prefers its own CLI over a direct file edit
 * (docs/extension-less-onboarding.md §4.3/§5): `claude mcp add-json` / `codex mcp add`. VS Code has
 * no equivalent single-line form, so its snippet is the `.vscode/mcp.json` entry itself. */
export function snippetFor(client: IntegrationsClientId, definition: IntegrationDefinition): string {
  if (client === "codex") {
    const args = definition.args.map((value) => JSON.stringify(value)).join(" ");
    return `codex mcp add m365-agents -- ${definition.command} ${args}`;
  }
  if (client === "claude" || client === "claude-user") {
    // §4.4: the vendor CLI's own blessed form -- the JSON is one argv element, not something typed
    // interactively. P2: a single-quoted JSON argument is a POSIX-shell-only construct -- it is not
    // valid cmd.exe or PowerShell syntax, and PowerShell's own quoting rules would mangle the
    // embedded double quotes differently again -- so the JSON block below is offered as a fallback
    // for `claude mcp add-json m365-agents --scope user` (typed with no JSON argument, which
    // prompts for it) on Windows.
    const json = JSON.stringify({
      command: definition.command,
      args: definition.args,
      ...(definition.env ? { env: definition.env } : {})
    });
    const pretty = JSON.stringify(
      {
        command: definition.command,
        args: definition.args,
        ...(definition.env ? { env: definition.env } : {})
      },
      undefined,
      2
    );
    return [
      `claude mcp add-json m365-agents '${json}' --scope user`,
      "",
      "(POSIX shells only. On Windows, run `claude mcp add-json m365-agents --scope user` and paste",
      "the JSON below when prompted:)",
      pretty
    ].join("\n");
  }
  const entry = {
    ...(client === "claude-project" ? {} : { type: "stdio" }),
    command: definition.command,
    args: definition.args,
    ...(definition.env ? { env: definition.env } : {})
  };
  return client === "claude-project"
    ? JSON.stringify({ mcpServers: { "m365-agents": entry } }, undefined, 2)
    : JSON.stringify({ servers: { "m365-agents": entry } }, undefined, 2);
}

export async function runIntegrationsSnippet(
  deps: CommandDeps,
  options: { client?: string; home?: string }
): Promise<Record<string, unknown>> {
  const clients = parseClientList(options.client);
  const definition = await resolveStandaloneDefinition(deps, options.home);
  return Object.fromEntries(clients.map((client) => [client, snippetFor(client, definition)]));
}
