import { describe, expect, it } from "vitest";
import {
  escapeRegex,
  MESSAGE_MAX_CHARACTERS,
  messageCharacterCount,
  pathPattern,
  slug
} from "../../src/domain/text.js";
import { parseMethod } from "../../src/ipc/schemas.js";

describe("slug", () => {
  it("lowercases, hyphenates, and strips non-alphanumeric characters", () => {
    expect(slug("Requirements Agent")).toBe("requirements-agent");
    expect(slug("  Leading/Trailing  ")).toBe("leading-trailing");
    expect(slug("日本語 Agent")).not.toBe("");
  });

  it("collapses runs of separators and trims leading/trailing hyphens", () => {
    expect(slug("---a---b---")).toBe("a-b");
  });

  it("caps the result at 64 characters", () => {
    expect(slug("a".repeat(200)).length).toBe(64);
  });

  it("falls back to 'agent' when nothing survives normalization", () => {
    expect(slug("!!!")).toBe("agent");
    expect(slug("")).toBe("agent");
  });
});

describe("escapeRegex", () => {
  it("escapes every regex metacharacter", () => {
    expect(escapeRegex("a.b*c?d^e$f{g}h(i)j|k[l]m\\n")).toBe(
      "a\\.b\\*c\\?d\\^e\\$f\\{g\\}h\\(i\\)j\\|k\\[l\\]m\\\\n"
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeRegex("chat-agent_1")).toBe("chat-agent_1");
  });

  it("produces a pattern that matches the literal input it was built from", () => {
    const literal = "a.b(c)[d]";
    expect(new RegExp(`^${escapeRegex(literal)}$`).test(literal)).toBe(true);
  });
});

describe("pathPattern", () => {
  it("wildcards the segment right after conversation/thread/session", () => {
    expect(pathPattern("/chat/conversations/abc-123")).toBe("^/chat/conversations/[^/]+$");
    expect(pathPattern("/chat/thread/xyz")).toBe("^/chat/thread/[^/]+$");
    expect(pathPattern("/chat/session/1")).toBe("^/chat/session/[^/]+$");
  });

  it("escapes every other segment literally", () => {
    expect(pathPattern("/chat/agent/T_agent.gpt.instance")).toBe("^/chat/agent/T_agent\\.gpt\\.instance$");
  });

  it("round-trips: the produced pattern matches the exact path it was built from", () => {
    const path = "/chat/agent/T_agent.gpt.instance/conversation/abc-123";
    expect(new RegExp(pathPattern(path)).test(path)).toBe(true);
  });

  it("does not match a different conversation id in the wildcarded segment mismatched elsewhere", () => {
    const pattern = new RegExp(pathPattern("/chat/agent/fixed-id/conversation/abc"));
    expect(pattern.test("/chat/agent/fixed-id/conversation/xyz")).toBe(true);
    expect(pattern.test("/chat/agent/different-id/conversation/xyz")).toBe(false);
  });
});

describe("message length (one rule for the MCP schema, the MCP check and the broker)", () => {
  it("counts code points, as JSON Schema's maxLength does", () => {
    expect(messageCharacterCount("abc")).toBe(3);
    expect(messageCharacterCount("😀日本")).toBe(3);
    expect(messageCharacterCount("👩\u200d💻")).toBe(3);
    expect(messageCharacterCount("")).toBe(0);
  });

  it.each([
    ["😀".repeat(MESSAGE_MAX_CHARACTERS), true],
    ["x".repeat(MESSAGE_MAX_CHARACTERS), true],
    ["x".repeat(MESSAGE_MAX_CHARACTERS + 1), false],
    ["", false]
  ])("the broker's conversation.invoke accepts what the MCP tool accepts (#%#)", (message, accepted) => {
    const parse = () =>
      parseMethod("conversation.invoke", { root: "/workspace", agent: "requirements", message });
    if (accepted) expect(parse().params).toMatchObject({ message });
    else expect(parse).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
