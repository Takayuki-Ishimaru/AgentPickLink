import { toToolError } from "./ui/formatter.js";
import type { AgentView, ToolError } from "../frontend/schemas.js";
import type { AgentCandidate } from "../services/setup-service.js";
import type { InstallCommandOptions, InstallReport } from "./commands/install.js";

export type CliResult<T = unknown> = T | ToolError;
export type CliContext = {
  workspaceRoot: string;
  json: boolean;
  yes: boolean;
  /** ISSUE-09 (docs/validation-log-2026-09-14-windows.md): global `--verbose` -- echoes
   * metadata-only diagnostic lines (a broker-release wait, a restart-and-retry outcome) to stderr,
   * prefixed `[log]`, in addition to them always being appended to the app-data log file. */
  verbose: boolean;
  out: (text: string) => void;
  error: (text: string) => void;
  /** Implemented by the application composition root; commands stay browser-free. */
  api: CliApi;
};

export interface CliApi {
  init(): Promise<CliResult<{ initialized: boolean; configPath?: string }>>;
  login(): Promise<CliResult<Record<string, unknown>>>;
  logout(options?: { yes?: boolean }): Promise<CliResult<{ loggedOut: boolean }>>;
  doctor(options?: { agent?: string; auth?: boolean }): Promise<CliResult<Record<string, unknown>>>;
  broker(action: "status" | "restart" | "stop"): Promise<CliResult<Record<string, unknown>>>;
  agentAdd(options: {
    capture?: boolean;
    url?: string;
    force?: boolean;
  }): Promise<CliResult<Record<string, unknown>>>;
  agentRemove(alias: string): Promise<CliResult<Record<string, unknown>>>;
  agentList(): Promise<CliResult<{ agents: AgentView[] }>>;
  agentDiscover(options?: {
    login?: boolean;
    json?: boolean;
  }): Promise<CliResult<{ candidates: AgentCandidate[]; warnings: string[] } | string>>;
  agentTest(
    alias: string,
    options: { sendTestMessage?: boolean; yes?: boolean }
  ): Promise<CliResult<Record<string, unknown>>>;
  workspaceConfigure(): Promise<CliResult<Record<string, unknown>>>;
  workspaceList(): Promise<CliResult<Record<string, unknown>>>;
  workspaceValidate(): Promise<CliResult<Record<string, unknown>>>;
  workspaceApprove(options?: { yes?: boolean }): Promise<CliResult<Record<string, unknown>>>;
  workspaceApprovalStatus(): Promise<CliResult<Record<string, unknown>>>;
  workspaceRevoke(): Promise<CliResult<Record<string, unknown>>>;
  serve(): Promise<void>;
  /** WP-B: the command behind the portable archive's `apl-setup` launcher. Never returns a
   * `ToolError` for a handled outcome (staging failure, an unconfirmed plan, a failed verify are
   * all reported through `InstallReport.exitCode`); a thrown `ToolError` here means argument
   * validation or elevation failed before the plan could even be built. */
  install(options: InstallCommandOptions): Promise<CliResult<InstallReport>>;
  self(
    action: "status" | "use" | "prune" | "uninstall",
    options?: { version?: string; home?: string; purgeData?: boolean; yes?: boolean; verbose?: boolean }
  ): Promise<CliResult<Record<string, unknown>>>;
  integrations(
    action: "write" | "status" | "remove" | "snippet",
    options?: { client?: string; workspace?: string; force?: boolean; home?: string }
  ): Promise<CliResult<Record<string, unknown>>>;
}

export function isCliError(value: unknown): value is ToolError {
  return (
    !!value && typeof value === "object" && "code" in value && "message" in value && "retryable" in value
  );
}

export function printResult(context: CliContext, result: unknown): void {
  // `undefined` means "nothing to print" (e.g. serve, which must never write to a
  // stdio transport's own stdout). JSON.stringify(undefined) is the value
  // `undefined`, not the string "undefined" -- printing it unconditionally would
  // still emit the literal text "undefined" through context.out's template string.
  if (result === undefined) return;
  if (context.json) context.out(JSON.stringify(result, null, 2));
  else if (isCliError(result))
    context.error(`${result.code}: ${result.message}${result.remediation ? `\n${result.remediation}` : ""}`);
  else if (typeof result === "string") context.out(result);
  else context.out(formatReadableResult(result));
}

/** Compact, scan-friendly rendering for common CLI results. `--json` remains the stable structured
 * output for scripts; ordinary terminal use should not dump a large JSON health report. */
export function formatReadableResult(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return String(value);
  const result = value as Record<string, unknown>;
  if (Array.isArray(result.agents)) {
    const agents = result.agents as Array<Record<string, unknown>>;
    return agents.length === 0
      ? "No agents registered."
      : [
          "Agents:",
          ...agents.flatMap((agent) => [
            `  ${String(agent.alias)} — ${String(agent.status)}${agent.name ? ` — ${String(agent.name)}` : ""}`,
            ...(typeof agent.description === "string" && agent.description
              ? [`    ${agent.description}`]
              : []),
            ...(typeof agent.usageHint === "string" && agent.usageHint
              ? [`    Usage: ${agent.usageHint}`]
              : [])
          ])
        ].join("\n");
  }
  if (typeof result.installed === "boolean" && Array.isArray(result.versions)) {
    return [
      `CLI install: ${result.installed ? "installed" : "not installed"}`,
      `Home: ${String(result.home)}`,
      `CLI command: ${cliCommandPrefix(String(result.cliPath ?? "unknown"))} <command>`,
      `Current version: ${String(result.currentVersion ?? "unknown")}`,
      `Runtime: ${String(result.runtimeVersion ?? "unavailable")}`,
      `Versions: ${(result.versions as unknown[]).join(", ") || "none"}`
    ].join("\n");
  }
  if (typeof result.ok === "boolean" && Array.isArray(result.findings)) {
    const findings = result.findings as string[];
    const lines = [
      `Health check: ${result.ok ? "all checks passed" : `${findings.length} issue(s) need attention`}`
    ];
    for (const finding of findings) {
      const detail = doctorFindingDetail(result, finding);
      lines.push(`- ${finding}${detail ? `: ${detail}` : ""}`);
      const action = doctorFindingAction(finding);
      if (action) lines.push(`  Next: ${action}`);
    }
    if (findings.length) lines.push(`Problems found: ${findings.length}`);
    return lines.join("\n");
  }
  return Object.entries(result)
    .map(([key, item]) => `${key}: ${readableValue(item)}`)
    .join("\n");
}

