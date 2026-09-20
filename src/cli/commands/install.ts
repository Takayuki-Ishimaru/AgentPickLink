/**
 * `m365-agent install` -- the command behind the portable archive's `apl-setup` launcher
 * (docs/extension-less-onboarding.md §3.1, WP-B). Composes, in the panel's own order, exactly the
 * sequence `setup-view.ts` runs for "Set up environment" then "Save": plan and confirm, stage the
 * package and runtime, drive `SetupController` per workspace (sign-in, discovery, selection,
 * capability-widening confirm, Save -- which itself writes the client files and restarts the
 * broker when needed), verify with a live MCP handshake, then report.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError } from "../../domain/errors.js";
import { setBrokerSpawnTarget } from "../../broker/broker-lifecycle.js";
import { ensureProfileBrowsersGone } from "../../broker/profile-processes.js";
import { ensurePrivateDirectories } from "../../config/storage.js";
import { brokerLogPath, readBrokerLogTail } from "../../observability/broker-log.js";
import { stopBroker } from "../../services/broker-staleness.js";
import {
  checkClientPolicies,
  defaultClientPolicyIo,
  type PolicyFinding
} from "../../services/client-policy.js";
import {
  defaultClientDetectionIo,
  detectClients,
  isClaudeCliOnPath,
  vscodeUserDir,
  type ClientDetectionResult,
  type ClientId
} from "../../services/client-detection.js";
import {
  assertNotElevated,
  buildStamp,
  identityFor,
  installRuntime,
  integrationVariablesFor,
  listVersions,
  readInstallJson,
  resolveInstallHome,
  stageVersion,
  writeInstallJson,
  writeLaunchers
} from "../../services/install-home.js";
import { persistedEnvironment } from "../../services/env-policy.js";
import {
  applyIntegrations,
  integrationEntryStatus,
  refreshStaleIntegrations,
  removeIntegrations,
  type IntegrationDefinition,
  type IntegrationSettings,
  type IntegrationSummary
} from "../../services/integrations.js";
import {
  describeDiscoverySummary,
  describeErrorCode,
  pickLocaleFromEnv,
  translator,
  type MessageKey
} from "../../services/localize.js";
import { compareVersions } from "../../services/update-checker.js";
import { SetupController } from "../../services/setup-controller.js";
import type { IntegrationFlags, Locale, PanelState } from "../../services/setup-protocol.js";
import type { AgentCandidate } from "../../services/setup-service.js";
import type { CommandDeps } from "../command-deps.js";
import { createTerminalSetupHost, resolveBrokerEntry } from "../setup-host-terminal.js";
import { runBrowserSetup } from "../setup-server/browser-host.js";
import type { TerminalSetupHost, TerminalSetupHostOptions } from "../setup-host-terminal.js";
import { withYes } from "../ui/prompts.js";
import { runDoctor } from "./doctor.js";
import { snippetFor } from "./integrations.js";

export type InstallCommandOptions = {
  workspaces: string[];
  yes?: boolean;
  dryRun?: boolean;
  browser?: boolean;
  noOpen?: boolean;
  /** `auto` (default) | `none` | a comma list of `vscode,vscode-user,claude,codex`. */
  clients?: string;
  /** A comma list of agent aliases/keys; skips the interactive multi-select prompt. */
  agents?: string;
  home?: string;
  json?: boolean;
  /** §3.1's Consent rule (P0-3): answers the agent-roster approval non-interactively. Distinct
   * from `--yes`, which only answers the install-plan confirmation. Ignored when a terminal is
   * interactive -- the roster confirmation is always shown there regardless of this flag. */
  approveAgents?: boolean;
  /** §3.1's Consent rule (P0-3): answers the capability-widening consent non-interactively, for a
   * plan that actually includes an `actions-possible` agent. Without it, non-interactively,
   * `actions-possible` candidates are dropped from the plan before that consent would be needed
   * (their names are printed). Ignored when a terminal is interactive. */
  allowActionsPossible?: boolean;
  /** §4.7 C4: proceeds even though `install.json` records a *newer* version than this package --
   * the deliberate downgrade. Without it such a run is refused (it would re-point `bin/apl.js` at
   * older code behind a version-independent identity every host already trusts). */
  force?: boolean;
  /** §4.7 C2: registers this running checkout (`packageRoot`) as the machine install instead of
   * staging a copy into `app/<version>` -- `bin/apl.js` imports `<packageRoot>/dist/cli/index.js`
   * directly. Records `installedBy: "source"`; `bin/node` is still a copy of `process.execPath` (a
   * real, spawnable binary hosts can point at), but `install.json`'s own `runtime.path` is recorded
   * as `process.execPath` itself, not the copy -- see `runInstall`'s staging block. */
  dev?: boolean;
  /** Explicit extension-panel update; reuses the saved roster without discovery. */
  fromExtension?: boolean;
  /** ISSUE-09 (docs/validation-log-2026-09-14-windows.md): echoes every `TerminalSetupHost.log()`
   * line (metadata only -- see that module's doc comment) to stderr, prefixed `[log]`, in addition
   * to it always being appended to the app-data log file. Off by default. */
  verbose?: boolean;
};

export type InstallClientReport = {
  id: ClientId;
  detected: boolean;
  policyBlocked?: { policy: string; value: string };
  selected: boolean;
  /** Absolute file paths this run wrote for this client (workspace files across every workspace
   * in this run, plus the single home file for codex). */
  files: string[];
  /** Set when the client was selected but nothing could be written for it. */
  snippet?: string;
};

export type InstallWorkspaceReport = {
  root: string;
  agentsRegistered: number;
  agentsFailed: number;
  /** `.m365-agents.json` (only when it actually exists on disk) plus whichever of this workspace's
   * client files were written. */
  files: string[];
  /** P0-2/P0-3: set when this workspace's Save did not complete -- the panel ended on `"error"`,
   * never reached `saved()` at all (e.g. the roster approval was declined, or failed closed
   * non-interactively without `--approve-agents`), or `SetupController.save()` threw. Forces
   * `InstallReport.exitCode` to `3`. */
  error?: string;
  /** ISSUE-03 (docs/validation-log-2026-09-14-windows.md): the `ErrorCode` behind `error`, when the
   * underlying failure carried one (a `PanelError` from a failed `runSetup`/`reuseDiscovery`/`save`
   * -- see `toPanelError` in ./setup-controller.ts). Lets `formatInstallReport` show a code +
   * remediation line via `describeErrorCode` instead of only the raw English message. Absent for a
   * failure this module cannot attribute to one (e.g. the roster-approval-required fail-closed,
   * which is not itself a thrown error). */
  errorCode?: string;
  /** ISSUE-03: the raw English remediation captured alongside `errorCode` (`PanelError.remediation`),
   * used by `formatInstallReport` when `describeErrorCode` has no localized remediation for this
   * particular code (several codes, e.g. BROWSER_START_FAILED/AGENT_NOT_FOUND, have none). */
  errorRemediation?: string;
  /** WP-D: set when this workspace's discovery run was partial -- see `SetupService.discover()`'s
   * `partial`/`failedCount` (domain/discovery-warnings.ts's summarizeDiscoveryCompleteness).
   * Metadata only (a count, never agent names). Only ever set by the terminal (non-`--browser`)
   * flow, which is the only one that still has the pre-Save discovery snapshot on hand by the time
   * this report is built. */
  partial?: true;
  failedCount?: number;
};

export type InstallReport = {
  dryRun: boolean;
  confirmed: boolean;
  version: string;
  home: string;
  runtime: { path: string; source: "bundled" | "node" | "electron" };
  clients: InstallClientReport[];
  /** §4.4: set when `vscodeUser`/`claudeUser` (the default, zero-touch user-scope writers) were
   * selected -- a single per-machine file, so each is written at most once per run regardless of
   * how many workspaces were given (see the "vscode-user / claude-user (once)" block). */
  vscodeUser?: { written: string[]; skipped: string[]; warnings?: string[] };
  claudeUser?: { written: string[]; skipped: string[] };
  workspaces: InstallWorkspaceReport[];
  uninstallCommand: string;
  verified: boolean;
  doctor?: Array<{ workspace: string; ok: boolean; findings: string[] }>;
  verifyError?: string;
  /** ISSUE-03: sibling metadata to `verifyError`, populated only when the underlying failure was a
   * `DomainError` -- see `InstallWorkspaceReport.errorCode`'s doc comment for why the pair exists. */
  verifyErrorCode?: string;
  verifyErrorRemediation?: string;
  /** §4.3 item 4: workspace-file entries this run removed (or, under `--dry-run`, would remove)
   * because the corresponding opt-in (`vscode-workspace`/`claude-project`) was not selected --
   * e.g. a prior version's default write. Always present, empty when there was nothing to remove. */
  migrations: Array<{ workspace: string; file: string }>;
  instructions: string[];
  exitCode: 0 | 1 | 2 | 3;
  /** item 1: broker.log's path and its last 20 lines (metadata only), present only when this run
   * recorded a BROWSER_START_FAILED (`verifyErrorCode` or any workspace's `errorCode`) -- so a
   * failure report is diagnosable without a separate file lookup. */
  brokerLog?: { path: string; tail: string[] };
};

