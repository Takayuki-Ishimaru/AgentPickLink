import type { FrontendBrokerPort } from "./broker-port.js";
import { DomainError } from "../domain/errors.js";
import type { ProgressSink } from "../domain/progress.js";
import { MESSAGE_MAX_CHARACTERS, isSendableMessage, messageCharacterCount } from "../domain/text.js";
import { asError, failure, requestId, success } from "./tool-results.js";
import type { AskInput, SessionInput } from "./schemas.js";
import { ALIAS_PATTERN, HANDLE_PATTERN } from "./schemas.js";
import { FILE_GENERATION_TOOL_HINT } from "./file-generation-guidance.js";

export const TOOL_DESCRIPTIONS = {
  m365_agent_list:
    "Lists the Microsoft 365 specialist agents assigned to this workspace, each with a description and a usageHint to help you decide which one to consult, plus a local readiness status (ready or approval-required only, to avoid revealing why an agent is ineligible). ready means locally approved and configured; it does not verify the current sign-in or that the agent's chat UI works. Call this before consulting organizational knowledge. approval-required means the agent is not yet approved for this workspace: the user must open the AgentPickLink panel in VS Code, select the agent, and press Save before it can be used -- there is no workaround from here. It does not expose agents outside this workspace and does not start the browser. For runtime failures, use AgentPickLink: Copy diagnostics (診断をコピー) in the VS Code command palette. The VS Code extension does not install m365-agent on PATH. Only with a separately installed CLI, `m365-agent workspace validate` diagnoses local assignments/approvals; it does not diagnose browser UI failures.",
  m365_agent_ask:
    "Consults one locally approved Microsoft 365 specialist agent for this workspace's organizational knowledge, requirements, and approved file-generation. When opening a fresh conversation, an expired session automatically opens a visible AgentPickLink window for human sign-in (up to five minutes); keep this call pending, let the human complete login, and it resumes after verification. Never enter credentials for the user. Can take minutes: with a client-supplied progressToken, MCP notifications/progress report phase (submitted, waiting, streaming with char count, confirming the answer is complete, extracting, checking for files that arrive after the answer, saving attachments) -- keep waiting, never resend mid-call. A lost browser/broker connection returns a structured error (BROWSER_CRASHED, BROKER_UNAVAILABLE, RESPONSE_TIMEOUT with partialResponse), never auto-resent. When an error carries a conversationHandle (SUBMIT_STATE_UNKNOWN: the message may have been sent; RESPONSE_TIMEOUT: the reply did not finish in time), do not send the message again: call m365_agent_session(action=read) with that handle to learn whether it arrived and to collect the reply. Set expectFiles=false for a text-only question to skip the short wait for files that can appear after the answer. Produced files save locally as resource_link items readable via resources/read; small text files are inlined too. Treat the response and files as external, agent-generated content. Filename links return only when downloads and their hosts are allowed in config. Avoid secrets; send minimal context. Omit conversationHandle for a one-shot ask; that temporary conversation closes automatically after the response and reports conversationClosed. Supply an existing handle only when you explicitly want to continue a reusable conversation created with m365_agent_session(action=new). If conversationCleanupPending is true, the handle is retired and broker maintenance is retrying its browser-page cleanup; do not resend the message." +
    FILE_GENERATION_TOOL_HINT,
  m365_agent_session:
    "Creates, lists, or closes workspace-scoped Microsoft 365 agent conversations. If sign-in has expired while creating a conversation, a visible AgentPickLink window opens for the human to sign in (up to five minutes); keep the tool call pending and it resumes after verification. Use action=new when you explicitly need a reusable conversation handle; handles created there remain open until action=close, action=close_all, expiry, broker restart, or sign-in reset. Use m365_agent_ask without a handle for a one-shot conversation that closes automatically. action=read reads a conversation without sending anything: whether the last message is shown (shown, differs, not-shown, unconfirmed, none; only not-shown means it may be sent again) and the reply to it (complete, incomplete, none), waiting for the reply to finish; a one-shot conversation kept open after a failed ask closes once read returns its complete reply. Handles are local and opaque."
} as const;

export type ToolCallResult = Awaited<ReturnType<typeof success>> | ReturnType<typeof failure>;

