/** Public MCP contract.  Keep this module independent of the browser and broker. */
import { MESSAGE_CONTENT_PATTERN, MESSAGE_MAX_CHARACTERS } from "../domain/text.js";

export const ALIAS_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
export const HANDLE_PATTERN = "^conv_[A-Za-z0-9_-]+$";

export const errorCodes = [
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
export type ErrorCode = (typeof errorCodes)[number];

export type ToolError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  remediation?: string;
  retryAfterMs?: number;
  submissionState?: "not-sent" | "sent" | "unknown";
  partialResponse?: { text: string; citations: Citation[] };
  /** A conversation the failed ask left open because its message was or may have been sent: read
   * it with m365_agent_session action=read instead of sending the message again. */
  conversationHandle?: string;
};

export type Citation = { index?: number; marker?: string; title?: string; url?: string; source?: string };
export type Attachment = {
  index: number;
  name: string;
  mediaType: string;
  sourceUrl: string;
  status: "saved" | "not-saved";
  localPath?: string;
  sizeBytes?: number;
  sha256?: string;
  errorCode?: "downloads-disabled" | "host-not-allowed" | "download-failed" | "attachment-count-limit";
  kind?: "url" | "download-control" | "file-card";
  stage?: string;
};
export type AgentStatus =
  | "ready"
  | "approval-required"
  | "unresolved"
  | "binding-mismatch"
  | "unverified"
  | "disabled"
  | "policy-blocked"
  | "unsupported-entrypoint";
/**
 * The broker's `workspace.list` handler (PolicyService.roster, src/services/policy-service.ts) deliberately
 * collapses every ineligibility reason -- disabled, unverified, binding-mismatch,
 * unsupported-entrypoint, policy-blocked, unresolved -- into "approval-required". This is a
 * privacy boundary: a repository must not be able to infer, from `m365_agent_list`, whether an
 * unapproved alias exists in the user's registry or why it is currently ineligible. So the MCP
 * surface can only ever emit these two statuses; the full AgentStatus set above stays reserved
 * for CLI surfaces with a local trust boundary (`workspace validate`, `agent list`).
 */
export const MCP_AGENT_LIST_STATUSES = ["ready", "approval-required"] as const;
export type McpAgentListStatus = (typeof MCP_AGENT_LIST_STATUSES)[number];
export type AgentView = {
  alias: string;
  name?: string;
  kind?: "m365-agent-builder" | "sharepoint-agent" | "copilot-studio";
  description?: string;
  usageHint?: string;
  capabilityClass?: "knowledge-only" | "actions-possible" | "unknown";
  status: AgentStatus;
  lastValidatedAt?: string;
  remediation?: string;
};

export type ListResult = {
  ok: true;
  requestId: string;
  workspace: {
    configured: boolean;
    approvalStatus: "approved" | "approval-required" | "not-configured" | "invalid";
  };
  agents: AgentView[];
};
export type AskResult = {
  ok: true;
  requestId: string;
  agent: string;
  conversationHandle: string;
  /** True when the handle was created implicitly for this one-shot ask and closed before return. */
  conversationClosed?: boolean;
  /** True when a one-shot handle was retired but transport close still needs maintenance retry. */
  conversationCleanupPending?: boolean;
  text: string;
  citations: Citation[];
  attachments: Attachment[];
  elapsedMs: number;
  truncated: boolean;
  actionRequired: boolean;
  submissionState: "sent";
  sourceType: "m365-agent";
};
export type Conversation = {
  conversationHandle: string;
  agent: string;
  createdAt: string;
  lastUsedAt: string;
};
export type SessionAction = "new" | "list" | "close" | "close_all" | "read";
/** action=read: whether the last message AgentPickLink entered in the conversation is shown there
 * (`none` when it has entered none), and the state of the reply to the latest user message. */
export type ReadMessageState = "shown" | "differs" | "not-shown" | "unconfirmed" | "none";
export type ReadReplyState = "complete" | "incomplete" | "none";
export type SessionResult = {
  ok: true;
  requestId: string;
  action: SessionAction;
  conversation?: Conversation;
  conversations?: Conversation[];
  closedCount?: number;
  /** action=read only. */
  message?: ReadMessageState;
  /** action=read: the requestId of the ask that entered the message `message` describes. */
  messageRequestId?: string;
  reply?: ReadReplyState;
  /** action=read with reply=complete: the reply, shaped like an ask result. */
  text?: string;
  citations?: Citation[];
  attachments?: Attachment[];
  truncated?: boolean;
  actionRequired?: boolean;
  sourceType?: "m365-agent";
  /** action=read with reply=incomplete: what the reply showed so far, when it showed anything. */
  partialResponse?: { text: string; citations: Citation[] };
  /** action=read: true when a conversation kept open by a failed one-shot ask was closed because
   * its reply has now been collected. */
  conversationClosed?: boolean;
};
export type PublicResult = ListResult | AskResult | SessionResult;
export type ApplicationResult = PublicResult | { ok: false; requestId: string; error: ToolError };

