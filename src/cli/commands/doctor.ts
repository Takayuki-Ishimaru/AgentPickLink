import { parseVscodeSettings } from "../../services/jsonc-settings.js";
import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { DomainError } from "../../domain/errors.js";
import type { ToolError } from "../../frontend/schemas.js";
import {
  checkClientPolicies,
  defaultClientPolicyIo,
  type PolicyFinding
} from "../../services/client-policy.js";
import { vscodeUserDir } from "../../services/client-detection.js";
import { HealthService } from "../../services/health-service.js";
import { integrationVariablesFor, readInstallJson, resolveInstallHome } from "../../services/install-home.js";
import {
  MCP_SERVER_NAME,
  expandIntegrationValue,
  integrationEntryStatus,
  parseCodexEntry,
  parseJsonEntry,
  type IntegrationEntryStatus,
  type IntegrationKind
} from "../../services/integrations.js";
import { compareVersions } from "../../services/update-checker.js";
import { brokerLogPath, readBrokerLogTail } from "../../observability/broker-log.js";
import type { CommandDeps } from "../command-deps.js";
import { toToolError } from "../ui/formatter.js";
import { resolveStandaloneDefinition } from "./integrations.js";

const execFileAsync = promisify(execFile);

/** §P2: how much of an external command's stdout/stderr may reach the report. `--version` output is
 * one short line; anything longer is a binary that is not what `install.json` claims it is, and its
 * output has no business being copied into a diagnostics dump verbatim. */
const MAX_VERSION_OUTPUT_CHARS = 64;
const MAX_ERROR_CHARS = 200;
/** The shape `node --version` (and every runtime we would accept) answers with. */
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+/;
/** The same directory-name-safe version alphabet `install-home.ts` enforces for `app/<version>`;
 * `aplJsTarget` is scraped out of a file a user can hand-edit, so it is validated, not trusted. */
const VERSION_DIRECTORY_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/* --------------------------------------------------------------- §4.7 C12 install_consistency */

/** §4.4: `vscode-user`/`claude-user` are the default, zero-touch user-scope files; `vscode-
 * workspace`/`claude-project` are their opt-in workspace/project-scope counterparts. */
type DoctorClientId = "vscode-user" | "vscode-workspace" | "claude-user" | "claude-project" | "codex";
const DOCTOR_CLIENTS: readonly DoctorClientId[] = [
  "vscode-user",
  "vscode-workspace",
  "claude-user",
  "claude-project",
  "codex"
];

function kindFor(client: DoctorClientId): IntegrationKind {
  switch (client) {
    case "codex":
      return "codex";
    case "vscode-user":
      return "vscodeUser";
    case "vscode-workspace":
      return "vscodeMcpJson";
    case "claude-user":
      return "claudeUser";
    case "claude-project":
      return "claudeCode";
  }
}

function fileFor(client: DoctorClientId, deps: CommandDeps): string {
  switch (client) {
    case "codex":
      return path.join(deps.homedir(), ".codex", "config.toml");
    case "vscode-user":
      return path.join(
        vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() }),
        "mcp.json"
      );
    case "vscode-workspace":
      return path.join(deps.root(), ".vscode", "mcp.json");
    case "claude-user":
      return path.join(deps.homedir(), ".claude.json");
    case "claude-project":
      return path.join(deps.root(), ".mcp.json");
  }
}

