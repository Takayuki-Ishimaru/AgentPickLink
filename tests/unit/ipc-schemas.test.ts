import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { BROKER_CANCEL_MINOR, BROKER_PROTOCOL, BROKER_READ_MINOR } from "../../src/ipc/protocol.js";
import { BrokerMethodSchemas, parseMethod } from "../../src/ipc/schemas.js";
import { SENDABLE_MESSAGES, WHITESPACE_ONLY_MESSAGES } from "../helpers/message-vectors.js";

const invalid = expect.objectContaining({
  code: "INVALID_ARGUMENT",
  message: "Broker method arguments are invalid."
});

const invokeParams = { root: "/workspace", agent: "requirements", message: "hello" };
const readParams = { root: "/workspace", conversationHandle: "conv_kept-1_A" };

describe("broker protocol minor 5", () => {
  it("is the minor that adds conversation.read, ahead of the minor that added broker.cancel", () => {
    expect(BROKER_PROTOCOL).toEqual({ major: 1, minor: 5 });
    expect(BROKER_READ_MINOR).toBe(5);
    expect(BROKER_CANCEL_MINOR).toBe(4);
    expect(BROKER_READ_MINOR).toBeLessThanOrEqual(BROKER_PROTOCOL.minor);
  });
});

describe("IPC conversation.invoke parameters", () => {
  const parse = (params: unknown) => parseMethod("conversation.invoke", params);

  it.each(WHITESPACE_ONLY_MESSAGES)("refuses a message of %s", (_name, message) => {
    expect(() => parse({ ...invokeParams, message })).toThrow(invalid);
  });

  it.each(SENDABLE_MESSAGES)("accepts %s and hands it on byte for byte", (_name, message) => {
    const parsed = parse({ ...invokeParams, message });
    expect(parsed.method).toBe("conversation.invoke");
    expect(parsed.params.message).toBe(message);
  });

  it.each([[true], [false]])("accepts expectFiles=%s and keeps it", (expectFiles) => {
    expect(parse({ ...invokeParams, expectFiles }).params).toEqual({ ...invokeParams, expectFiles });
  });

  it("does not invent expectFiles when the caller leaves it out", () => {
    const { params } = parse(invokeParams);
    expect(params).toEqual(invokeParams);
    expect("expectFiles" in params).toBe(false);
  });

  it.each([["yes"], ["true"], ["false"], [1], [0], [null], [[]], [{}]])(
    "refuses expectFiles=%j, which is not a boolean",
    (expectFiles) => {
      expect(() => parse({ ...invokeParams, expectFiles })).toThrow(invalid);
    }
  );

  it("stays strict: an unknown or misspelled field is refused", () => {
    expect(() => parse({ ...invokeParams, expectfiles: false })).toThrow(invalid);
    expect(() => parse({ ...invokeParams, extra: 1 })).toThrow(invalid);
  });

  it("keeps validating the rest of the parameters", () => {
    expect(() => parse({ ...invokeParams, conversationHandle: "raw" })).toThrow(invalid);
    expect(() => parse({ ...invokeParams, root: "" })).toThrow(invalid);
    expect(() => parse({ agent: "requirements", message: "hello" })).toThrow(invalid);
    expect(parse({ ...invokeParams, conversationHandle: "conv_abc" }).params).toMatchObject({
      conversationHandle: "conv_abc"
    });
  });
});

describe("IPC conversation.read parameters", () => {
  const parse = (params: unknown) => parseMethod("conversation.read", params);

  it("is a method of the broker protocol", () => {
    expect(Object.keys(BrokerMethodSchemas)).toContain("conversation.read");
  });

  it("accepts a workspace root and a conversation handle, and nothing else", () => {
    expect(parse(readParams)).toEqual({ method: "conversation.read", params: readParams });
  });

  it.each([
    ["no handle", { root: "/workspace" }],
    ["no root", { conversationHandle: "conv_kept" }],
    ["an empty root", { root: "", conversationHandle: "conv_kept" }],
    ["a non-string root", { root: 7, conversationHandle: "conv_kept" }],
    ["a handle without the conv_ prefix", { root: "/workspace", conversationHandle: "kept" }],
    ["a handle with nothing after the prefix", { root: "/workspace", conversationHandle: "conv_" }],
    ["a handle with a trailing newline", { root: "/workspace", conversationHandle: "conv_kept\n" }],
    ["a handle with a space", { root: "/workspace", conversationHandle: "conv_ke pt" }],
    ["a handle with a path separator", { root: "/workspace", conversationHandle: "conv_../kept" }],
    ["a non-string handle", { root: "/workspace", conversationHandle: 42 }],
    ["an agent", { ...readParams, agent: "requirements" }],
    ["a message", { ...readParams, message: "hello" }],
    ["expectFiles", { ...readParams, expectFiles: false }],
    ["an unknown field", { ...readParams, extra: true }],
    ["no parameters at all", undefined],
    ["a non-object", "conv_kept"]
  ])("refuses %s", (_name, params) => {
    expect(() => parse(params)).toThrow(invalid);
  });

  it("refuses the misspelled method as an unknown one, not as invalid arguments", () => {
    for (const method of ["conversation.reads", "conversation.Read", "conversation.read "])
      expect(() => parseMethod(method, readParams)).toThrow(
        expect.objectContaining({ code: "BROKER_PROTOCOL_ERROR" })
      );
    expect(() => parse(undefined)).toThrow(DomainError);
  });
});