const strict = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

export const listInputSchema = strict({}, []);
export const askInputSchema = strict(
  {
    agent: {
      type: "string",
      pattern: ALIAS_PATTERN,
      description: "The lowercase alias of the workspace-assigned Microsoft 365 agent to consult."
    },
    message: {
      type: "string",
      minLength: 1,
      maxLength: MESSAGE_MAX_CHARACTERS,
      pattern: MESSAGE_CONTENT_PATTERN,
      description:
        "The message to send to the agent (1-12000 characters, not whitespace only; sent as given, line endings as LF). Do not include secrets or large source files unless organizational policy explicitly permits it."
    },
    conversationHandle: {
      type: "string",
      pattern: HANDLE_PATTERN,
      description:
        "An existing conversation handle to continue that exact conversation. Omit to start a fresh conversation."
    },
    expectFiles: {
      type: "boolean",
      description:
        "Default true. Set false when the message asks only for a text answer: the call then returns as soon as the answer is complete instead of also waiting about two seconds for files that can appear after it. Files already shown with the answer are still saved."
    }
  },
  ["agent", "message"]
);
export const sessionInputSchema = {
  ...strict(
    {
      action: {
        type: "string",
        enum: ["new", "list", "close", "close_all", "read"],
        description:
          "new starts a conversation (requires agent); list lists open conversations for this workspace; close closes one conversation (requires conversationHandle); close_all closes every conversation for this workspace; read reads a conversation without sending anything (requires conversationHandle): whether the last message is shown there, and the reply to it, waiting for the reply to finish. Use read after m365_agent_ask returns SUBMIT_STATE_UNKNOWN or RESPONSE_TIMEOUT with a conversationHandle, instead of sending the message again."
      },
      agent: {
        type: "string",
        pattern: ALIAS_PATTERN,
        description:
          "The agent alias to start a new conversation with. Required for action=new; not accepted otherwise."
      },
      conversationHandle: {
        type: "string",
        pattern: HANDLE_PATTERN,
        description:
          "The conversation handle to close or read. Required for action=close and action=read; not accepted otherwise."
      }
    },
    ["action"]
  ),
  // Conditional requirements are enforced by the frontend validator as well as the broker. They
  // are not expressed as a top-level oneOf: tool-schema validators of common MCP clients refuse a
  // top-level oneOf/anyOf/allOf, so the per-action rules live in the field descriptions above.
  $comment:
    "new requires agent; close and read require conversationHandle; list and close_all require neither; no action accepts another action's field"
};

