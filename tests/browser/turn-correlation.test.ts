import { describe, expect, it } from "vitest";
import {
  correlateTurn,
  submissionContinuityProblem,
  type MessageAnchor,
  type TurnSnapshot
} from "../../src/transports/browser/turn-correlation.js";

const user = (key: string): MessageAnchor => ({ key, role: "user", stable: true });
const reply = (key: string): MessageAnchor => ({ key, role: "assistant", stable: true });
const snapshot = (...messages: MessageAnchor[]): TurnSnapshot => ({
  documentId: "document",
  conversationId: "thread",
  messages
});
const before = snapshot(user("old-question"), reply("old-answer"));

describe("turn continuity before pressing Send", () => {
  it.each([before, snapshot(user("older-history"), ...before.messages), snapshot(reply("old-answer"))])(
    "accepts history changes that retain the stable pre-send tail (#%#)",
    (current) => {
      expect(submissionContinuityProblem(before, current)).toBeUndefined();
    }
  );

  it.each([
    snapshot(user("external-question"), reply("external-answer")),
    snapshot(...before.messages, user("external-question")),
    snapshot(),
    { ...before, documentId: "new-document" },
    { ...before, conversationId: "new-conversation" },
    snapshot(reply("old-answer"), user("old-question"))
  ])("rejects an advanced or lost baseline even without count growth (#%#)", (current) => {
    expect(submissionContinuityProblem(before, current)).toBeTypeOf("string");
  });

  it("permits only a verified empty baseline with no new user", () => {
    const empty = { ...snapshot(), emptyVerified: true };
    expect(submissionContinuityProblem(empty, snapshot())).toBeUndefined();
    expect(submissionContinuityProblem(empty, snapshot(user("external-question")))).toBeDefined();
    expect(submissionContinuityProblem(snapshot(), snapshot())).toBeDefined();
    expect(submissionContinuityProblem(before, undefined)).toBeDefined();
  });
});

