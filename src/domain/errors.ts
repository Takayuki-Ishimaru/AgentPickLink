export const ERROR_CODES = [
  "WORKSPACE_NOT_CONFIGURED",
  "WORKSPACE_CONFIG_INVALID",
  "WORKSPACE_APPROVAL_REQUIRED",
  "WORKSPACE_APPROVAL_REVOKED",
  "WORKSPACE_CONFIG_CHANGED",
  "WORKSPACE_ROOT_AMBIGUOUS",
  "WORKSPACE_ROOT_UNAVAILABLE",
  "MULTI_ROOT_UNSUPPORTED",
  "REMOTE_HOST_UNSUPPORTED",
  "PLATFORM_UNSUPPORTED",
  "AGENT_NOT_ASSIGNED",
  "AGENT_NOT_FOUND",
  "AGENT_DISABLED",
  "AGENT_UNVERIFIED",
  "AGENT_BINDING_MISMATCH",
  "AGENT_CAPABILITY_BLOCKED",
  "AGENT_ENTRYPOINT_UNSUPPORTED",
  "AGENT_IDENTITY_UNVERIFIED",
  "AGENT_IDENTITY_MISMATCH",
  "AGENT_CONTEXT_CHANGED",
  "AGENT_PAGE_UNAVAILABLE",
  "BROKER_UNAVAILABLE",
  "BROKER_START_FAILED",
  "BROKER_AUTH_FAILED",
  "BROKER_VERSION_MISMATCH",
  "BROKER_PROTOCOL_ERROR",
  "BROWSER_START_FAILED",
  "BROWSER_PROFILE_INVALID",
  "BROWSER_PROFILE_LOCKED",
  "BROWSER_CRASHED",
  "AUTH_REQUIRED",
  "AUTH_FAILED",
  "POLICY_BLOCKED",
  "UNSUPPORTED_UI",
  "UI_CHANGED",
  "CHAT_INPUT_NOT_FOUND",
  "CHAT_INPUT_AMBIGUOUS",
  "NEW_CONVERSATION_UNVERIFIED",
  "SUBMIT_FAILED",
  "SUBMIT_STATE_UNKNOWN",
  "RESPONSE_TIMEOUT",
  "RESPONSE_EXTRACTION_FAILED",
  "CONVERSATION_NOT_FOUND",
  "CONVERSATION_EXPIRED",
  "CONVERSATION_OWNERSHIP_MISMATCH",
  "CONCURRENT_REQUEST",
  "RATE_LIMITED",
  "INVALID_ARGUMENT",
  "INTERNAL_ERROR"
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type SubmissionState = "not-sent" | "sent" | "unknown";
export type PartialResponse = {
  text: string;
  citations: Array<{ index?: number; marker?: string; title?: string; url?: string; source?: string }>;
};
export type ApplicationError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  remediation?: string;
  submissionState?: SubmissionState;
  partialResponse?: PartialResponse;
  retryAfterMs?: number;
  /** item 1 (broker.log persistence): a redacted, size-bounded (<=40 lines) Playwright launch call
   * log, present only on a browser launch failure that carried one (see `browser-manager.ts`'s
   * `launchFailure`). Crosses IPC so the CLI/extension can append it to their own log file
   * (`src/cli/setup-host-terminal.ts`'s `appendCliLog`, prefixed `browser-log:`) -- the MCP tool
   * surface strips it again before an AI client ever sees a result
   * (`src/frontend/tool-results.ts`'s `failure()`), so it must never be treated as part of the
   * public MCP contract. */
  callLog?: string[];
  /** Sibling to `callLog`: true when the root cause was a launch timeout (ours or Playwright's
   * own). Same "logs only, never the MCP tool result" rule applies. */
  timedOut?: boolean;
  /** The conversation a failed ask left open because its message was or may have been sent: read
   * it with `m365_agent_session` action `read` to learn whether the message arrived and to collect
   * the reply, without sending the message again. */
  conversationHandle?: string;
};
export type ApplicationErrorResult = { ok: false; requestId: string; error: ApplicationError };

const remediation: Partial<Record<ErrorCode, string>> = {
  WORKSPACE_APPROVAL_REQUIRED:
    "Review and approve the selected agents in AgentPickLink setup. For a portable installation, rerun apl-setup with the workspace path; in VS Code, open the AgentPickLink panel and press Save.",
  AUTH_REQUIRED:
    "Sign in through AgentPickLink setup. For a portable installation, rerun apl-setup with the workspace path; in VS Code, use the AgentPickLink panel's Sign in action.",
  AGENT_BINDING_MISMATCH:
    "The workspace alias resolves to a different local Microsoft 365 agent binding. Review and approve it again in AgentPickLink setup (rerun apl-setup with the workspace path for a portable installation).",
  SUBMIT_STATE_UNKNOWN:
    "The message might have been submitted. It was not retried automatically. Do not send it again blindly: if this error includes a conversationHandle, call m365_agent_session with action=read and that handle to learn whether the message arrived and to collect the reply; otherwise check the conversation in Microsoft 365 first.",
  UI_CHANGED:
    "The Microsoft 365 page structure may have changed. Copy diagnostics in AgentPickLink setup or run the installed apl launcher with doctor, and report the metadata to the developer. Do not resend the question blindly.",
  WORKSPACE_NOT_CONFIGURED:
    "Run apl-setup with the workspace path and approve the selected agents to create .m365-agents.json. In VS Code, use the AgentPickLink panel's Save action.",
  AGENT_UNVERIFIED: "Re-register and verify the agent in AgentPickLink setup.",
  NEW_CONVERSATION_UNVERIFIED:
    "The prompt was not sent. Verify the configured UI adapter and direct-chat entry point.",
  BROKER_VERSION_MISMATCH: "Restart the broker using the installed apl launcher: apl broker restart",
  BROWSER_PROFILE_INVALID:
    "Move the dedicated profile to protected local application data and rerun AgentPickLink setup.",
  BROWSER_PROFILE_LOCKED:
    "Another browser process is using the dedicated profile. Close the AgentPickLink sign-in window, then restart the broker with the installed apl launcher: apl broker restart",
  CONCURRENT_REQUEST:
    "Wait for the operation that is already using this conversation or the dedicated browser profile (an interactive sign-in window, for example) to finish, then retry.",
  // The automation browser is hidden, so remediation must never tell anyone to look at it.
  RESPONSE_TIMEOUT:
    "The prompt was not resubmitted. The response may still complete in the hidden browser: if this error includes a conversationHandle, call m365_agent_session with action=read and that handle to collect it without sending the prompt again. To wait longer in the first place, raise browser.responseTimeoutMs."
};
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly options: Omit<ApplicationError, "code" | "message" | "retryable"> = {}
  ) {
    super(message);
    this.name = "DomainError";
  }
  toResult(requestId: string): ApplicationErrorResult {
    const { remediation: explicit, ...details } = this.options;
    const error: ApplicationError = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...details
    };
    const action = explicit ?? remediation[this.code];
    if (action) error.remediation = action;
    return { ok: false, requestId, error };
  }
}
export function asDomainError(error: unknown): DomainError {
  return error instanceof DomainError
    ? error
    : new DomainError("INTERNAL_ERROR", "An unexpected internal error occurred.");
}