const CLIENT_IDS: readonly ClientId[] = ["vscode", "claude", "codex"];

/**
 * §4.4: `vscodeUser`/`claudeUser` are the default, zero-touch, user-scope writers (CLI tokens
 * `vscode`/`claude`, with `vscode-user`/`claude-user` as explicit aliases of the same meaning);
 * `vscodeWorkspace`/`claudeProject` are their opt-in workspace/project-scope counterparts (CLI
 * tokens `vscode-workspace`/`claude-project`) -- the old defaults, kept available for sites that
 * need a committed workspace file or that forbid a user-profile `mcp.json`/`~/.claude.json` write.
 * `codex` is unchanged (there is only ever one Codex scope).
 */
type ClientSelection = {
  vscodeUser: boolean;
  vscodeWorkspace: boolean;
  claudeUser: boolean;
  claudeProject: boolean;
  codex: boolean;
};

/** The CLI tokens `--clients` accepts, and what each selects. `vscode-user`/`claude-user` are
 * aliases of the bare `vscode`/`claude` tokens -- both spellings exist so a command line can be as
 * terse as `--clients vscode,claude,codex` or as explicit as `--clients vscode-user,claude-user`. */
const KNOWN_CLIENT_TOKENS = [
  "vscode",
  "vscode-user",
  "vscode-workspace",
  "claude",
  "claude-user",
  "claude-project",
  "codex"
] as const;

function resolveClientSelection(
  raw: string | undefined,
  detected: ClientDetectionResult[],
  policies: PolicyFinding[]
): ClientSelection {
  const blocked = new Set(policies.filter((finding) => finding.blocks).map((finding) => finding.client));
  const usable = (id: ClientId): boolean =>
    !!detected.find((entry) => entry.id === id)?.installed && !blocked.has(id);
  if (!raw || raw === "auto")
    return {
      vscodeUser: usable("vscode"),
      vscodeWorkspace: false,
      claudeUser: usable("claude"),
      claudeProject: false,
      codex: usable("codex")
    };
  if (raw === "none")
    return {
      vscodeUser: false,
      vscodeWorkspace: false,
      claudeUser: false,
      claudeProject: false,
      codex: false
    };
  const tokens = new Set(
    raw
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
  );
  const known = new Set<string>(KNOWN_CLIENT_TOKENS);
  const unknown = [...tokens].filter((token) => !known.has(token));
  if (unknown.length > 0)
    throw new DomainError("INVALID_ARGUMENT", `Unknown --clients value(s): ${unknown.join(", ")}`, false, {
      remediation: `Use --clients auto|none|${KNOWN_CLIENT_TOKENS.join(",")}`
    });
  return {
    vscodeUser: tokens.has("vscode") || tokens.has("vscode-user"),
    vscodeWorkspace: tokens.has("vscode-workspace"),
    claudeUser: tokens.has("claude") || tokens.has("claude-user"),
    claudeProject: tokens.has("claude-project"),
    codex: tokens.has("codex")
  };
}

function toIntegrationFlags(selection: ClientSelection): IntegrationFlags {
  return {
    codex: selection.codex,
    claudeCode: selection.claudeProject,
    vscodeMcpJson: selection.vscodeWorkspace
  };
}

/** Walks up from this module's own location to the directory containing `package.json` -- the
 * package root, whether this is `dist/cli/commands/install.js` inside a staged archive or
 * `src/cli/commands/install.ts` under vitest's on-the-fly TS transform. Exported as
 * `CommandDeps.packageRoot`'s production implementation (wired in src/cli/runtime.ts); tests
 * override `packageRoot` entirely so `install` never stages the real repository checkout. */