async function readIfPresent(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

/** §4.7 C9/C12: the stored `command` may be the portable `${userHome}`/`${env:LOCALAPPDATA}` form,
 * which no `access()` can resolve as written -- expand it against this machine's own prefixes
 * first, exactly as the writer substituted them, so a perfectly good portable entry is not
 * reported as "written on another machine". */
async function commandResolves(
  command: string | undefined,
  kind: IntegrationKind,
  variables: ReturnType<typeof integrationVariablesFor>
): Promise<boolean | undefined> {
  if (!command) return undefined;
  try {
    await access(expandIntegrationValue(command, kind, variables));
    return true;
  } catch {
    return false;
  }
}

/** True when `entry` (any value under a `servers`/`mcpServers` key other than `m365-agents`)
 * looks like an AgentPickLink command line -- the shape §4.7 C6's `isLegacyEntrypoint` recognizes,
 * duplicated here (rather than exported) because this scans *every* key of the container, not the
 * one already-identified `m365-agents` entry `integrationEntryStatus` classifies. */
function looksLikeDuplicate(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const args = (entry as { args?: unknown }).args;
  if (!Array.isArray(args) || args.length < 2) return false;
  if (args[args.length - 1] !== "serve") return false;
  const beforeLast = args[args.length - 2];
  if (typeof beforeLast !== "string") return false;
  const normalized = beforeLast.replace(/\\/g, "/");
  return normalized.endsWith("dist/cli/index.js") || normalized.endsWith("bin/apl.js");
}

/** Other keys in a JSON `servers`/`mcpServers` container (VS Code, Claude Code) whose entry looks
 * like an AgentPickLink command line under a different name (§4.7 C6: "a differently named entry
 * pointing at AgentPickLink is reported as a duplicate"). */
function jsonDuplicateKeys(text: string, containerKey: "servers" | "mcpServers"): string[] {
  let document: unknown;
  try {
    document = containerKey === "servers" ? parseVscodeSettings(text).value : JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof document !== "object" || document === null) return [];
  const container = (document as Record<string, unknown>)[containerKey];
  if (typeof container !== "object" || container === null || Array.isArray(container)) return [];
  return Object.entries(container as Record<string, unknown>)
    .filter(([key, value]) => key !== MCP_SERVER_NAME && looksLikeDuplicate(value))
    .map(([key]) => key);
}

/** Same idea for Codex's `[mcp_servers.<name>]` tables. Unparseable TOML reports no duplicates
 * (the workspace-file `status` check below already reports the file unreadable on its own terms). */
function codexDuplicateKeys(text: string): string[] {
  let value: unknown;
  try {
    value = getStaticTOMLValue(parseTOML(text));
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null) return [];
  const servers = (value as Record<string, unknown>).mcp_servers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
  return Object.entries(servers as Record<string, unknown>)
    .filter(([key, entry]) => key !== MCP_SERVER_NAME && looksLikeDuplicate(entry))
    .map(([key]) => key);
}

export type DoctorClientFileReport = {
  client: DoctorClientId;
  file: string;
  status: IntegrationEntryStatus;
  /** `undefined` when the entry is absent; otherwise whether its recorded `command` exists on
   * this machine -- `false` means "written on another machine or user; re-run apl-setup" (§4.7
   * C9's `doctor` row). */
  commandResolvable?: boolean;
  /** Other keys in the same file that also look like an AgentPickLink command line (§4.7 C6). */
  duplicateKeys: string[];
};

export type DoctorInstallConsistency = {
  cliVersion: string;
  machineInstall?: { version: string; installedBy: string; runtimeSource: string; runtimePath: string };
  /** How `machineInstall.version` compares to `cliVersion` (§4.7 C4): `"none"` when they match,
   * `"cli-older"`/`"cli-newer"` otherwise, `"no-machine-install"` when there is none, `"unknown"`
   * when either version string could not be parsed. */
  versionSkew: "none" | "cli-older" | "cli-newer" | "no-machine-install" | "unknown";
  runtime: { path?: string; live: boolean; version?: string; error?: string };
  /** The version `<home>/bin/apl.js` currently imports from `app/<version>`, read directly off
   * that file rather than assumed from `install.json` -- the two can disagree if one was hand-edited
   * or a `self use` did not complete. */
  aplJsTarget?: string;
  clients: DoctorClientFileReport[];
  /** `chat.mcp.access` / `chat.mcp.collisionBehavior` / Claude Code / Codex policy findings
   * (`src/services/client-policy.ts`), unfiltered. */
  policies: PolicyFinding[];
  /**
   * docs/validation-log-2026-09-14-windows-round2.md R4 item 4: set only when a broker is
   * currently running and reports `build.entry` (the file it was actually started from), and that
   * path does not resolve under this machine's current install root (`resolveInstallHome`'s
   * `home`, above). This is exactly the shape of the R4 failure: a broker left running from a
   * *different* `M365_AGENT_INSTALL_ROOT`/HOME while sharing this same app-data root --
   * `restartBrokerIfStale` alone cannot always tell that broker is "the wrong one" (its
   * `packageVersion` can genuinely match), so this makes the situation visible on its own.
   * Absent when no broker is running, the running broker predates `build` metadata, or its entry
   * does resolve under the current install root.
   */
  brokerInstallRoot?: { entry: string; note: string };
};

async function checkInstallConsistency(deps: CommandDeps): Promise<DoctorInstallConsistency> {
  const home = resolveInstallHome({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
  const installJson = await readInstallJson(home).catch(() => undefined);

  const versionSkew: DoctorInstallConsistency["versionSkew"] = !installJson
    ? "no-machine-install"
    : (() => {
        const cmp = compareVersions(deps.version, installJson.version);
        if (cmp === undefined) return "unknown";
        return cmp === 0 ? "none" : cmp === 1 ? "cli-newer" : "cli-older";
      })();

  let runtime: DoctorInstallConsistency["runtime"] = { live: false };
  if (installJson) {
    // §P2: bounded and shape-validated. This runs an arbitrary path out of a file on disk, so its
    // output is treated as untrusted input to the report, not as a version.
    const exec =
      deps.exec ??
      ((command: string, args: string[]) =>
        execFileAsync(command, args, { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 }));
    try {
      const { stdout } = await exec(installJson.runtime.path, ["--version"]);
      const reported = stdout.trim().slice(0, MAX_VERSION_OUTPUT_CHARS);
      runtime = VERSION_PATTERN.test(reported)
        ? { path: installJson.runtime.path, live: true, version: reported.replace(/^v/, "") }
        : {
            path: installJson.runtime.path,
            live: false,
            error: "the recorded runtime did not answer --version with a version number."
          };
    } catch (error) {
      runtime = {
        path: installJson.runtime.path,
        live: false,
        error: truncate(error instanceof Error ? error.message : String(error), MAX_ERROR_CHARS)
      };
    }
  }

  const aplJsText = await readIfPresent(path.join(home, "bin", "apl.js"));
  const scrapedAplJsTarget = aplJsText ? /"app",\s*"([^"]+)"/.exec(aplJsText)?.[1] : undefined;
  // §P2: `bin/apl.js` is a generated file a user can edit; only report a target that could
  // actually be an `app/<version>` directory name.
  let aplJsTarget =
    scrapedAplJsTarget && VERSION_DIRECTORY_PATTERN.test(scrapedAplJsTarget) ? scrapedAplJsTarget : undefined;
  if (!aplJsTarget && installJson?.installedBy === "source" && aplJsText) {
    const literal = /const entry = ("(?:[^"\\]|\\.)*");/.exec(aplJsText)?.[1];
    if (literal) {
      try {
        const target: unknown = JSON.parse(literal);
        if (
          typeof target === "string" &&
          path.isAbsolute(target) &&
          target.endsWith(path.join("dist", "cli", "index.js"))
        )
          aplJsTarget = target;
      } catch {
        /* Edited launchers never contribute arbitrary values to diagnostics. */
      }
    }
  }

  const definition = await resolveStandaloneDefinition(deps).catch(() => undefined);
  // §4.7 C9: the same prefixes the writers substitute with, so a portable entry classifies and
  // resolves here instead of looking foreign and unresolvable.
  const variables = integrationVariablesFor({
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir()
  });
  const clients = await Promise.all(
    DOCTOR_CLIENTS.map(async (client): Promise<DoctorClientFileReport> => {
      const file = fileFor(client, deps);
      const text = await readIfPresent(file);
      if (text === undefined) return { client, file, status: "absent", duplicateKeys: [] };
      const kind = kindFor(client);
      const status: IntegrationEntryStatus = definition
        ? integrationEntryStatus(text, kind, definition, variables)
        : "absent";
      const entry =
        kind === "codex"
          ? parseCodexEntry(text)?.command
          : parseJsonEntry(
              text,
              kind as Extract<IntegrationKind, "claudeCode" | "vscodeMcpJson" | "vscodeUser" | "claudeUser">
            )?.command;
      const duplicateKeys =
        kind === "codex"
          ? codexDuplicateKeys(text)
          : jsonDuplicateKeys(
              text,
              kind === "claudeCode" || kind === "claudeUser" ? "mcpServers" : "servers"
            );
      return {
        client,
        file,
        status,
        ...(status !== "absent" ? { commandResolvable: await commandResolves(entry, kind, variables) } : {}),
        duplicateKeys
      };
    })
  );

  const policies = await checkClientPolicies({
    ...defaultClientPolicyIo(),
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir()
  });

  const descriptor = await deps.readDescriptor(deps.paths).catch(() => undefined);
  const brokerEntry = descriptor?.build?.entry;
  // path.relative escaping "home" (a ".." segment, or an absolute result on Windows when the two
  // paths are on different drives) means the entry does not resolve under it.
  const brokerInstallRoot =
    brokerEntry && !isWithin(home, brokerEntry)
      ? { entry: brokerEntry, note: "broker runs from another install root" }
      : undefined;

  return {
    cliVersion: deps.version,
    ...(installJson
      ? {
          machineInstall: {
            version: installJson.version,
            installedBy: installJson.installedBy,
            runtimeSource: installJson.runtime.source,
            runtimePath: installJson.runtime.path
          }
        }
      : {}),
    versionSkew,
    runtime,
    ...(aplJsTarget ? { aplJsTarget } : {}),
    clients,
    policies,
    ...(brokerInstallRoot ? { brokerInstallRoot } : {})
  };
}

