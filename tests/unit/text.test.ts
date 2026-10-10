import { describe, expect, it } from "vitest";
import {
  escapeRegex,
  isSendableMessage,
  MESSAGE_CONTENT_PATTERN,
  MESSAGE_MAX_CHARACTERS,
  messageCharacterCount,
  pathPattern,
  slug
} from "../../src/domain/text.js";
import { parseMethod } from "../../src/ipc/schemas.js";
import { SENDABLE_MESSAGES, WHITESPACE_ONLY_MESSAGES } from "../helpers/message-vectors.js";

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

describe("sendable message (the one rule behind the MCP schema, the MCP check and the broker)", () => {
  it("publishes its content rule as an anchored JSON Schema pattern", () => {
    expect(MESSAGE_CONTENT_PATTERN).toBe("^[\\s\\S]*\\S[\\s\\S]*$");
  });

  // Independent review of the 2026-10-10 fixes: JSON Schema searches the string with a pattern, but
  // a client that constrains its output may match the whole string; with an unanchored "\S" that
  // would allow only one-character messages.
  it.each([...SENDABLE_MESSAGES, ...WHITESPACE_ONLY_MESSAGES])(
    "means the same as a search and as a whole-string match: %s",
    (_name, message) => {
      const search = new RegExp(MESSAGE_CONTENT_PATTERN, "u").test(message);
      const whole = new RegExp(`^(?:${MESSAGE_CONTENT_PATTERN})$`, "u").test(message);
      expect(search).toBe(whole);
      expect(search).toBe(/\S/u.test(message));
    }
  );

  it.each(SENDABLE_MESSAGES)("accepts %s", (_name, message) => {
    expect(isSendableMessage(message)).toBe(true);
  });

  it.each(WHITESPACE_ONLY_MESSAGES)("refuses %s", (_name, message) => {
    expect(isSendableMessage(message)).toBe(false);
  });

  it.each([
    ["an empty message", ""],
    ["12001 characters", "x".repeat(MESSAGE_MAX_CHARACTERS + 1)],
    ["12001 emoji", "\u{1F600}".repeat(MESSAGE_MAX_CHARACTERS + 1)],
    ["12001 characters of which only the last is not whitespace", `${" ".repeat(MESSAGE_MAX_CHARACTERS)}x`]
  ])("refuses %s", (_name, message) => {
    expect(isSendableMessage(message)).toBe(false);
  });

  it("counts the length in code points: 12000 emoji pass although they take 24000 UTF-16 units", () => {
    const emoji = "\u{1F600}".repeat(MESSAGE_MAX_CHARACTERS);
    expect(emoji.length).toBe(2 * MESSAGE_MAX_CHARACTERS);
    expect(isSendableMessage(emoji)).toBe(true);
    expect(isSendableMessage(`${emoji}\u{1F600}`)).toBe(false);
  });

  // Whitespace is what ECMAScript's \s matches, so the helper and the published pattern are one
  // rule. Pinned for every character: the set below is the specification's WhiteSpace and
  // LineTerminator list.
  it("treats exactly the characters of ECMAScript's \\s as whitespace", () => {
    const expected = [
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
      0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff
    ];
    const whitespace: number[] = [];
    for (let point = 0; point <= 0xffff; point++)
      if (!isSendableMessage(String.fromCharCode(point))) whitespace.push(point);
    expect(whitespace).toEqual(expected);
  });

  it("agrees with the published pattern, compiled the way JSON Schema validators do, on every code point", () => {
    const pattern = new RegExp(MESSAGE_CONTENT_PATTERN, "u");
    const disagreements: string[] = [];
    // Every BMP code point (lone surrogates included) and a stride through the astral planes.
    for (let point = 0; point <= 0x10ffff; point += point < 0x10000 ? 1 : 97) {
      const character = String.fromCodePoint(point);
      if (isSendableMessage(character) !== pattern.test(character))
        disagreements.push(`U+${point.toString(16).toUpperCase()}`);
    }
    expect(disagreements).toEqual([]);
  });

  it("looks only at content: whitespace around or between characters never makes a message unsendable", () => {
    for (const message of ["x", " x", "x ", " x ", "\nx\n", "x\u3000y", "\u00a0x", "\t\t\tx\t\t\t"])
      expect(isSendableMessage(message), JSON.stringify(message)).toBe(true);
  });
});