export async function resolvePackageRoot(startUrl: string): Promise<string> {
  let dir = path.dirname(fileURLToPath(startUrl));
  for (;;) {
    if (await pathExists(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Could not locate package.json above the running CLI.");
    dir = parent;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** P1-5: the version a just-installed runtime reports, recorded in `install.json` so the extension
 * (`ExtensionRuntime.node()`) can accept it without probing. Runs `<binary> --version` exactly once
 * per install, through the injected `exec`, and returns `undefined` rather than failing the install
 * when the binary does not run or answers with something that is not a version -- `install.json`
 * simply keeps `nodeVersion` absent, which every reader already treats as "probe it yourself". */
async function probeRuntimeVersion(binary: string, exec: CommandDeps["exec"]): Promise<string | undefined> {
  if (!exec) return undefined;
  try {
    const { stdout } = await exec(binary, ["--version"]);
    const reported = stdout.trim().slice(0, 64);
    return /^v?\d+\.\d+\.\d+/.test(reported) ? reported.replace(/^v/, "") : undefined;
  } catch {
    return undefined;
  }
}

/** The identity + ownership marker + build stamp `install` writes everywhere -- the same formula
 * `src/cli/setup-host-terminal.ts`'s `TerminalSetupHost.integrationDefinition()` uses, computed
 * directly here because §4.7 C7's migration step below runs once per `install`, independent of any
 * particular workspace's `TerminalSetupHost`. */
function machineDefinition(opts: {
  home: string;
  platform: NodeJS.Platform;
  version: string;
  appDataOverride: string | undefined;
  identity?: { command: string; args: string[] };
  electron?: boolean;
}): { command: string; args: string[]; env: Record<string, string> } {
  const identity = opts.identity ?? identityFor({ home: opts.home, platform: opts.platform });
  return {
    ...identity,
    env: {
      ...persistedEnvironment(opts.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}, opts.appDataOverride),
      M365_AGENT_MANAGED: "1",
      M365_AGENT_BUILD: buildStamp(opts.version)
    }
  };
}

/**
 * §4.7 C7: on the first run of any new-version entry point, converge every reachable
 * legacy-managed (or already-managed) entry onto `install.json`'s identity -- the Codex user-scope
 * file and every workspace this machine has ever recorded, not only the ones passed on this
 * invocation -- so a workspace set up once keeps converging on later `apl-setup` runs even if it is
 * not named again. Never touches a foreign entry (`refreshStaleIntegrations` itself enforces that).
 */
async function migrateLegacyEntries(opts: {
  definition: { command: string; args: string[]; env: Record<string, string> };
  homeDirectory: string;
  workspaces: ReadonlySet<string>;
  clientsWritten: ReadonlySet<string>;
  variables: ReturnType<typeof integrationVariablesFor>;
  vscodeUserDirectory?: string;
  claudeCliAvailable: boolean;
  exec: CommandDeps["exec"];
}): Promise<void> {
  const settings: IntegrationSettings = {
    codex: opts.clientsWritten.has("codex"),
    claudeCode: opts.clientsWritten.has("claude-project"),
    vscodeMcpJson: opts.clientsWritten.has("vscode-workspace"),
    vscodeUser: opts.clientsWritten.has("vscode-user"),
    claudeUser: opts.clientsWritten.has("claude-user")
  };
  await refreshStaleIntegrations(
    {
      definition: opts.definition,
      homeDirectory: opts.homeDirectory,
      variables: opts.variables,
      compareEnvKeys: RESTAMP_ENV_KEYS,
      vscodeUserDirectory: opts.vscodeUserDirectory,
      claudeCliAvailable: opts.claudeCliAvailable,
      exec: opts.exec
    },
    settings
  ).catch(() => undefined);
  for (const workspace of opts.workspaces) {
    await refreshStaleIntegrations(
      {
        definition: opts.definition,
        homeDirectory: opts.homeDirectory,
        workspaceRoot: workspace,
        variables: opts.variables,
        compareEnvKeys: RESTAMP_ENV_KEYS
      },
      settings
    ).catch(() => undefined);
  }
}

/** §4.7 C14: the identity is version-independent, so on an upgrade the *only* launch field that
 * changes in a recorded workspace's file is `M365_AGENT_BUILD` -- the value VS Code hashes to
 * decide whether to restart the server and re-fetch its tools. `M365_AGENT_MANAGED` rides along so
 * a legacy (pre-marker) entry that already matches today's identity still gains the marker. Only
 * `install` compares these: the extension keeps its "converge the identity" semantics. */
const RESTAMP_ENV_KEYS = ["M365_AGENT_MANAGED", "M365_AGENT_BUILD"] as const;

/** One workspace-file entry that a prior `install` run wrote back when it was the default (the
 * workspace `.vscode/mcp.json` / project `.mcp.json`), which this run's selection no longer opts
 * into. `kind` names which writer/merge functions it maps to. */
type PlannedRemoval = { workspace: string; file: string; kind: "vscodeMcpJson" | "claudeCode" };

async function readIfPresentText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * §4.3 item 4 (docs/extension-less-onboarding.md §4.7 C6/C7): a read-only preview of every
 * workspace-file entry this run would remove because the corresponding opt-in is not selected --
 * shown in the plan (including under `--dry-run`, which never reaches the write path below) so the
 * user knows *why* before confirming. Only a `"managed"`/`"legacy"` entry is ever a candidate: a
 * foreign one is never touched, matching `removeIntegrations` itself.
 */
async function findDemotableWorkspaceFiles(opts: {
  workspaces: readonly string[];
  selection: ClientSelection;
  definition: IntegrationDefinition;
  variables: ReturnType<typeof integrationVariablesFor>;
}): Promise<PlannedRemoval[]> {
  const candidates: Array<{ kind: PlannedRemoval["kind"]; selected: boolean; segments: string[] }> = [
    { kind: "vscodeMcpJson", selected: opts.selection.vscodeWorkspace, segments: [".vscode", "mcp.json"] },
    { kind: "claudeCode", selected: opts.selection.claudeProject, segments: [".mcp.json"] }
  ];
  const results: PlannedRemoval[] = [];
  for (const workspace of opts.workspaces) {
    for (const candidate of candidates) {
      if (candidate.selected) continue;
      const file = path.join(workspace, ...candidate.segments);
      const text = await readIfPresentText(file);
      if (text === undefined) continue;
      const status = integrationEntryStatus(text, candidate.kind, opts.definition, opts.variables);
      if (status === "managed" || status === "legacy")
        results.push({ workspace, file, kind: candidate.kind });
    }
  }
  return results;
}

/**
 * §4.3 item 4: actually removes the entries `findDemotableWorkspaceFiles` above would preview, once
 * per workspace, using `removeIntegrations` so a foreign entry is still never touched and every
 * removal is reported the same way an explicit `integrations remove` would report it. Run after
 * staging (unlike the preview, which runs before confirmation) so `opts.definition` is the real
 * identity + ownership marker, not the plan step's approximation.
 */
async function demoteUnselectedWorkspaceFiles(opts: {
  workspaces: readonly string[];
  selection: ClientSelection;
  definition: IntegrationDefinition;
  homeDirectory: string;
  variables: ReturnType<typeof integrationVariablesFor>;
}): Promise<PlannedRemoval[]> {
  const removed: PlannedRemoval[] = [];
  const settings: IntegrationSettings = {
    codex: false,
    claudeCode: !opts.selection.claudeProject,
    vscodeMcpJson: !opts.selection.vscodeWorkspace
  };
  if (!settings.claudeCode && !settings.vscodeMcpJson) return removed;
  for (const workspace of opts.workspaces) {
    const summary = await removeIntegrations(
      {
        definition: opts.definition,
        homeDirectory: opts.homeDirectory,
        workspaceRoot: workspace,
        variables: opts.variables
      },
      settings
    ).catch(() => undefined);
    for (const file of summary?.written ?? [])
      removed.push({
        workspace,
        file,
        kind: file.endsWith(path.join(".vscode", "mcp.json")) ? "vscodeMcpJson" : "claudeCode"
      });
  }
  return removed;
}

/**
 * ISSUE-03: the code + English remediation behind a thrown value, when it is a `DomainError` --
 * `undefined` for anything else (a plain `Error`/filesystem failure has no `ErrorCode` to attribute
 * the failure to). Mirrors `DomainError.toResult()`'s own precedence (an explicit `options.remediation`
 * wins over the shared `src/domain/errors.ts` table) without depending on a `requestId`.
 */
function domainErrorMeta(error: unknown): { code?: string; remediation?: string } {
  if (!(error instanceof DomainError)) return {};
  const { error: application } = error.toResult("install");
  return {
    code: application.code,
    ...(application.remediation ? { remediation: application.remediation } : {})
  };
}

async function resolveWorkspaces(raw: string[]): Promise<string[]> {
  if (raw.length === 0)
    throw new DomainError("INVALID_ARGUMENT", "At least one workspace is required.", false, {
      remediation: "Pass one or more workspace folders: m365-agent install <workspace> [more...]"
    });
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const absolute = path.resolve(entry);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      throw new DomainError("WORKSPACE_ROOT_UNAVAILABLE", `Workspace does not exist: ${absolute}`);
    }
    if (!stat.isDirectory())
      throw new DomainError("WORKSPACE_ROOT_UNAVAILABLE", `Workspace is not a folder: ${absolute}`);
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(absolute);
  }
  return resolved;
}

/** One vendor's plan lines: the file kinds actually selected, or -- when none are -- why not
 * (policy-blocked, or simply not detected). VS Code and Claude Code each have a default user-scope
 * writer plus an opt-in workspace/project-scope one; Codex has only the one scope it always had. */
function printClientLines(
  out: (text: string) => void,
  t: (key: MessageKey) => string,
  id: ClientId,
  selected: string[],
  detected: ClientDetectionResult[],
  policies: PolicyFinding[]
): void {
  if (selected.length > 0) {
    for (const line of selected) out(`  ${line}`);
    return;
  }
  const blocked = policies.find((finding) => finding.client === id && finding.blocks);
  if (blocked)
    out(
      `  ${t("installPlanClientPolicyBlocked").replace("{client}", id).replace("{policy}", blocked.policy)}`
    );
  else if (!detected.find((entry) => entry.id === id)?.installed)
    out(`  ${t("installPlanClientNotDetected").replace("{client}", id)}`);
}

function printPlan(
  out: (text: string) => void,
  options: {
    locale: Locale;
    version: string;
    home: string;
    runtimeSource: "bundled" | "node" | "electron";
    workspaces: string[];
    selection: ClientSelection;
    detected: ClientDetectionResult[];
    policies: PolicyFinding[];
    yes: boolean;
    plannedRemovals: PlannedRemoval[];
  }
): void {
  const t = translator(options.locale);
  const s = options.selection;
  out(t("installPlanHeader"));
  out(t("installPlanVersion").replace("{version}", options.version));
  out(t("installPlanHome").replace("{home}", options.home));
  out(options.runtimeSource === "bundled" ? t("installPlanRuntimeBundled") : t("installPlanRuntimeSystem"));
  out(t("installPlanClientsHeader"));
  if (!s.vscodeUser && !s.vscodeWorkspace && !s.claudeUser && !s.claudeProject && !s.codex)
    out(`  ${t("installPlanClientsNone")}`);
  printClientLines(
    out,
    t,
    "vscode",
    [
      ...(s.vscodeUser ? [t("installPlanClientVscodeUser")] : []),
      ...(s.vscodeWorkspace ? [t("installPlanClientVscodeWorkspace")] : [])
    ],
    options.detected,
    options.policies
  );
  printClientLines(
    out,
    t,
    "claude",
    [
      ...(s.claudeUser ? [t("installPlanClientClaudeUser")] : []),
      ...(s.claudeProject ? [t("installPlanClientClaudeProject")] : [])
    ],
    options.detected,
    options.policies
  );
  printClientLines(out, t, "codex", s.codex ? ["codex"] : [], options.detected, options.policies);
  for (const removal of options.plannedRemovals)
    out(
      `  ${t(
        removal.kind === "vscodeMcpJson"
          ? "installMigrationRemovedVscodeWorkspace"
          : "installMigrationRemovedClaudeProject"
      ).replace("{file}", removal.file)}`
    );
  out(t("installPlanWorkspacesHeader"));
  for (const workspace of options.workspaces) out(`  ${workspace}`);
  if (options.yes) out(`  (${t("cliYesAnswer")})`);
}

async function selectAgents(
  deps: CommandDeps,
  locale: Locale,
  candidates: readonly AgentCandidate[],
  preSelectedKeys: readonly string[],
  agentsOption: string | undefined,
  yes: boolean
): Promise<string[]> {
  if (agentsOption !== undefined) {
    const requested = agentsOption
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    const unknown: string[] = [];
    const keys: string[] = [];
    for (const token of requested) {
      const match = candidates.find(
        (candidate) => candidate.key === token || candidate.registered?.alias === token
      );
      if (!match) unknown.push(token);
      else keys.push(match.key);
    }
    if (unknown.length > 0)
      // ISSUE-03: when discovery itself found nothing, "Unknown agent alias/key(s)" alone reads as
      // a typo in --agents; name the actual cause instead of leaving it to be inferred.
      throw new DomainError(
        "AGENT_NOT_FOUND",
        `Unknown agent alias/key(s): ${unknown.join(", ")}`,
        false,
        candidates.length === 0
          ? {
              remediation:
                "Discovery produced 0 candidates for this workspace, so no --agents value could match. Sign in and retry, or run discovery again before selecting agents."
            }
          : {}
      );
    return [...new Set(keys)];
  }
  if (!deps.prompter.interactive) {
    if (yes && preSelectedKeys.length > 0) return [...preSelectedKeys];
    throw new DomainError(
      "INVALID_ARGUMENT",
      "No interactive terminal and no prior selection for this workspace.",
      false,
      { remediation: translator(locale)("installNoAgentsNonInteractive") }
    );
  }
  const preSelected = new Set(preSelectedKeys);
  deps.stdout(
    `${candidates
      .map(
        (candidate, index) =>
          `${index + 1}. [${preSelected.has(candidate.key) ? "x" : " "}] ${candidate.displayName}`
      )
      .join("\n")}\n`
  );
  const answer = await deps.prompter.question(translator(locale)("installNoAgentsInteractive"));
  if (answer.trim().length === 0) return [...preSelectedKeys];
  const indexes = answer
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => Number(token) - 1);
  return [...new Set(indexes.map((index) => candidates[index]?.key).filter((key): key is string => !!key))];
}