const citationSchema = strict({
  index: { type: "integer", minimum: 1 },
  marker: { type: "string" },
  title: { type: "string" },
  url: { type: "string", format: "uri" },
  source: { type: "string" }
});
const attachmentSchema = strict(
  {
    index: { type: "integer", minimum: 1 },
    name: { type: "string" },
    mediaType: { type: "string" },
    sourceUrl: { type: "string", format: "uri" },
    status: { type: "string", enum: ["saved", "not-saved"] },
    localPath: { type: "string" },
    sizeBytes: { type: "integer", minimum: 0 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    errorCode: {
      type: "string",
      enum: ["downloads-disabled", "host-not-allowed", "download-failed", "attachment-count-limit"]
    },
    kind: { type: "string", enum: ["url", "download-control", "file-card"] },
    stage: { type: "string" }
  },
  ["index", "name", "mediaType", "sourceUrl", "status"]
);
const errorSchema = strict(
  {
    code: { type: "string", enum: [...errorCodes] },
    message: { type: "string" },
    retryable: { type: "boolean" },
    remediation: { type: "string" },
    retryAfterMs: { type: "integer", minimum: 0 },
    submissionState: { type: "string", enum: ["not-sent", "sent", "unknown"] },
    partialResponse: strict(
      { text: { type: "string" }, citations: { type: "array", items: citationSchema } },
      ["text", "citations"]
    ),
    conversationHandle: {
      type: "string",
      pattern: HANDLE_PATTERN,
      description:
        "The conversation this failed ask left open because its message was or may have been sent. Read it with m365_agent_session action=read instead of sending the message again."
    }
  },
  ["code", "message", "retryable"]
);
const errorEnvelope = strict({ ok: { const: false }, requestId: { type: "string" }, error: errorSchema }, [
  "ok",
  "requestId",
  "error"
]);

const conversationSchema = strict(
  {
    conversationHandle: { type: "string", pattern: HANDLE_PATTERN },
    agent: { type: "string", pattern: ALIAS_PATTERN },
    createdAt: { type: "string", format: "date-time" },
    lastUsedAt: { type: "string", format: "date-time" }
  },
  ["conversationHandle", "agent", "createdAt", "lastUsedAt"]
);
export const listOutputSchema = {
  // status is intentionally narrower than the full AgentStatus set: see MCP_AGENT_LIST_STATUSES.
  oneOf: [
    strict(
      {
        ok: { const: true },
        requestId: { type: "string" },
        workspace: strict(
          {
            configured: { type: "boolean" },
            approvalStatus: {
              type: "string",
              enum: ["approved", "approval-required", "not-configured", "invalid"]
            }
          },
          ["configured", "approvalStatus"]
        ),
        agents: {
          type: "array",
          items: strict(
            {
              alias: { type: "string", pattern: ALIAS_PATTERN },
              name: { type: "string" },
              kind: { type: "string", enum: ["m365-agent-builder", "sharepoint-agent", "copilot-studio"] },
              description: { type: "string" },
              usageHint: { type: "string" },
              capabilityClass: { type: "string", enum: ["knowledge-only", "actions-possible", "unknown"] },
              status: { type: "string", enum: [...MCP_AGENT_LIST_STATUSES] },
              lastValidatedAt: { type: "string", format: "date-time" },
              remediation: { type: "string" }
            },
            ["alias", "status"]
          )
        }
      },
      ["ok", "requestId", "workspace", "agents"]
    ),
    errorEnvelope
  ]
};
export const askOutputSchema = {
  oneOf: [
    strict(
      {
        ok: { const: true },
        requestId: { type: "string" },
        agent: { type: "string" },
        conversationHandle: { type: "string", pattern: HANDLE_PATTERN },
        conversationClosed: {
          type: "boolean",
          description: "True when the one-shot conversation handle was closed before this response returned."
        },
        conversationCleanupPending: {
          type: "boolean",
          description:
            "True when one-shot cleanup needs a maintenance retry; the returned handle is not reusable."
        },
        text: { type: "string" },
        citations: { type: "array", items: citationSchema },
        attachments: { type: "array", items: attachmentSchema },
        elapsedMs: { type: "number", minimum: 0 },
        truncated: { type: "boolean" },
        actionRequired: { type: "boolean" },
        submissionState: { const: "sent" },
        sourceType: { const: "m365-agent" }
      },
      [
        "ok",
        "requestId",
        "agent",
        "conversationHandle",
        "text",
        "citations",
        "attachments",
        "elapsedMs",
        "truncated",
        "actionRequired",
        "submissionState",
        "sourceType"
      ]
    ),
    errorEnvelope
  ]
};
export const sessionOutputSchema = {
  oneOf: [
    strict(
      {
        ok: { const: true },
        requestId: { type: "string" },
        action: { type: "string", enum: ["new", "list", "close", "close_all", "read"] },
        conversation: conversationSchema,
        conversations: { type: "array", items: conversationSchema },
        closedCount: { type: "integer", minimum: 0 },
        message: {
          type: "string",
          enum: ["shown", "differs", "not-shown", "unconfirmed", "none"],
          description:
            "action=read: shown -- the last message AgentPickLink entered in this conversation is its latest user message; differs -- a user message appeared after it was entered but does not match it exactly (it may be shown differently, or only part of it was sent), so do not send it again blindly; not-shown -- it was not sent: the send control was never pressed, or the page kept the message in its composer and showed no new user message, even after waiting the acknowledgement time again; only then may the message be sent again; unconfirmed -- it is not shown, but nothing shows that it was not sent (the page emptied the composer, or what it shows is ambiguous), so do not send it again: read again later, or ask the user to check the conversation in Microsoft 365; none -- AgentPickLink has entered no message in this conversation."
        },
        messageRequestId: {
          type: "string",
          description:
            "action=read: the requestId of the ask that entered the message described by message, to match it with that ask's result."
        },
        reply: {
          type: "string",
          enum: ["complete", "incomplete", "none"],
          description:
            "action=read: the reply to the latest user message. complete -- text, citations and attachments hold it; incomplete -- it did not finish while reading (partialResponse holds what it showed); none -- no reply started while reading."
        },
        text: { type: "string" },
        citations: { type: "array", items: citationSchema },
        attachments: { type: "array", items: attachmentSchema },
        truncated: { type: "boolean" },
        actionRequired: { type: "boolean" },
        sourceType: { const: "m365-agent" },
        partialResponse: strict(
          { text: { type: "string" }, citations: { type: "array", items: citationSchema } },
          ["text", "citations"]
        ),
        conversationClosed: {
          type: "boolean",
          description:
            "action=read: true when a conversation kept open by a failed one-shot ask was closed because its reply has now been collected."
        }
      },
      ["ok", "requestId", "action"]
    ),
    errorEnvelope
  ]
};

export type AskInput = { agent: string; message: string; conversationHandle?: string; expectFiles?: boolean };
export type SessionInput = { action: SessionAction; agent?: string; conversationHandle?: string };
