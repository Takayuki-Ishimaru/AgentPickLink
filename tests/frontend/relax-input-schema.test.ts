import { fromJsonSchema } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { MESSAGE_CONTENT_PATTERN, MESSAGE_MAX_CHARACTERS, isSendableMessage } from "../../src/domain/text.js";
import { parseMethod } from "../../src/ipc/schemas.js";
import type { FrontendBrokerPort } from "../../src/frontend/broker-port.js";
import { PUBLIC_TOOLS } from "../../src/frontend/mcp-server.js";
import {
  HANDLE_PATTERN,
  askInputSchema,
  errorCodes,
  sessionInputSchema,
  sessionOutputSchema
} from "../../src/frontend/schemas.js";
import { createToolHandlers } from "../../src/frontend/tools.js";
import {
  SENDABLE_MESSAGES,
  UNICODE_EDGE_MESSAGES,
  WHITESPACE_ONLY_MESSAGES
} from "../helpers/message-vectors.js";

describe("public input schemas", () => {
  it("keeps typed strict schemas for discovery while application validation owns errors", () => {
    expect(PUBLIC_TOOLS.find((tool) => tool.name === "m365_agent_ask")?.inputSchema).toBe(askInputSchema);
    expect(askInputSchema).toMatchObject({
      type: "object",
      required: ["agent", "message"],
      additionalProperties: false
    });
    expect(askInputSchema.properties.message.type).toBe("string");
    expect(sessionInputSchema.properties.action.enum).toEqual(["new", "list", "close", "close_all", "read"]);
  });

  it("publishes the message content rule next to its length bounds", () => {
    expect(MESSAGE_CONTENT_PATTERN).toBe("^[\\s\\S]*\\S[\\s\\S]*$");
    expect(askInputSchema.properties.message).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: MESSAGE_MAX_CHARACTERS,
      pattern: MESSAGE_CONTENT_PATTERN
    });
    // The pattern is a rule about content only: it has to be a valid ECMAScript pattern in the
    // unicode mode JSON Schema validators compile it with.
    expect(() => new RegExp(askInputSchema.properties.message.pattern, "u")).not.toThrow();
  });

  it("publishes expectFiles as an optional boolean and every other ask field as before", () => {
    expect(Object.keys(askInputSchema.properties)).toEqual([
      "agent",
      "message",
      "conversationHandle",
      "expectFiles"
    ]);
    expect(askInputSchema.properties.expectFiles).toMatchObject({ type: "boolean" });
    expect(askInputSchema.properties.expectFiles.description).toEqual(expect.any(String));
    // Optional: an ask without it keeps its old meaning (wait for files after the answer).
    expect(askInputSchema.required).toEqual(["agent", "message"]);
  });

  it("publishes action=read for the session tool, which needs a handle and no agent", () => {
    const { action, conversationHandle } = sessionInputSchema.properties;
    expect(action.description).toContain("read");
    expect(conversationHandle.description).toContain("read");
    expect(sessionInputSchema.required).toEqual(["action"]);
    expect(sessionInputSchema.additionalProperties).toBe(false);
  });
});

describe("public output schemas for reading a conversation", () => {
  const success = sessionOutputSchema.oneOf[0];
  const failure = sessionOutputSchema.oneOf[1];

  it("lists the read fields in the strict success shape, none of them required", () => {
    expect(success.additionalProperties).toBe(false);
    expect(success.required).toEqual(["ok", "requestId", "action"]);
    expect(Object.keys(success.properties)).toEqual(
      expect.arrayContaining([
        "action",
        "conversation",
        "message",
        "messageRequestId",
        "reply",
        "text",
        "citations",
        "attachments",
        "truncated",
        "actionRequired",
        "sourceType",
        "partialResponse",
        "conversationClosed"
      ])
    );
    expect(success.properties.action.enum).toEqual(["new", "list", "close", "close_all", "read"]);
    expect(success.properties.message.enum).toEqual(["shown", "differs", "not-shown", "unconfirmed", "none"]);
    expect(success.properties.messageRequestId).toMatchObject({ type: "string" });
    expect(success.properties.reply.enum).toEqual(["complete", "incomplete", "none"]);
    expect(success.properties.sourceType).toEqual({ const: "m365-agent" });
    expect(success.properties.partialResponse).toMatchObject({
      additionalProperties: false,
      required: ["text", "citations"]
    });
  });

  it("lets an error carry the handle of the conversation a failed ask left open", () => {
    const error = failure.properties.error;
    expect(error.additionalProperties).toBe(false);
    expect(error.properties.conversationHandle).toMatchObject({ type: "string", pattern: HANDLE_PATTERN });
    expect(error.required).toEqual(["code", "message", "retryable"]);
    // The codes a failed ask can leave a conversation open for are public error codes.
    expect(errorCodes).toEqual(expect.arrayContaining(["SUBMIT_STATE_UNKNOWN", "RESPONSE_TIMEOUT"]));
  });
});