/**
 * docs/validation-log-2026-09-14-windows-round2.md R4: stops a broker that was already running
 * before this `install` connected to it (see `brokerPreExisting` above), the same way
 * `restartBrokerIfStale` stops a stale one -- shut down, then wait for it to fully release the
 * profile -- so the very next `connect()` inside `SetupService` can spawn a fresh broker instead of
 * repeating the same `BROWSER_START_FAILED` against a broker whose retained browser context died
 * out from under it. Returns false (nothing attempted) when there is no live broker to stop, e.g.
 * it already exited on its own between the two reads.
 */
async function restartPreExistingBroker(deps: CommandDeps, log: (line: string) => void): Promise<boolean> {
  const descriptor = await deps.readDescriptor(deps.paths).catch(() => undefined);
  if (!descriptor) return false;
  let client;
  try {
    client = await deps.connectExistingBroker(deps.paths);
  } catch {
    client = undefined;
  }
  if (!client) return false;
  return stopBroker(client, deps.paths, descriptor.pid, log, undefined, descriptor.browserPid);
}

/**
 * Runs `controller.runSetup()` and, when it fails with `BROWSER_START_FAILED` against a broker
 * this `install` did not itself spawn, retries exactly once after restarting that broker
 * (`restartPreExistingBroker` above). A second failure (of any kind, including a repeat
 * `BROWSER_START_FAILED`) is reported exactly as it would be without this recovery -- `host`'s
 * `PanelState` already carries it, unchanged, for the caller below to read.
 *
 * docs/validation-log-2026-09-14-windows-round4.md U2: `restartPreExistingBroker`'s own `stopBroker`
 * call already waits (bounded) for the old broker's browser process tree to disappear before
 * returning (src/services/broker-staleness.ts's `waitForBrokerFullyReleased`), but this retry is
 * exactly the caller `waitForBrokerFullyReleased`'s own doc comment describes -- the very next
 * connect-or-start that would otherwise race a still-shutting-down browser against a brand new one
 * on the same profile. An explicit extra `ensureProfileBrowsersGone` call here, immediately before
 * the retry, costs nothing when the tree is already gone (it returns on the very first check) and
 * closes the gap for any future caller of `stopBroker` that ever passes a `releaseWait` without this
 * phase's own bound.
 */
async function runSetupWithBrokerRecovery(
  controller: SetupController,
  host: TerminalSetupHost,
  deps: CommandDeps,
  brokerPreExisting: boolean,
  t: (key: MessageKey) => string
): Promise<void> {
  await controller.runSetup();
  if (!brokerPreExisting) return;
  const state = host.lastPanelState();
  if (state?.phase !== "error" || state.error?.code !== "BROWSER_START_FAILED") return;
  const restarted = await restartPreExistingBroker(deps, (line) => host.log(line));
  if (!restarted) return;
  await ensureProfileBrowsersGone(deps.paths.profile, { log: (line) => host.log(line) });
  host.notify("info", t("installRestartingBrokerRetry"));
  await controller.runSetup();
}

