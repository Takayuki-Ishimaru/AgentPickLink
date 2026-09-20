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
  else context.out(JSON.stringify(result, null, 2));
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
