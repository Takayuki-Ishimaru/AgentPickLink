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
};
export type ApplicationErrorResult = { ok: false; requestId: string; error: ApplicationError };

const remediation: Partial<Record<ErrorCode, string>> = {
  WORKSPACE_APPROVAL_REQUIRED:
    "This repository requests Microsoft 365 agents that have not been approved locally. Open the AgentPickLink panel in VS Code and press Save to approve them. (Or run: m365-agent workspace approve)",
  AUTH_REQUIRED: "Sign in from the AgentPickLink panel in VS Code. (Or run: m365-agent login)",
  AGENT_BINDING_MISMATCH:
    "The workspace alias resolves to a different local Microsoft 365 agent binding. Review the registry and run: m365-agent workspace approve",
  SUBMIT_STATE_UNKNOWN:
    "The message might have been submitted. It was not retried automatically. Inspect the existing conversation before deciding whether to send another request.",
  UI_CHANGED:
    "The Microsoft 365 page structure differs from what this version expects. Open the AgentPickLink panel, copy the diagnostic, and report it to the developer. Do not retry blindly.",
  WORKSPACE_NOT_CONFIGURED:
    "Open the AgentPickLink panel in VS Code and press Save to create .m365-agents.json. (Or run: m365-agent workspace configure)",
  AGENT_UNVERIFIED: "Re-register and verify the agent with: m365-agent agent add --capture",
  NEW_CONVERSATION_UNVERIFIED:
    "The prompt was not sent. Verify the configured UI adapter and direct-chat entry point.",
  BROKER_VERSION_MISMATCH: "Run: m365-agent broker restart",
  BROWSER_PROFILE_INVALID:
    "Move the dedicated profile to protected local application data and run m365-agent init.",
  BROWSER_PROFILE_LOCKED:
    "Another browser process is using the dedicated profile. Close the AgentPickLink sign-in window, then run: m365-agent broker restart",
  CONCURRENT_REQUEST:
    "Wait for the operation that is already using this conversation or the dedicated browser profile (an interactive sign-in window, for example) to finish, then retry.",
  // The automation browser is hidden, so remediation must never tell anyone to look at it.
  RESPONSE_TIMEOUT:
    "The prompt was not resubmitted. The response may still complete in the hidden browser; continue the same conversation handle to read it, or raise browser.responseTimeoutMs."
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