export async function runInstall(deps: CommandDeps, options: InstallCommandOptions): Promise<InstallReport> {
  if (options.fromExtension && options.dev)
    throw new DomainError("INVALID_ARGUMENT", "--from-extension and --dev cannot be combined.");
  if (options.browser && !options.dryRun && !deps.prompter.interactive)
    throw new DomainError("INVALID_ARGUMENT", "Browser setup needs an interactive terminal for consent.");
  const locale = pickLocaleFromEnv(deps.env);
  const t = translator(locale);
  await assertNotElevated({ platform: deps.platform, getuid: deps.getuid });
  // docs/validation-log-2026-09-14-windows-round2.md R4: recorded before this run makes its own
  // first connect attempt (the browser-channel plan check below included), so it names a broker
  // that genuinely predates this `install` -- never one this same run just spawned. Used only to
  // gate the one-shot restart-and-retry in the per-workspace loop further down.
  const brokerPreExisting = !!(await deps.readDescriptor(deps.paths).catch(() => undefined));

  const home = resolveInstallHome({
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir(),
    override: options.home
  });
  // P1-4: an upgrade re-run with no workspace arguments reuses every workspace `install.json`
  // already recorded, rather than failing "at least one workspace is required".
  const priorInstallJson = await readInstallJson(home).catch(() => undefined);
  // §4.7 C4: the higher package version wins, and a downgrade is an explicit act. Refused before
  // anything is staged, printed or asked -- `bin/apl.js` is what every client file already points
  // at, so silently re-pointing it at older code is exactly the failure this rule exists for.
  if (priorInstallJson && !options.force && compareVersions(priorInstallJson.version, deps.version) === 1)
    throw new DomainError(
      "POLICY_BLOCKED",
      `AgentPickLink ${priorInstallJson.version} is already installed under ${home}; this package is ${deps.version}.`,
      false,
      {
        remediation:
          "Switch versions with `m365-agent self use <version>`, or re-run with --force to install this older version."
      }
    );
  const rawWorkspaces =
    options.workspaces.length > 0 ? options.workspaces : (priorInstallJson?.workspaces ?? []);

  const clientDetectionIo = {
    ...defaultClientDetectionIo(),
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir()
  };
  const clientPolicyIo = {
    ...defaultClientPolicyIo(),
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir()
  };
  const [detected, policies, workspaces] = await Promise.all([
    detectClients(clientDetectionIo),
    checkClientPolicies(clientPolicyIo),
    resolveWorkspaces(rawWorkspaces)
  ]);
  const selection = resolveClientSelection(
    options.clients ??
      (options.fromExtension && priorInstallJson?.clients.length
        ? priorInstallJson.clients.join(",")
        : undefined),
    detected,
    policies
  );
  const claudeCliAvailable = await isClaudeCliOnPath(clientDetectionIo);
  const vscodeUserDirCandidate = vscodeUserDir({
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir()
  });
  const vscodeUserDirExists = await pathExists(vscodeUserDirCandidate);
  // ISSUE-2026-09-14-14: an absent `%APPDATA%\Code\User` (a first VS Code run, or one this OS
  // user account has simply never opened) must not silently skip the user-scope write once the
  // vscode-user client is actually selected -- `selection.vscodeUser` is true exactly when it was
  // explicitly chosen (`--clients vscode`/`vscode-user`) or auto-selected because `detectClients()`
  // found VS Code's own executable (`code` on PATH, `Code.exe` under %LOCALAPPDATA%/%ProgramFiles%,
  // or the macOS .app -- never *only* the "VS Code user data dir present" evidence, which cannot
  // fire here since the directory is absent). The directory itself is only actually created later,
  // right before the write (never under `--dry-run`, and never when declined at the confirm
  // prompt) -- see the `vscodeUserDirNeedsCreate` write site below.
  const vscodeUserDirectory =
    vscodeUserDirExists || selection.vscodeUser ? vscodeUserDirCandidate : undefined;
  const vscodeUserDirNeedsCreate = selection.vscodeUser && !vscodeUserDirExists;
  const packageRoot = await deps.packageRoot();
  const version = deps.version;

  const isDev = !!options.dev;
  const runtimeCandidate = path.join(packageRoot, "runtime", deps.platform === "win32" ? "node.exe" : "node");
  // §4.7 C2 `install --dev`: always the currently running Node binary, never a bundled `runtime/`
  // folder that might coincidentally exist under a source checkout.
  const keepRuntime =
    options.fromExtension &&
    priorInstallJson &&
    (priorInstallJson.runtime.source === "bundled" ||
      (deps.env.ELECTRON_RUN_AS_NODE === "1" && priorInstallJson.runtime.source === "node"));
  const runtimeSource: "bundled" | "node" | "electron" = keepRuntime
    ? priorInstallJson.runtime.source
    : options.fromExtension
      ? deps.env.ELECTRON_RUN_AS_NODE === "1"
        ? "electron"
        : "node"
      : isDev
        ? "node"
        : (await pathExists(runtimeCandidate))
          ? "bundled"
          : "node";
  const nodeBinary = keepRuntime
    ? priorInstallJson.runtime.path
    : runtimeSource === "bundled"
      ? runtimeCandidate
      : (deps.runtimeExecutable ?? process.execPath);

  // P2: the plan step runs the same self-healing browser check `SetupController.runSetup()` runs
  // per workspace, so a missing browser is reported here -- including under `--dry-run`, which
  // never reaches `runSetup()` at all -- instead of only surfacing once the "Agents" step begins.
  let browserWarning: string | undefined;
  try {
    await deps
      .createSetupService(deps, () => workspaces[0])
      .ensureBrowserChannel({ readOnly: !!options.dryRun });
  } catch (error) {
    browserWarning = error instanceof Error ? error.message : String(error);
  }

  // §4.3 item 4: a read-only preview of any workspace-file entry this run would remove because its
  // opt-in is off (e.g. a prior version's default write). `identityFor` alone (no env) is enough
  // for this classification -- see `findDemotableWorkspaceFiles`'s doc comment.
  const previewIdentity = identityFor({ home, platform: deps.platform });
  const integrationVariables = integrationVariablesFor({
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir()
  });
  const plannedRemovals = await findDemotableWorkspaceFiles({
    workspaces,
    selection,
    definition: { command: previewIdentity.command, args: previewIdentity.args },
    variables: integrationVariables
  });

  printPlan((line) => deps.stdout(`${line}\n`), {
    locale,
    version,
    home,
    runtimeSource,
    workspaces,
    selection,
    detected,
    policies,
    yes: !!options.yes,
    plannedRemovals
  });
  if (browserWarning) deps.stderr(`! ${browserWarning}\n`);

  // `clientReports`/`isClientFile`/the plain-text report track the *workspace/project*-scope
  // writers only (matching the existing `.vscode/mcp.json`/`.mcp.json` file attribution below); the
  // default, zero-touch user-scope writers get their own `report.vscodeUser`/`report.claudeUser`
  // fields, populated only once the run actually reaches them (never under `--dry-run` or a
  // declined confirmation) -- the printed plan is what previews those under `--dry-run`.
  const selectedFor = (id: ClientId): boolean =>
    id === "vscode" ? selection.vscodeWorkspace : id === "claude" ? selection.claudeProject : selection.codex;

  if (options.dryRun) {
    deps.stdout(`${t("installDryRunNotice")}\n`);
    return {
      dryRun: true,
      confirmed: false,
      version,
      home,
      runtime: { path: nodeBinary, source: runtimeSource },
      clients: CLIENT_IDS.map((id) => ({
        id,
        detected: !!detected.find((entry) => entry.id === id)?.installed,
        selected: selectedFor(id),
        files: []
      })),
      workspaces: workspaces.map((root) => ({ root, agentsRegistered: 0, agentsFailed: 0, files: [] })),
      uninstallCommand: "m365-agent self uninstall",
      verified: false,
      migrations: plannedRemovals.map(({ workspace, file }) => ({ workspace, file })),
      instructions: [],
      exitCode: 0
    };
  }

  // §3.1's Consent rule (P0-3): `--yes` answers *only* this install-plan confirmation. The
  // agent-roster approval and the capability-widening consent below go through the host's own
  // `confirm()`, driven by the unwrapped prompter plus `--approve-agents`/`--allow-actions-possible`
  // (see `createTerminalSetupHost` below) -- `--yes` never reaches either of those.
  const planPrompter = withYes(deps.prompter, !!options.yes);
  const confirmed = await planPrompter.confirm(t("installConfirmPrompt"));
  if (!confirmed) {
    deps.stdout(`${t("installNotConfirmed")}\n`);
    return {
      dryRun: false,
      confirmed: false,
      version,
      home,
      runtime: { path: nodeBinary, source: runtimeSource },
      clients: CLIENT_IDS.map((id) => ({
        id,
        detected: !!detected.find((entry) => entry.id === id)?.installed,
        selected: false,
        files: []
      })),
      workspaces: [],
      uninstallCommand: "m365-agent self uninstall",
      verified: false,
      migrations: [],
      instructions: [],
      exitCode: 1
    };
  }

  /* -------------------------------------------------------------- stage */
  const identity =
    runtimeSource === "electron"
      ? { command: nodeBinary, args: [path.join(home, "app", version, "dist", "cli", "index.js"), "serve"] }
      : identityFor({ home, platform: deps.platform });
  // P1-6: tracks how far staging got, so a failure after `stageVersion` can roll back the
  // half-installed `app/<version>` (best effort) instead of leaving `self status`/`self use`
  // pointing at a version with no runtime or launchers. Never set when this version was already
  // staged in place (`install --dev` and the "already staged" branch below) -- there is nothing of
  // ours to roll back in either case, and the former would delete the very checkout being run.
  let stagedVersionPath: string | undefined;
  let migratedRemovals: PlannedRemoval[];
  try {
    deps.stdout(`${t("installStaging")}\n`);
    // P1-12: current-user-only from the first byte written under `<home>`, on the same footing as
    // `initializeLocalState`'s app-data root (src/config/init.ts) -- `<home>` is deliberately a
    // separate tree (docs/extension-less-onboarding.md §4.2) so it needs its own privacy pass.
    await ensurePrivateDirectories([home, path.join(home, "bin"), path.join(home, "app")]);
    if (isDev) {
      deps.stdout(`${t("installDevNotice")}\n`);
    } else {
      const alreadyStaged = path.resolve(packageRoot) === path.resolve(home, "app", version);
      if (alreadyStaged) deps.stdout(`${t("installStagingSkipped")}\n`);
      else {
        await stageVersion({ sourceDir: packageRoot, home, version });
        stagedVersionPath = path.join(home, "app", version);
      }
    }
    if (runtimeSource !== "electron" && !keepRuntime)
      await installRuntime({
        nodeBinary,
        home,
        platform: deps.platform,
        ...(deps.exec ? { exec: deps.exec } : {})
      });
    // P1-5: a bundled runtime's version is only knowable by asking the binary we just copied.
    // `process.version` is right for the "system Node" case (that *is* the binary being recorded)
    // and would be a lie for the bundled one.
    const nodeVersion =
      runtimeSource === "bundled"
        ? await probeRuntimeVersion(identity.command, deps.exec)
        : process.version.replace(/^v/, "");
    await writeLaunchers({
      home,
      version,
      platform: deps.platform,
      ...(runtimeSource === "electron" ? { electronBinary: nodeBinary } : {}),
      ...(isDev ? { devEntry: path.join(packageRoot, "dist", "cli", "index.js") } : {})
    });

    const existingInstallJson = priorInstallJson;
    // §4.4: an `install.json` written before the user-scope defaults existed recorded the bare
    // vendor tokens `"vscode"`/`"claude"`, meaning the workspace/project-scope file it defaulted to
    // back then -- map them onto their explicit spellings so the historical record is not silently
    // dropped from `migrateLegacyEntries`'s bookkeeping.
    const clientsWritten = new Set(
      [...(existingInstallJson?.clients ?? [])].map((token) =>
        token === "vscode" ? "vscode-workspace" : token === "claude" ? "claude-project" : token
      )
    );
    if (selection.vscodeUser) clientsWritten.add("vscode-user");
    if (selection.vscodeWorkspace) clientsWritten.add("vscode-workspace");
    if (selection.claudeUser) clientsWritten.add("claude-user");
    if (selection.claudeProject) clientsWritten.add("claude-project");
    if (selection.codex) clientsWritten.add("codex");
    const workspacesRecorded = new Set(existingInstallJson?.workspaces ?? []);
    for (const workspace of workspaces) workspacesRecorded.add(workspace);
    await writeInstallJson(home, {
      version,
      installedBy: isDev ? "source" : options.fromExtension ? "vsix" : "archive",
      runtime: {
        // §4.7 C2 `install --dev`: `install.json` records the *original* running binary, not the
        // copy at `<home>/bin/node` (which still exists -- installRuntime() above always makes
        // one -- so a host that only ever spawns `<home>/bin/node` still has something real to run).
        path: isDev ? process.execPath : identity.command,
        source: runtimeSource,
        ...(nodeVersion ? { nodeVersion } : {})
      },
      identity,
      clients: [...clientsWritten].sort(),
      workspaces: [...workspacesRecorded].sort(),
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });

    // ISSUE-11 (docs/validation-log-2026-09-14-windows-round3.md S2): from here on, every broker
    // this same `install` process spawns (its own `SetupController.runSetup()` below, and
    // `restartPreExistingBroker`'s recovery retry) must run the machine install this run just
    // staged -- `<home>/app/<version>/dist/broker/process.js` with `<home>/bin/node(.exe)` -- never
    // this running process's own tree. Without this, `spawnBundledBroker()`'s default
    // (`import.meta.url`-relative) entry resolves to wherever *this* process's own code lives (a
    // portable extraction folder, for instance), so the freshly installed machine's `doctor` keeps
    // reporting `install.brokerInstallRoot` even after a successful install. Skipped for `--dev`
    // (nothing was staged to point at -- `spawnBundledBroker()`'s default already resolves to this
    // same checkout) and for the electron runtime (only reachable via `--from-extension`, which
    // never runs `SetupController` in this loop at all -- see the `options.fromExtension` branch
    // below).
    if (!isDev && runtimeSource !== "electron")
      setBrokerSpawnTarget({
        entry: path.join(home, "app", version, "dist", "broker", "process.js"),
        node: identity.command
      });

    const userScopeDefinition = machineDefinition({
      home,
      platform: deps.platform,
      version,
      appDataOverride: deps.env.M365_AGENT_APP_DATA,
      identity,
      electron: runtimeSource === "electron"
    });

    // §4.7 C7: converge every workspace this machine has ever recorded (not only the ones passed
    // this run) onto the identity above, before this run's own Save writes below.
    await migrateLegacyEntries({
      definition: userScopeDefinition,
      homeDirectory: deps.homedir(),
      workspaces: workspacesRecorded,
      clientsWritten,
      variables: integrationVariablesFor({ env: deps.env, platform: deps.platform, homedir: deps.homedir() }),
      vscodeUserDirectory,
      claudeCliAvailable,
      exec: deps.exec
    });

    // §4.3 item 4: for *this run's* workspaces only, remove a managed/legacy `.vscode/mcp.json` /
    // `.mcp.json` entry whose opt-in is not selected this time -- e.g. a prior version's default
    // write -- so VS Code stops asking to trust the folder and Claude Code stops asking to approve
    // the project server. Never touches a foreign entry.
    migratedRemovals = await demoteUnselectedWorkspaceFiles({
      workspaces,
      selection,
      definition: userScopeDefinition,
      homeDirectory: deps.homedir(),
      variables: integrationVariablesFor({ env: deps.env, platform: deps.platform, homedir: deps.homedir() })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { code: verifyErrorCode, remediation: verifyErrorRemediation } = domainErrorMeta(error);
    // P1-6: `stageVersion` itself succeeded (we own `stagedVersionPath`) but a later step in this
    // block failed -- best-effort delete the half-installed version rather than leaving it for
    // `self status`/`self use` to discover in a broken state.
    if (stagedVersionPath)
      await fs.rm(stagedVersionPath, { recursive: true, force: true }).catch(() => undefined);
    const remainingVersions = await listVersions(home).catch(() => []);
    const launchersRemain = await pathExists(path.join(home, "bin", "apl.js"));
    const partial =
      remainingVersions.length > 0
        ? `versions still on disk: ${remainingVersions.join(", ")}`
        : launchersRemain
          ? "bin/apl.js from a previous install remains on disk"
          : undefined;
    return {
      dryRun: false,
      confirmed: true,
      version,
      home,
      runtime: { path: identity.command, source: runtimeSource },
      clients: [],
      workspaces: [],
      uninstallCommand: "m365-agent self uninstall",
      verified: false,
      verifyError: partial ? `${message} (partial install left: ${partial})` : message,
      ...(verifyErrorCode ? { verifyErrorCode } : {}),
      ...(verifyErrorRemediation ? { verifyErrorRemediation } : {}),
      migrations: [],
      instructions: [],
      exitCode: partial ? 3 : 1
    };
  }

  /* -------------------------------------------------------------- agents + clients, per workspace */
  const ownBrokerEntry = path.join(packageRoot, "dist", "broker", "process.js");
  const brokerEntry = await resolveBrokerEntry(home, ownBrokerEntry);
  const integrations = toIntegrationFlags(selection);
  const clientFiles = new Map<ClientId, Set<string>>(CLIENT_IDS.map((id) => [id, new Set<string>()]));
  const workspaceReports: InstallWorkspaceReport[] = [];
  let discoverySnapshot: PanelState | undefined;

  for (const workspace of workspaces) {
    if (options.fromExtension) {
      const files = [path.join(workspace, ".m365-agents.json")];
      // `--from-extension` reuses whatever workspace/project-scope files the VSIX already wrote
      // (its own settings, `agentpicklink.integrations.*`, are unchanged in meaning); the
      // user-scope `vscodeUser`/`claudeUser` writers below run independently of this loop.
      for (const id of CLIENT_IDS) {
        const file =
          id === "vscode"
            ? path.join(workspace, ".vscode", "mcp.json")
            : id === "claude"
              ? path.join(workspace, ".mcp.json")
              : path.join(deps.homedir(), ".codex", "config.toml");
        const isSelected =
          id === "vscode"
            ? selection.vscodeWorkspace
            : id === "claude"
              ? selection.claudeProject
              : selection.codex;
        if (isSelected && (await pathExists(file))) {
          clientFiles.get(id)!.add(file);
          files.push(file);
        }
      }
      workspaceReports.push({
        root: workspace,
        agentsRegistered: 0,
        agentsFailed: 0,
        files: (
          await Promise.all(files.map(async (file) => ((await pathExists(file)) ? file : undefined)))
        ).filter((file): file is string => !!file)
      });
      continue;
    }
    deps.stdout(`${t("installAgentsStep").replace("{workspace}", workspace)}\n`);
    const service = deps.createSetupService(deps, () => workspace);
    // §3.1's Consent rule (P0-3): the *unwrapped* prompter -- `--yes` must never reach the
    // roster/widening confirms below, only the install-plan confirm already answered above.
    const hostOptions: TerminalSetupHostOptions = {
      locale,
      version,
      paths: deps.paths,
      installHome: home,
      platform: deps.platform,
      workspaceRoot: workspace,
      brokerEntry,
      out: (line) => deps.stdout(`${line}\n`),
      prompter: deps.prompter,
      env: deps.env,
      homedir: deps.homedir,
      yes: !!options.yes,
      approveAgents: !!options.approveAgents,
      allowActionsPossible: !!options.allowActionsPossible,
      verboseOut: options.verbose ? (text) => deps.stderr(`${text}\n`) : undefined
    };
    const host = options.browser
      ? await runBrowserSetup(
          deps,
          hostOptions,
          packageRoot,
          !!options.noOpen,
          discoverySnapshot,
          integrations
        )
      : await createTerminalSetupHost(hostOptions);
    let workspaceError: string | undefined;
    // ISSUE-03 (docs/validation-log-2026-09-14-windows.md): metadata alongside `workspaceError`, so
    // the text report can show a code + remediation line via `describeErrorCode` instead of only a
    // message -- see `InstallWorkspaceReport.errorCode`'s doc comment.
    let workspaceErrorCode: string | undefined;
    let workspaceErrorRemediation: string | undefined;
    // WP-D: captured from the pre-Save discovery snapshot below -- SetupController.save() clears
    // `discoverySummary` once it reaches "done", so this has to be read before `controller.save()`
    // runs, not from the workspace report's own later `host.lastPanelState()` calls.
    let discoveryPartial: true | undefined;
    let discoveryFailedCount: number | undefined;
    if (!options.browser) {
      const controller = new SetupController(host, () => service);
      if (discoverySnapshot) await controller.reuseDiscovery(discoverySnapshot);
      else await runSetupWithBrokerRecovery(controller, host, deps, brokerPreExisting, t);
      const state = host.lastPanelState();
      if (state?.phase !== "error") discoverySnapshot = state;
      if (state?.discoverySummary?.partial) {
        discoveryPartial = true;
        discoveryFailedCount = state.discoverySummary.failedCount;
      }
      if (state?.phase === "error" && state.error) {
        // ISSUE-03/ISSUE-06: `runSetup`/`reuseDiscovery` already failed (sign-in, discovery, a stale
        // broker restart that never came back...) before a single candidate was fetched. Report that
        // real cause directly rather than falling through to `selectAgents()` below, which would
        // otherwise mask it behind a confusing "no interactive terminal"/"unknown agent alias"
        // (candidates is always empty here) -- see docs/validation-log-2026-09-14-windows.md's
        // `BROWSER_START_FAILED / AGENT_NOT_FOUND` pairing.
        workspaceError = state.error.message;
        workspaceErrorCode = state.error.code;
        workspaceErrorRemediation = state.error.remediation;
      } else {
        const candidates = state?.candidates ?? [];
        const candidatesByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
        const preSelected = state?.selectedKeys ?? [];
        const selectedKeys = await selectAgents(
          deps,
          locale,
          candidates,
          preSelected,
          options.agents,
          !!options.yes
        );

        // P0-1: mirror media/setup.js's own default (~334-335) -- an already-registered agent keeps
        // its registered capability class unless something explicitly says otherwise. Sending `{ key }`
        // alone would make buildApplyPlan() default to "knowledge-only" and silently downgrade a
        // registered actions-possible agent on every later re-run.
        let agentInputs = selectedKeys.map((key) => ({
          key,
          actionsPossible: candidatesByKey.get(key)?.registered?.capabilityClass === "actions-possible"
        }));

        // §3.1's Consent rule (P0-3): non-interactively, without --allow-actions-possible, an
        // actions-possible candidate is dropped from the plan (named here) before the capability-
        // widening consent would even be needed. Interactively, the terminal's own confirm() dialog is
        // always shown regardless of this flag, so nothing is dropped there.
        if (!deps.prompter.interactive && !options.allowActionsPossible) {
          const dropped = agentInputs.filter((agent) => agent.actionsPossible);
          if (dropped.length > 0) {
            const names = dropped.map((agent) => candidatesByKey.get(agent.key)?.displayName ?? agent.key);
            deps.stderr(`${t("installActionsPossibleDropped").replace("{names}", names.join(", "))}\n`);
            agentInputs = agentInputs.filter((agent) => !agent.actionsPossible);
          }
        }

        // §3.1's Consent rule (P0-3): --yes never answers the roster approval; non-interactively,
        // without --approve-agents, a non-empty roster fails closed here (rather than only inside
        // TerminalSetupHost.confirm(), which would refuse identically but without a place to name the
        // missing flag).
        if (!deps.prompter.interactive && !options.approveAgents && agentInputs.length > 0) {
          workspaceError = t("installApproveAgentsRequired");
          deps.stderr(`${workspaceError}\n`);
        } else {
          await controller.save({
            agents: agentInputs,
            downloadHosts: [...(state?.status?.config.downloadHosts ?? [])],
            acceptDownloads: state?.status?.config.acceptDownloads ?? true,
            integrations
          });
          // P0-2: `SetupController.save()` swallows its own errors into `PanelState.phase === "error"`
          // (via `exclusive()`) and also returns early with no summary at all when the roster
          // confirmation was declined -- neither path throws, so both have to be detected by
          // re-reading the host's own state rather than trusting that reaching this line means Save
          // actually completed. An *empty* plan is `save()`'s own benign "nothing selected" branch
          // (also no summary, by design -- see setup-controller.ts) and is never a failure on its own,
          // which is exactly the outcome of the actions-possible drop above.
          if (agentInputs.length > 0) {
            const savedState = host.lastPanelState();
            if (!host.savedSummary() || savedState?.phase === "error") {
              workspaceError = savedState?.error?.message ?? t("installSaveFailed");
              workspaceErrorCode = savedState?.error?.code;
              workspaceErrorRemediation = savedState?.error?.remediation;
            }
          }
        }
      }

      controller.dispose();
    }
    if (options.browser) discoverySnapshot = host.lastPanelState();
    const summary = host.savedSummary();
    for (const file of summary?.written ?? []) {
      for (const id of CLIENT_IDS)
        if (isClientFile(id, file, workspace, deps.homedir())) clientFiles.get(id)!.add(file);
    }
    // P0-2/P2: never claim `.m365-agents.json` was written unless it actually exists (a declined
    // or failed-closed Save never creates it); a written client file is attributed to this
    // workspace only when it genuinely resolves inside it (P2: `path.relative`, rejecting `..`,
    // rather than a bare `startsWith` that a sibling directory sharing a name prefix could pass).
    const workspaceFile = path.join(workspace, ".m365-agents.json");
    const files = [
      ...((await pathExists(workspaceFile)) ? [workspaceFile] : []),
      ...[...(summary?.written ?? [])].filter((file) => isWithinWorkspace(file, workspace))
    ];
    workspaceReports.push({
      root: workspace,
      agentsRegistered: summary?.registered ?? 0,
      agentsFailed: summary?.failed ?? 0,
      files: [...new Set(files)],
      ...(workspaceError ? { error: workspaceError } : {}),
      ...(workspaceErrorCode ? { errorCode: workspaceErrorCode } : {}),
      ...(workspaceErrorRemediation ? { errorRemediation: workspaceErrorRemediation } : {}),
      ...(discoveryPartial ? { partial: discoveryPartial, failedCount: discoveryFailedCount } : {})
    });
  }

  /* -------------------------------------------------------------- vscode-user / claude-user (§4.4, once) */
  // Both are per-machine, workspace-independent files (§4.4: no `cwd`; the Claude Code entry is
  // scoped by `claude mcp ... --scope user` / the top-level key of `~/.claude.json`), so each is
  // written at most once per `install` run regardless of how many workspaces were given.
  const userScopeDefinitionForReport = machineDefinition({
    home,
    platform: deps.platform,
    version,
    appDataOverride: deps.env.M365_AGENT_APP_DATA,
    identity,
    electron: runtimeSource === "electron"
  });
  let vscodeUserSummary: IntegrationSummary | undefined;
  if (selection.vscodeUser) {
    if (!vscodeUserDirectory)
      vscodeUserSummary = { written: [], skipped: [t("installVscodeUserSkippedNoUserDir")] };
    else {
      // ISSUE-2026-09-14-14: create it now, current-user-default permissions (this is VS Code's own
      // directory tree, not one of AgentPickLink's sensitive stores, so `ensurePrivateDirectory`'s
      // forced 0700/ACL lockdown does not apply here -- a plain, recursive mkdir matches what VS
      // Code itself would create on first run).
      if (vscodeUserDirNeedsCreate) {
        await fs.mkdir(vscodeUserDirectory, { recursive: true });
        deps.stdout(`${t("installVscodeUserDirCreated")}\n`);
      }
      vscodeUserSummary = await applyIntegrations(
        { definition: userScopeDefinitionForReport, homeDirectory: deps.homedir(), vscodeUserDirectory },
        { codex: false, claudeCode: false, vscodeMcpJson: false, vscodeUser: true }
      );
    }
    for (const line of [...vscodeUserSummary.skipped, ...(vscodeUserSummary.warnings ?? [])])
      deps.stderr(`${line}\n`);
  }
  let claudeUserSummary: IntegrationSummary | undefined;
  if (selection.claudeUser) {
    claudeUserSummary = await applyIntegrations(
      {
        definition: userScopeDefinitionForReport,
        homeDirectory: deps.homedir(),
        claudeCliAvailable,
        exec: deps.exec
      },
      { codex: false, claudeCode: false, vscodeMcpJson: false, claudeUser: true }
    );
    for (const line of claudeUserSummary.skipped) deps.stderr(`${line}\n`);
  }

  /* -------------------------------------------------------------- verify */
  let verified = false;
  let verifyError: string | undefined;
  let verifyErrorCode: string | undefined;
  let verifyErrorRemediation: string | undefined;
  const doctorReports: NonNullable<InstallReport["doctor"]> = [];
  const verifyWorkspace = workspaces[0];
  try {
    deps.stdout(`${t("installVerifying")}\n`);
    // P2: the identity's own env (the ownership marker + build stamp) plus a small, curated
    // passthrough of the OS-level variables a spawned Node actually needs -- never the whole
    // `process.env`, which the verify child has no business inheriting wholesale.
    const verifyDefinition = machineDefinition({
      home,
      platform: deps.platform,
      version,
      appDataOverride: deps.env.M365_AGENT_APP_DATA,
      identity,
      electron: runtimeSource === "electron"
    });
    const result = await deps.mcpHandshake({
      command: verifyDefinition.command,
      args: verifyDefinition.args,
      env: { ...essentialEnvPassthrough(deps.env), ...verifyDefinition.env },
      cwd: verifyWorkspace,
      timeoutMs: 20_000
    });
    // P2: exactly these three tools -- neither missing nor an unexpected extra/duplicate.
    const expectedTools = new Set(["m365_agent_ask", "m365_agent_list", "m365_agent_session"]);
    const gotTools = new Set(result.tools);
    verified =
      gotTools.size === result.tools.length &&
      gotTools.size === expectedTools.size &&
      [...expectedTools].every((tool) => gotTools.has(tool));
    if (!verified)
      verifyError = `Expected tools ${[...expectedTools].join(", ")}; got ${result.tools.join(", ")}`;
  } catch (error) {
    verifyError = error instanceof Error ? error.message : String(error);
    ({ code: verifyErrorCode, remediation: verifyErrorRemediation } = domainErrorMeta(error));
  }
  for (const workspace of workspaces) {
    try {
      const scopedDeps = {
        ...deps,
        root: () => workspace,
        env: { ...deps.env, M365_AGENT_INSTALL_ROOT: home }
      };
      const diagnosis = await (deps.diagnose ?? runDoctor)(scopedDeps);
      const findings = Array.isArray(diagnosis.findings)
        ? diagnosis.findings.filter((item): item is string => typeof item === "string")
        : [];
      doctorReports.push({ workspace, ok: diagnosis.ok === true, findings });
      if (diagnosis.ok !== true) {
        verified = false;
        verifyError ??= t("installDoctorFailed");
      }
    } catch {
      doctorReports.push({ workspace, ok: false, findings: ["doctor.failed"] });
      verified = false;
      verifyError ??= t("installDoctorFailed");
    }
  }
  if (!verified) deps.stderr(`${t("installVerifyFailed")}\n`);

  /* -------------------------------------------------------------- report */
  // P1-8: the fallback snippet must carry the full definition (the ownership marker and the build
  // stamp), not bare command/args -- otherwise a manually-applied snippet is a foreign entry
  // forever (§4.7 C6: no marker means it never converges on a later `apl-setup` run).
  const fallbackDefinition = userScopeDefinitionForReport;
  const snippetTokenFor = (id: ClientId): "vscode-workspace" | "claude-project" | "codex" =>
    id === "vscode" ? "vscode-workspace" : id === "claude" ? "claude-project" : "codex";
  const clientReports: InstallClientReport[] = CLIENT_IDS.map((id) => {
    const files = [...(clientFiles.get(id) ?? [])];
    const blocked = policies.find((finding) => finding.client === id && finding.blocks);
    const selected = selectedFor(id);
    return {
      id,
      detected: !!detected.find((entry) => entry.id === id)?.installed,
      ...(blocked ? { policyBlocked: { policy: blocked.policy, value: blocked.value } } : {}),
      selected,
      files,
      ...(selected && files.length === 0 && !blocked
        ? { snippet: snippetFor(snippetTokenFor(id), fallbackDefinition) }
        : {})
    };
  });
  const vscodeUserWritten = (vscodeUserSummary?.written.length ?? 0) > 0;
  const claudeUserWritten = (claudeUserSummary?.written.length ?? 0) > 0;
  const vscodeWorkspaceWritten = clientReports.find((client) => client.id === "vscode")!.files.length > 0;
  const claudeProjectWritten = clientReports.find((client) => client.id === "claude")!.files.length > 0;
  const anyClientWritten =
    clientReports.some((client) => client.files.length > 0) || vscodeUserWritten || claudeUserWritten;
  const instructions = [
    t("installNextStepsHeader"),
    ...(vscodeUserWritten || vscodeWorkspaceWritten ? [t("installNextStepsVscode")] : []),
    ...(claudeUserWritten || claudeProjectWritten ? [t("installNextStepsClaude")] : []),
    ...(selection.codex ? [t("installNextStepsCodex")] : []),
    t("installNextStepsIncident")
  ];

  // P0-2: any workspace whose Save did not actually complete forces exit 3, on the same footing as
  // a failed verify.
  const anyWorkspaceError = workspaceReports.some((workspace) => workspace.error);
  const exitCode: InstallReport["exitCode"] = !verified || anyWorkspaceError ? 3 : anyClientWritten ? 0 : 2;
  // item 1: when this run recorded a BROWSER_START_FAILED (staging/verify or any workspace's own
  // Save), print broker.log's path and its last 20 lines (metadata only) alongside the failure.
  const browserStartFailed =
    verifyErrorCode === "BROWSER_START_FAILED" ||
    workspaceReports.some((workspace) => workspace.errorCode === "BROWSER_START_FAILED");
  const brokerLog = browserStartFailed
    ? { path: brokerLogPath(deps.paths.logs), tail: await readBrokerLogTail(deps.paths.logs, 20) }
    : undefined;
  return {
    dryRun: false,
    confirmed: true,
    version,
    home,
    runtime: { path: identity.command, source: runtimeSource },
    clients: clientReports,
    ...(vscodeUserSummary ? { vscodeUser: vscodeUserSummary } : {}),
    ...(claudeUserSummary ? { claudeUser: claudeUserSummary } : {}),
    workspaces: workspaceReports,
    uninstallCommand: "m365-agent self uninstall",
    verified,
    doctor: doctorReports,
    ...(verifyError ? { verifyError } : {}),
    ...(verifyErrorCode ? { verifyErrorCode } : {}),
    ...(verifyErrorRemediation ? { verifyErrorRemediation } : {}),
    migrations: migratedRemovals.map(({ workspace, file }) => ({ workspace, file })),
    instructions,
    ...(brokerLog ? { brokerLog } : {}),
    exitCode
  };
}

function isClientFile(id: ClientId, file: string, workspace: string, homedir: string): boolean {
  if (id === "codex") return file === path.join(homedir, ".codex", "config.toml");
  if (id === "vscode") return file === path.join(workspace, ".vscode", "mcp.json");
  return file === path.join(workspace, ".mcp.json");
}

/** P2: `path.relative`-based containment check, rejecting `..` -- a bare `file.startsWith(workspace)`
 * would also match a sibling directory that merely shares `workspace` as a string prefix (e.g.
 * `/repo` matching a written file under `/repo-other/`). */
function isWithinWorkspace(file: string, workspace: string): boolean {
  const relative = path.relative(workspace, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** P2: the small, curated set of OS-level variables a spawned Node process actually needs, used by
 * the verify step instead of forwarding the whole `process.env` -- the identity's own env (the
 * ownership marker and the build stamp) is what actually matters for the handshake; this is only
 * what keeps the child able to start at all on every platform. */
const ENV_PASSTHROUGH_KEYS = [
  "PATH",
  "Path",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA"
] as const;

function essentialEnvPassthrough(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ENV_PASSTHROUGH_KEYS) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Plain-text rendering of `InstallReport` for a non-`--json` run. */
/**
 * ISSUE-03: one `失敗: <CODE> — <remediation>` / `Failed: <CODE> — <remediation>` line for a
 * captured failure -- `describeErrorCode`'s localized remediation wins when the dictionary has one
 * for `code`, then the raw English remediation captured alongside it (several codes, e.g.
 * BROWSER_START_FAILED/AGENT_NOT_FOUND, have no localized remediation at all), then the plain
 * message as a last resort. Without a `code` at all (a plain `Error`, not a `DomainError`) this
 * still prints the message alone -- previously the text report showed neither for `verifyError`/a
 * workspace `error` at all, only the generic "no client files" style lines.
 */
function formatFailureLine(
  locale: Locale,
  code: string | undefined,
  remediation: string | undefined,
  message: string | undefined
): string | undefined {
  const label = locale === "ja" ? "失敗" : "Failed";
  if (!code) return message ? `${label}: ${message}` : undefined;
  const described = describeErrorCode(locale, code);
  const detail = described?.remediation ?? remediation ?? message ?? described?.summary;
  return `${label}: ${code}${detail ? ` — ${detail}` : ""}`;
}

export function formatInstallReport(report: InstallReport, locale: Locale = "en"): string {
  const t = translator(locale);
  const lines: string[] = [t("installReportHeader")];
  lines.push(`${t("cliVersionLabel")}: ${report.version}`);
  lines.push(`${t("cliHomeLabel")}: ${report.home}`);
  lines.push(`${t("cliRuntimeLabel")}: ${report.runtime.path} (${report.runtime.source})`);
  // ISSUE-03: surface the staging/verification failure reason -- previously `verifyError` reached
  // only the JSON output (`--json`), never the plain-text report.
  if ((report.exitCode === 1 || report.exitCode === 3) && report.verifyError) {
    const line = formatFailureLine(
      locale,
      report.verifyErrorCode,
      report.verifyErrorRemediation,
      report.verifyError
    );
    if (line) lines.push(line);
  }
  for (const client of report.clients) {
    if (client.files.length > 0) for (const file of client.files) lines.push(`${client.id}: ${file}`);
    else if (client.snippet) lines.push(`${client.id}: ${t("installClientSnippetLabel")}\n${client.snippet}`);
  }
  if (!report.clients.some((client) => client.files.length > 0)) lines.push(t("installReportNoClients"));
  if (report.vscodeUser) {
    for (const file of report.vscodeUser.written) lines.push(`vscode-user: ${file}`);
    for (const reason of [...report.vscodeUser.skipped, ...(report.vscodeUser.warnings ?? [])])
      lines.push(`vscode-user: ${reason}`);
  }
  if (report.claudeUser) {
    for (const file of report.claudeUser.written) lines.push(`claude-user: ${file}`);
    for (const reason of report.claudeUser.skipped) lines.push(`claude-user: ${reason}`);
  }
  for (const workspace of report.workspaces) {
    lines.push(`${t("cliWorkspaceLabel")}: ${workspace.root}`);
    for (const file of workspace.files) lines.push(`  ${file}`);
    const partialNotice = workspace.partial
      ? describeDiscoverySummary({ partial: true, failedCount: workspace.failedCount }, locale)
      : undefined;
    if (partialNotice) lines.push(`  ${partialNotice}`);
    // ISSUE-03: same treatment as `verifyError` above, for a per-workspace failure (a declined/
    // failed-closed Save, or `runSetup`/`reuseDiscovery` failing before any candidate was fetched).
    if ((report.exitCode === 1 || report.exitCode === 3) && workspace.error) {
      const line = formatFailureLine(
        locale,
        workspace.errorCode,
        workspace.errorRemediation,
        workspace.error
      );
      if (line) lines.push(`  ${line}`);
    }
  }
  for (const removal of report.migrations)
    lines.push(`${report.dryRun ? "would remove" : "removed"}: ${removal.file}`);
  // item 1: printed only when a BROWSER_START_FAILED was recorded (see runInstall's `brokerLog`).
  if (report.brokerLog) {
    lines.push(`broker.log: ${report.brokerLog.path}`);
    for (const line of report.brokerLog.tail) lines.push(`  ${line}`);
  }
  lines.push(`${t("installUninstallHint")} ${report.uninstallCommand}`);
  lines.push(...report.instructions);
  if (report.doctor)
    for (const item of report.doctor)
      lines.push(
        `${t("installDoctorResult")}: ${item.ok ? "OK" : item.findings.join(", ") || t("cliFailed")}`
      );
  return lines.join("\n");
}