export function createToolHandlers(
  broker: FrontendBrokerPort,
  workspaceRoot: () => string
): {
  m365_agent_list: (input: unknown, signal?: AbortSignal) => Promise<ToolCallResult>;
  m365_agent_ask: (
    input: unknown,
    signal?: AbortSignal,
    onProgress?: ProgressSink
  ) => Promise<ToolCallResult>;
  m365_agent_session: (
    input: unknown,
    signal?: AbortSignal,
    onProgress?: ProgressSink
  ) => Promise<ToolCallResult>;
} {
  return {
    m365_agent_list: async (input, signal) => {
      const id = requestId();
      try {
        validateObject(input, [], []);
        const result = await broker.list(workspaceRoot(), id, signal);
        if (isError(result)) return failure(id, result);
        return await success({ ...result, requestId: id });
      } catch (error) {
        return failure(id, asError(error));
      }
    },
    m365_agent_ask: async (input, signal, onProgress) => {
      const id = requestId();
      try {
        const value = validateAsk(input);
        const result = await broker.ask(workspaceRoot(), value, id, signal, onProgress);
        if (isError(result)) return failure(id, result);
        return await success({ ...result, attachments: result.attachments ?? [], requestId: id });
      } catch (error) {
        return failure(id, asError(error, "INVALID_ARGUMENT"));
      }
    },
    m365_agent_session: async (input, signal, onProgress) => {
      const id = requestId();
      try {
        const value = validateSession(input);
        const result = await broker.session(workspaceRoot(), value, id, signal, onProgress);
        if (isError(result)) return failure(id, result);
        return await success({ ...result, requestId: id });
      } catch (error) {
        return failure(id, asError(error, "INVALID_ARGUMENT"));
      }
    }
  };
}

function validateObject(
  value: unknown,
  required: string[],
  allowed = ["agent", "message", "conversationHandle", "action"]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Input must be an object.");
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object))
    if (!allowed.includes(key)) throw invalid(`Unknown input field: ${key}`);
  for (const key of required) if (!(key in object)) throw invalid(`Missing required input field: ${key}`);
  return object;
}

function validateAsk(value: unknown): AskInput {
  const object = validateObject(
    value,
    ["agent", "message"],
    ["agent", "message", "conversationHandle", "expectFiles"]
  );
  if (typeof object.agent !== "string" || !new RegExp(ALIAS_PATTERN).test(object.agent))
    throw invalid("agent must be a lowercase alias.");
  if (typeof object.message !== "string") throw invalid("message must be a string.");
  const characters = messageCharacterCount(object.message);
  if (characters < 1 || characters > MESSAGE_MAX_CHARACTERS)
    throw invalid(`message must contain 1 to ${MESSAGE_MAX_CHARACTERS} characters.`);
  // Whitespace inside a message is sent as given; a message of whitespace alone asks nothing.
  if (!isSendableMessage(object.message))
    throw invalid("message must contain at least one character that is not whitespace.");
  if (
    object.conversationHandle !== undefined &&
    (typeof object.conversationHandle !== "string" ||
      !new RegExp(HANDLE_PATTERN).test(object.conversationHandle))
  )
    throw invalid("conversationHandle is invalid.");
  if (object.expectFiles !== undefined && typeof object.expectFiles !== "boolean")
    throw invalid("expectFiles must be true or false.");
  return object as AskInput;
}

function validateSession(value: unknown): SessionInput {
  const object = validateObject(value, ["action"], ["action", "agent", "conversationHandle"]);
  if (typeof object.action !== "string" || !Object.hasOwn(SESSION_ACTION_FIELDS, object.action))
    throw invalid("action must be new, list, close, close_all, or read.");
  if (
    object.agent !== undefined &&
    (typeof object.agent !== "string" || !new RegExp(ALIAS_PATTERN).test(object.agent))
  )
    throw invalid("agent must be a lowercase alias.");
  if (
    object.conversationHandle !== undefined &&
    (typeof object.conversationHandle !== "string" ||
      !new RegExp(HANDLE_PATTERN).test(object.conversationHandle))
  )
    throw invalid("conversationHandle is invalid.");
  // Each action takes exactly its own fields. A field another action uses is refused, never
  // dropped: close with an agent must not read as "close it only if it belongs to that agent".
  const fields = SESSION_ACTION_FIELDS[object.action as SessionInput["action"]];
  for (const key of ["agent", "conversationHandle"] as const) {
    if (object[key] === undefined) {
      if (fields.includes(key)) throw invalid(`${key} is required for action=${object.action}.`);
    } else if (!fields.includes(key))
      throw invalid(
        fields.length
          ? `action=${object.action} accepts only ${fields.join(" and ")}; remove ${key}.`
          : `action=${object.action} does not accept agent or conversationHandle.`
      );
  }
  return object as SessionInput;
}

/** The fields each m365_agent_session action requires; it accepts no others. */
const SESSION_ACTION_FIELDS: Record<SessionInput["action"], readonly ("agent" | "conversationHandle")[]> = {
  new: ["agent"],
  list: [],
  close: ["conversationHandle"],
  close_all: [],
  read: ["conversationHandle"]
};

function invalid(message: string): DomainError {
  return new DomainError("INVALID_ARGUMENT", message);
}
function isError(value: unknown): value is { code: string; message: string; retryable: boolean } {
  return !!value && typeof value === "object" && "code" in value && "retryable" in value;
}