function cliCommandPrefix(cliPath: string): string {
  return process.platform === "win32"
    ? `& '${cliPath.replace(/'/g, "''")}'`
    : `'${cliPath.replace(/'/g, "'\\''")}'`;
}

function doctorFindingDetail(report: Record<string, unknown>, finding: string): string {
  const dot = finding.indexOf(".");
  const root = dot < 0 ? finding : finding.slice(0, dot);
  const child = dot < 0 ? undefined : finding.slice(dot + 1);
  let value: unknown = report[root];
  if (child && value && typeof value === "object" && Object.hasOwn(value, child))
    value = (value as Record<string, unknown>)[child];
  if (
    root === "client" &&
    Array.isArray((report.installConsistency as Record<string, unknown> | undefined)?.clients)
  ) {
    value = (
      (report.installConsistency as Record<string, unknown>).clients as Array<Record<string, unknown>>
    ).find((client) => client.client === child);
  }
  if (
    root === "policy" &&
    Array.isArray((report.installConsistency as Record<string, unknown> | undefined)?.policies)
  ) {
    const policies = (report.installConsistency as Record<string, unknown>).policies as Array<
      Record<string, unknown>
    >;
    value =
      policies.find((policy) => policy.policy === child) ??
      policies.filter((policy) => String(policy.policy).startsWith(`${child}.`));
  }
  if (root === "install" && report.installConsistency && typeof report.installConsistency === "object") {
    const install = report.installConsistency as Record<string, unknown>;
    value =
      child === "version"
        ? { versionSkew: install.versionSkew }
        : child === "runtime"
          ? install.runtime
          : child === "launcher"
            ? { aplJsTarget: install.aplJsTarget }
            : child === "brokerInstallRoot"
              ? { brokerInstallRoot: install.brokerInstallRoot }
              : value;
  }
  if (Array.isArray(value))
    return value
      .map((item) => {
        if (!item || typeof item !== "object") return String(item);
        const entry = item as Record<string, unknown>;
        return `${String(entry.alias ?? entry.client ?? "item")}:${String(entry.status ?? entry.code ?? "issue")}`;
      })
      .join(", ");
  if (!value || typeof value !== "object") return value === undefined ? "" : String(value);
  const object = value as Record<string, unknown>;
  const fields = [
    "supported",
    "installed",
    "valid",
    "writable",
    "protected",
    "safe",
    "owned",
    "approvalStatus",
    "status",
    "state",
    "versionSkew",
    "version",
    "path",
    "runtimePath",
    "aplJsTarget",
    "commandResolvable",
    "duplicateKeys",
    "note",
    "code",
    "reason",
    "details",
    "error",
    "message",
    "remediation",
    "client",
    "policy",
    "value",
    "blocks",
    "source"
  ];
  const items = fields
    .filter((key) => object[key] !== undefined)
    .map((key) => `${key}=${readableValue(object[key])}`);
  return items.join("; ");
}

function doctorFindingAction(finding: string): string | undefined {
  if (finding.startsWith("authentication.")) return "Run `apl login` and complete the Microsoft 365 sign-in.";
  if (finding === "agent.invalid") return "Run `apl agent test <alias>` and check the agent URL and access.";
  if (finding === "workspace.approval" || finding === "workspace.assignments")
    return "Run `apl workspace validate`, then `apl workspace approve` to review the assignments.";
  if (finding === "browser")
    return "Install or repair Edge or Chrome, then choose an installed browser in AgentPickLink setup.";
  if (finding === "topology")
    return "Run the portable CLI on a supported Windows or macOS local desktop. The status above includes the unsupported topology reason.";
  if (finding === "node")
    return "Install or repair the supported Node.js runtime, then run `apl doctor` again.";
  if (finding.startsWith("install.")) return "Run `apl-setup` to repair the portable installation.";
  if (finding.startsWith("client."))
    return "Run `apl integrations status` to inspect the client entry, then `apl integrations write` to refresh it.";
  if (finding.startsWith("policy."))
    return "Review the client policy in the AI client settings before enabling this integration.";
  if (["appData", "globalConfig", "profile", "registry", "approvals", "broker.error"].includes(finding))
    return "Review the detailed status above and rerun `apl doctor` after correcting the reported issue.";
  return undefined;
}

function readableValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(readableValue).join(", ") : "none";
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}=${readableValue(item)}`)
    .join("; ");
}

export async function runCommand(context: CliContext, action: () => Promise<unknown>): Promise<void> {
  try {
    const result = await action();
    printResult(context, result);
    if (isCliError(result)) process.exitCode = 1;
  } catch (error) {
    printResult(context, toToolError(error));
    process.exitCode = 1;
  }
}