/** True when `target` resolves inside `root` (or equals it). */
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * §30.5. Delegates every local prerequisite/configuration check to the shared HealthService
 * (also used by the broker's `broker.health`) so `doctor` and the broker can never drift apart.
 * doctor only adds the parts that need a broker connection, and -- by calling `agent.validate`
 * with `sendTestMessage: false` -- never sends an agent message, even with `--agent`.
 */
export async function runDoctor(
  deps: CommandDeps,
  options?: { agent?: string; auth?: boolean }
): Promise<Record<string, unknown>> {
  const health = new HealthService({ paths: deps.paths, preparer: deps.preparer, toFailure: toToolError });
  const { topologyReady, checks } = await health.localReport(deps.root());
  const result: Record<string, unknown> = { ...checks };
  result.installConsistency = await checkInstallConsistency(deps);
  // Read before connecting: connectExistingBroker cleans up a stale descriptor it rejects.
  const descriptor = await health.descriptorState();
  let broker;
  let brokerFailure: ToolError | undefined;
  try {
    broker = await deps.connectExistingBroker(deps.paths);
  } catch (value) {
    brokerFailure = toToolError(value);
  }
  result.broker = broker
    ? {
        live: true,
        descriptorPresent: true,
        ...((await broker.call("broker.health", {})) as Record<string, unknown>)
      }
    : { live: false, ...descriptor, ...(brokerFailure ? { error: brokerFailure } : {}) };
  if ((options?.auth || options?.agent) && topologyReady && !broker) {
    try {
      broker = await deps.connectOrStartDefaultBroker(deps.paths);
    } catch (value) {
      brokerFailure = toToolError(value);
    }
  }
  const unavailable =
    brokerFailure ??
    toToolError(
      new DomainError(
        topologyReady ? "BROKER_UNAVAILABLE" : "REMOTE_HOST_UNSUPPORTED",
        topologyReady
          ? "The broker could not be started."
          : "Optional browser checks require a supported local desktop topology.",
        topologyReady
      )
    );
  if (options?.auth)
    result.authentication = broker ? await broker.call("browser.authState", {}) : unavailable;
  if (options?.agent)
    result.agent = broker
      ? await broker.call("agent.validate", { agent: options.agent, sendTestMessage: false })
      : unavailable;
  broker?.close();
  // item 1: when a BROWSER_START_FAILED was recorded anywhere in this run (a live incident, or a
  // broker/authentication/agent-validate call that itself failed with that code), print
  // broker.log's path and its last 20 lines (metadata only) so a report is diagnosable without a
  // separate file lookup.
  const brokerIncidents = Array.isArray((result.broker as { incidents?: unknown })?.incidents)
    ? ((result.broker as { incidents: Array<{ code?: string }> }).incidents ?? [])
    : [];
  const browserStartFailed =
    brokerFailure?.code === "BROWSER_START_FAILED" ||
    brokerIncidents.some((incident) => incident?.code === "BROWSER_START_FAILED") ||
    (result.authentication as ToolError | undefined)?.code === "BROWSER_START_FAILED" ||
    (result.agent as ToolError | undefined)?.code === "BROWSER_START_FAILED";
  if (browserStartFailed)
    result.brokerLog = {
      path: brokerLogPath(deps.paths.logs),
      tail: await readBrokerLogTail(deps.paths.logs, 20)
    };
  const findings = doctorFindings(result);
  return { ...result, ok: findings.length === 0, findings };
}

/** Stable metadata-only check IDs; no raw config, URLs or broker messages in install summaries. */
export function doctorFindings(report: Record<string, unknown>): string[] {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const findings: string[] = [];
  // These fields exist only when the corresponding optional probe was requested.
  // An inconclusive probe is not evidence of health; absent probes stay neutral.
  if (Object.hasOwn(report, "authentication")) {
    const auth = object(report.authentication);
    if (auth.code) findings.push("authentication.error");
    else if (["sign-in-required", "interactive-auth", "access-denied"].includes(String(auth.state)))
      findings.push(`authentication.${String(auth.state)}`);
    else if (auth.state !== "authenticated") findings.push("authentication.unknown");
  }
  if (Object.hasOwn(report, "agent")) {
    const agent = object(report.agent);
    if (agent.code) findings.push("agent.error");
    else if (agent.valid === false) findings.push("agent.invalid");
    else if (agent.valid !== true) findings.push("agent.unknown");
  }
  for (const [name, fields] of Object.entries({
    topology: ["supported"],
    node: ["supported"],
    browser: ["installed"],
    appData: ["protected", "writable"],
    globalConfig: ["valid"],
    profile: ["safe", "owned", "writable"]
  })) {
    if (fields.some((field) => object(report[name])[field] !== true)) findings.push(name);
  }
  const workspace = object(report.workspace);
  if (workspace.approvalStatus !== "approved") findings.push("workspace.approval");
  if (
    Array.isArray(workspace.assignments) &&
    workspace.assignments.some((item) => object(item).status !== "ready")
  )
    findings.push("workspace.assignments");
  for (const name of ["registry", "approvals"]) if (object(report[name]).code) findings.push(name);
  const install = object(report.installConsistency);
  if (install.versionSkew !== "none") findings.push("install.version");
  if (object(install.runtime).live !== true) findings.push("install.runtime");
  if (!install.aplJsTarget) findings.push("install.launcher");
  if (install.brokerInstallRoot) findings.push("install.brokerInstallRoot");
  if (Array.isArray(install.clients))
    for (const item of install.clients) {
      const client = object(item);
      if (
        (client.status !== "absent" && client.status !== "managed") ||
        client.commandResolvable === false ||
        (Array.isArray(client.duplicateKeys) && client.duplicateKeys.length)
      )
        findings.push(`client.${String(client.client)}`);
    }
  if (Array.isArray(install.policies))
    for (const item of install.policies) findings.push(`policy.${String(object(item).policy)}`);
  return [...new Set(findings)];
}