describe("correlating a submitted turn independently of DOM message counts", () => {
  it.each([1, 2])(
    "rejects %s historical users prepended before an unchanged identical-question turn",
    (count) => {
      const current = snapshot(
        ...Array.from({ length: count }, (_, i) => user(`history-${i}`)),
        ...before.messages
      );
      expect(correlateTurn(before, current).confirmed).toBe(false);
      expect(correlateTurn(before, current).responseKey).toBeUndefined();
    }
  );
  it("accepts prepended history plus a real new tail and associates only its reply", () => {
    expect(
      correlateTurn(before, snapshot(user("history"), ...before.messages, user("new"), reply("new-answer")))
    ).toMatchObject({
      confirmed: true,
      userKey: "new",
      responseKey: "new-answer"
    });
  });
  it("accepts fewer DOM messages when the pre-send tail remains", () => {
    expect(
      correlateTurn(before, snapshot(reply("old-answer"), user("new"), reply("new-answer")))
    ).toMatchObject({ confirmed: true, responseKey: "new-answer" });
  });
  it("rejects virtualization that loses the pre-send tail before confirmation", () => {
    expect(correlateTurn(before, snapshot(user("new"), reply("new-answer")))).toMatchObject({
      confirmed: false,
      reason: "baseline-tail-missing"
    });
  });
  it("retains a confirmed user even when the baseline tail virtualizes away", () => {
    expect(correlateTurn(before, snapshot(user("new"), reply("new-answer")), "new")).toMatchObject({
      confirmed: true,
      responseKey: "new-answer"
    });
  });
  it("rejects another user's newer turn after a confirmed user", () => {
    expect(
      correlateTurn(
        before,
        snapshot(user("new"), reply("new-answer"), user("other"), reply("other-answer")),
        "new"
      ).confirmed
    ).toBe(false);
  });
  it("never substitutes a similarly placed node for a missing confirmed user", () => {
    expect(
      correlateTurn(before, snapshot(user("replacement"), reply("replacement-answer")), "new").confirmed
    ).toBe(false);
  });
  it("rejects multiple new users and reordered previous messages", () => {
    expect(correlateTurn(before, snapshot(...before.messages, user("new"), user("other"))).confirmed).toBe(
      false
    );
    expect(correlateTurn(before, snapshot(reply("old-answer"), user("old-question"))).confirmed).toBe(false);
  });
  it.each([undefined, snapshot()])("requires a readable baseline/current pair (%s)", (current) => {
    expect(correlateTurn(undefined, current).confirmed).toBe(false);
    expect(correlateTurn(before, current).confirmed).toBe(false);
  });
  it("rejects a different document even when stable keys are repeated", () => {
    expect(
      correlateTurn(before, { ...snapshot(...before.messages, user("new")), documentId: "other" }).confirmed
    ).toBe(false);
  });
  it("rejects duplicated user or response keys in either snapshot", () => {
    for (const duplicate of [user("new"), reply("new-answer")]) {
      const current = snapshot(...before.messages, user("new"), reply("new-answer"), duplicate);
      expect(correlateTurn(before, current).confirmed).toBe(false);
      expect(correlateTurn(current, snapshot(user("future")), "future").confirmed).toBe(false);
    }
  });
  it("supports a first question on an empty conversation, but rejects history starting with an answer", () => {
    expect(
      correlateTurn({ ...snapshot(), emptyVerified: true }, snapshot(user("first"), reply("answer")))
    ).toMatchObject({
      confirmed: true,
      responseKey: "answer"
    });
    expect(correlateTurn(snapshot(), snapshot(reply("history"), user("first"))).confirmed).toBe(false);
  });
  it("does not adopt an older same-question turn when an unverified empty view renders history", () => {
    expect(correlateTurn(snapshot(), snapshot(user("historic-question"), reply("historic-answer")))).toEqual({
      confirmed: false,
      reason: "empty-baseline-unverified"
    });
    expect(
      correlateTurn(
        { ...snapshot(), emptyVerified: true, conversationId: undefined },
        snapshot(user("historic-question"))
      )
    ).toMatchObject({ confirmed: false });
  });
  it("never treats a recycled DOM user as a message-owned ID, even after confirmation", () => {
    const reused = snapshot({ ...user("node:1"), stable: false }, reply("historic-answer"));
    expect(correlateTurn(before, reused, "node:1")).toEqual({
      confirmed: false,
      reason: "unstable-message-identity"
    });
  });
  it("cannot associate a recycled DOM response with a stable question", () => {
    expect(
      correlateTurn(before, snapshot(...before.messages, user("new"), { ...reply("node:2"), stable: false }))
    ).toMatchObject({ confirmed: true, userKey: "new" });
    expect(
      correlateTurn(before, snapshot(...before.messages, user("new"), { ...reply("node:2"), stable: false }))
        .responseKey
    ).toBeUndefined();
  });
  it("rejects a changed conversation even when the document and rendered keys are reused", () => {
    expect(
      correlateTurn(
        before,
        { ...snapshot(user("new"), reply("new-answer")), conversationId: "older-thread" },
        "new"
      )
    ).toMatchObject({ confirmed: false, reason: "document-changed" });
  });
  it("confirms a new question without borrowing an earlier answer or choosing ambiguous replies", () => {
    expect(correlateTurn(before, snapshot(...before.messages, user("new")))).toMatchObject({
      confirmed: true
    });
    expect(correlateTurn(before, snapshot(...before.messages, user("new"))).responseKey).toBeUndefined();
    expect(
      correlateTurn(before, snapshot(...before.messages, user("new"), reply("a"), reply("b"))).responseKey
    ).toBeUndefined();
  });
  it("does not mutate input and keeps interleaved requests independent", () => {
    const a = snapshot(...before.messages, user("a"), reply("answer-a"));
    const b = snapshot(...before.messages, user("b"), reply("answer-b"));
    const copy = JSON.stringify([before, a, b]);
    expect(correlateTurn(before, a).responseKey).toBe("answer-a");
    expect(correlateTurn(before, b).responseKey).toBe("answer-b");
    expect(correlateTurn(before, a, "a").responseKey).toBe("answer-a");
    expect(JSON.stringify([before, a, b])).toBe(copy);
  });
});