/**
 * One rule, four checkers. The message rule is enforced by the JSON schema a client validates
 * with, by the MCP tool's own argument check, by the broker's IPC parameters and by the helper they
 * share. A message one of them accepts and another refuses would either reach the broker and fail
 * there or be refused for no reason a client can see in the published schema.
 */
describe("the published schema, the MCP check and the broker agree on every message", () => {
  const accepting: FrontendBrokerPort = {
    async list(_root, requestId) {
      return { ok: true, requestId, workspace: { configured: true, approvalStatus: "approved" }, agents: [] };
    },
    async ask(_root, input, requestId) {
      return {
        ok: true,
        requestId,
        agent: input.agent,
        conversationHandle: "conv_agreement",
        text: "answer",
        citations: [],
        attachments: [],
        elapsedMs: 1,
        truncated: false,
        actionRequired: false,
        submissionState: "sent",
        sourceType: "m365-agent"
      };
    },
    async session(_root, input, requestId) {
      return { ok: true, requestId, action: input.action };
    }
  };
  const tools = createToolHandlers(accepting, () => "/workspace");
  const schemaValidator = fromJsonSchema(askInputSchema as never);

  const verdicts = async (message: string) => ({
    helper: isSendableMessage(message),
    schema: !(await schemaValidator["~standard"].validate({ agent: "requirements", message })).issues,
    tool: !(await tools.m365_agent_ask({ agent: "requirements", message })).isError,
    broker: (() => {
      try {
        parseMethod("conversation.invoke", { root: "/workspace", agent: "requirements", message });
        return true;
      } catch {
        return false;
      }
    })()
  });

  it.each(WHITESPACE_ONLY_MESSAGES)("all four refuse %s", async (_name, message) => {
    expect(await verdicts(message)).toEqual({ helper: false, schema: false, tool: false, broker: false });
  });

  it.each(SENDABLE_MESSAGES)("all four accept %s", async (_name, message) => {
    expect(await verdicts(message)).toEqual({ helper: true, schema: true, tool: true, broker: true });
  });

  it.each([
    ["an empty message", ""],
    ["12001 characters", "x".repeat(MESSAGE_MAX_CHARACTERS + 1)],
    ["12001 emoji", "😀".repeat(MESSAGE_MAX_CHARACTERS + 1)]
  ])("all four refuse %s", async (_name, message) => {
    expect(await verdicts(message)).toEqual({ helper: false, schema: false, tool: false, broker: false });
  });

  it.each(UNICODE_EDGE_MESSAGES)("all four give the same verdict on %s", async (_name, message) => {
    const result = await verdicts(message);
    expect(new Set(Object.values(result)).size).toBe(1);
    // Whichever way it is classified, that is exactly what the published pattern says.
    expect(new RegExp(MESSAGE_CONTENT_PATTERN, "u").test(message)).toBe(result.helper);
  });

  it("the published pattern alone matches the content half of the helper's verdict", () => {
    const pattern = new RegExp(askInputSchema.properties.message.pattern, "u");
    for (const [, message] of [...WHITESPACE_ONLY_MESSAGES, ...SENDABLE_MESSAGES, ...UNICODE_EDGE_MESSAGES])
      expect(pattern.test(message)).toBe(/\S/.test(message));
  });
});
