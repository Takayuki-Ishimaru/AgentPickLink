import { describe, expect, it, vi } from "vitest";
import { turnFixture } from "../helpers/turn-fixtures.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { ConversationDriver, enteredMessage } from "../../src/transports/browser/conversation-driver.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import type { ChatUiAdapter } from "../../src/transports/browser/ui-adapter.js";
import type {
  BrowserAgentDefinition,
  ConversationExchange,
  EnteredMessage,
  PageLike
} from "../../src/transports/browser/types.js";

// Reading a conversation (m365_agent_session action=read) answers "not-shown" only with evidence
// that the message did not go out, since that answer lets the caller send it again (independent
// review of the 2026-10-10 fixes): one look at a page that is re-rendering, a page that took the
// message without showing it, and an acknowledged message must never be reported as not shown.

const QUESTION = "Which approval route applies?";
const fingerprint = `sha256:${"a".repeat(64)}`;
const agent: BrowserAgentDefinition = {
  alias: "requirements",
  displayName: "Requirements",
  transport: "browser",
  kind: "m365-agent-builder",
  entryPoint: { mode: "direct-chat", url: "https://m365.example.test/chat", surface: "m365-copilot" },
  enabled: true,
  capabilityClass: "knowledge-only",
  uiActionPolicy: "never-click",
  verification: {
    status: "verified",
    adapterId: "fixture@1",
    expectedDisplayName: "Requirements",
    expectedSurface: "m365-copilot",
    validatedUrlPattern: "^/chat$",
    bindingFingerprint: fingerprint,
    validatedAt: "2026-09-01T00:00:00.000Z"
  }
};
const conversation = {
  handle: "conv_read",
  agentAlias: "requirements",
  bindingFingerprint: fingerprint,
  pageKey: "page",
  state: "ready"
};
const page: PageLike = { url: () => "https://m365.example.test/chat", on: () => {}, off: () => {} };

const driver = (options: { ackTimeoutMs?: number; responseStartTimeoutMs?: number } = {}) =>
  new ConversationDriver(
    new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
    { save: vi.fn(async () => []) } as never,
    {
      ackTimeoutMs: options.ackTimeoutMs ?? 100,
      responseStartTimeoutMs: options.responseStartTimeoutMs ?? 200,
      attachmentSettleMs: 0
    }
  );

/** The record of an ask that typed QUESTION, with how far its submission got. `settledAt` far in the
 * past means the acknowledgement time has long passed, so a read does not wait for the message. */
function entry(
  state: EnteredMessage["state"],
  userCountBefore: number | undefined,
  options: { settledLongAgo?: boolean; requestId?: string } = {}
): EnteredMessage {
  return {
    ...enteredMessage(QUESTION, options.requestId),
    typed: true,
    state,
    ...(userCountBefore === undefined ? {} : { turnBefore: turnFixture(userCountBefore) }),
    ...(userCountBefore === undefined ? {} : { userCountBefore }),
    ...(options.settledLongAgo === false ? {} : { settledAt: Date.now() - 60_000 })
  };
}

/** One exchange per look, the last one repeating. */
function looks(...steps: Array<Partial<ConversationExchange>>) {
  let call = 0;
  return vi.fn(async (): Promise<ConversationExchange> => {
    const step = steps[Math.min(call++, steps.length - 1)];
    return {
      userCount: 0,
      assistantCount: 0,
      replyStarted: false,
      readable: true,
      turn: turnFixture(step.userCount ?? 0, step.replyStarted ?? false),
      ...step
    };
  });
}

function adapter(capture: ChatUiAdapter["captureExchange"], overrides: Partial<ChatUiAdapter> = {}) {
  const identity = {
    displayName: "Requirements",
    surface: "m365-copilot" as const,
    digest: "expected",
    evidence: ["visible-name" as const]
  };
  const refuse = async () => {
    throw new Error("reading must not type, clear or press anything");
  };
  return {
    id: "fixture@1",
    canSubmit: true,
    canHandle: async () => ({ matched: true, confidence: "strong" }),
    detectAuthState: async () => "authenticated",
    detectAgentIdentity: async () => identity,
    assertAgentIdentity: async () => ({ valid: true, identity }),
    findComposer: async () => ({}),
    captureConversationMarker: async () => ({ userCount: 0, assistantCount: 0 }),
    startNewConversation: refuse,
    verifyNewConversation: async () => ({ verified: true }),
    captureSubmissionMarker: refuse,
    fillComposer: refuse,
    clearComposer: refuse,
    submitComposer: refuse,
    waitForUserMessageAck: refuse,
    waitForResponseStart: refuse,
    waitForResponseComplete: async () => ({ complete: true }),
    extractLatestResponse: async () => ({
      text: "Use route B.",
      citations: [],
      actionRequired: false,
      truncated: false
    }),
    captureExchange: capture,
    ...overrides
  } as unknown as ChatUiAdapter;
}

const read = (
  capture: ChatUiAdapter["captureExchange"],
  entered: EnteredMessage,
  options: { signal?: AbortSignal; overrides?: Partial<ChatUiAdapter>; ackTimeoutMs?: number } = {}
) =>
  driver({ ackTimeoutMs: options.ackTimeoutMs }).read(
    page,
    conversation as never,
    agent,
    adapter(capture, options.overrides),
    {
      entered,
      ...(options.signal ? { signal: options.signal } : {})
    }
  );

describe("reading: what counts as not shown", () => {
  it("does not wait for a missing identity name during a snapshot", async () => {
    const directPage = { ...page, url: () => "https://m365.example.test/chat/agent/agent-alpha" };
    const directAgent = {
      ...agent,
      verification: {
        ...agent.verification,
        expectedStableAgentId: "agent-alpha",
        validatedUrlPattern: "^/chat/agent/agent-alpha$"
      }
    };
    const chat = adapter(looks({ userCount: 0 }), {
      assertAgentIdentity: vi.fn(async () => ({ valid: false }))
    });
    await expect(
      driver({ responseStartTimeoutMs: 90000 }).read(directPage, conversation as never, directAgent, chat, {
        entered: entry("unknown", 0),
        waitMs: 0
      })
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHANGED" });
    expect(chat.assertAgentIdentity).toHaveBeenCalledTimes(1);
  });
  it("snapshots an unconfirmed message without acknowledgement polls or resending", async () => {
    const capture = looks({ userCount: 0, composerText: QUESTION });
    const chat = adapter(capture);
    const complete = vi.spyOn(chat, "waitForResponseComplete");
    await expect(
      driver({ ackTimeoutMs: 90000 }).read(page, conversation as never, agent, chat, {
        entered: entry("unknown", 0, { settledLongAgo: false }),
        waitMs: 0
      })
    ).resolves.toEqual({ message: "unconfirmed", reply: "none" });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("snapshots an acknowledged question without the response-start wait", async () => {
    const capture = looks({ userCount: 1, latestUserText: QUESTION, replyStarted: false });
    const chat = adapter(capture);
    const complete = vi.spyOn(chat, "waitForResponseComplete");
    await expect(
      driver({ responseStartTimeoutMs: 90000 }).read(page, conversation as never, agent, chat, {
        entered: entry("sent", 0),
        waitMs: 0
      })
    ).resolves.toEqual({ message: "shown", reply: "none" });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns correlated snapshot text without waiting for stability or claiming completion", async () => {
    const capture = looks({ userCount: 1, latestUserText: QUESTION, replyStarted: true });
    const chat = adapter(capture);
    const complete = vi.spyOn(chat, "waitForResponseComplete");
    await expect(
      driver().read(page, conversation as never, agent, chat, {
        entered: entry("sent", 0),
        waitMs: 0
      })
    ).resolves.toEqual({
      message: "shown",
      reply: "incomplete",
      partialResponse: { text: "Use route B.", citations: [] }
    });
    expect(complete).not.toHaveBeenCalled();
  });
  it("remains unconfirmed when the page kept the message in its composer and shows no new user message", async () => {
    const capture = looks({ userCount: 2, latestUserText: "an earlier question", composerText: QUESTION });
    await expect(read(capture, entry("unknown", 2))).resolves.toEqual({
      message: "unconfirmed",
      reply: "none"
    });
    // Two looks in a row agreed before answering.
    expect(capture.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("is unconfirmed when the page emptied the composer but shows no new user message", async () => {
    const capture = looks({ userCount: 2, latestUserText: "an earlier question", composerText: "" });
    await expect(read(capture, entry("unknown", 2))).resolves.toEqual({
      message: "unconfirmed",
      reply: "none"
    });
  });

  it("is unconfirmed when the composer cannot be read", async () => {
    const capture = looks({ userCount: 2, latestUserText: "an earlier question" });
    await expect(read(capture, entry("unknown", 2))).resolves.toEqual({
      message: "unconfirmed",
      reply: "none"
    });
  });

  it("is unconfirmed without the count from before typing, even with the message still in the composer", async () => {
    const capture = looks({ userCount: 2, latestUserText: "an earlier question", composerText: QUESTION });
    await expect(read(capture, entry("unknown", undefined))).resolves.toEqual({
      message: "unconfirmed",
      reply: "none"
    });
  });

  it("does not take an identical earlier message for this one, regardless of the composer", async () => {
    // The same question was asked before; this attempt added no user message.
    const kept = looks({
      userCount: 1,
      latestUserText: QUESTION,
      replyStarted: true,
      composerText: QUESTION
    });
    await expect(read(kept, entry("unknown", 1))).resolves.toEqual({ message: "unconfirmed", reply: "none" });
    const taken = looks({ userCount: 1, latestUserText: QUESTION, replyStarted: true, composerText: "" });
    await expect(read(taken, entry("unknown", 1))).resolves.toEqual({
      message: "unconfirmed",
      reply: "none"
    });
  });

  it.each(["unknown", "sent"] as const)(
    "does not identify an old identical message without a readable baseline (%s)",
    async (state) => {
      const capture = looks({ latestUserText: QUESTION, replyStarted: true, composerText: QUESTION });
      await expect(read(capture, entry(state, undefined))).resolves.toEqual({
        message: "unconfirmed",
        reply: "none"
      });
    }
  );

  it.each([0, 1])(
    "keeps an acknowledged message unconfirmed while a re-render shows an old identical bubble (count=%s)",
    async (userCount) => {
      const capture = looks({ userCount, latestUserText: QUESTION, replyStarted: true });
      const entered = entry("sent", 1);
      await expect(read(capture, entered)).resolves.toEqual({ message: "unconfirmed", reply: "none" });
      // Once the new bubble is visible, the same record recovers its actual reply without sending.
      const restored = looks({
        userCount: 2,
        assistantCount: 2,
        latestUserText: QUESTION,
        replyStarted: true
      });
      await expect(read(restored, entered)).resolves.toMatchObject({ message: "shown", reply: "complete" });
    }
  );

  it("never reports an acknowledged message as not shown, whatever the page shows now", async () => {
    // The page shows fewer user messages than before typing (a list being re-rendered) ...
    const fewer = looks({ userCount: 1, latestUserText: "an earlier question", composerText: QUESTION });
    await expect(read(fewer, entry("sent", 3))).resolves.toEqual({ message: "unconfirmed", reply: "none" });
    // ... or an identical latest bubble without the count having grown: it may be an older one.
    const latest = looks({ userCount: 3, latestUserText: QUESTION, replyStarted: true, assistantCount: 3 });
    await expect(read(latest, entry("sent", 3))).resolves.toMatchObject({
      message: "unconfirmed",
      reply: "none"
    });
  });

  it("answers from looks that agree: one look at a page being re-rendered decides nothing", async () => {
    // The first look shows no new message; the next shows the message.
    const capture = looks(
      { userCount: 2, latestUserText: "an earlier question", composerText: QUESTION },
      { userCount: 3, latestUserText: QUESTION, replyStarted: true, assistantCount: 3 }
    );
    await expect(read(capture, entry("unknown", 2))).resolves.toMatchObject({
      message: "shown",
      reply: "complete",
      response: { text: "Use route B." }
    });
  });

  it("is unconfirmed when looks never agree on not shown", async () => {
    const notShown = { userCount: 2, latestUserText: "an earlier question", composerText: QUESTION };
    const unreadable = { userCount: 0, readable: false };
    // The first look and four more, alternating: the last one says not shown, but never twice in a row.
    const capture = looks(notShown, unreadable, notShown, unreadable, notShown);
    await expect(read(capture, entry("unknown", 2))).resolves.toEqual({
      message: "unconfirmed",
      reply: "none"
    });
    expect(capture).toHaveBeenCalledTimes(5);
  });

  it("takes a look the page could not run its scripts for as unreadable, not as an empty conversation", async () => {
    // A fallback count of zero against a count of two before typing would otherwise say "not shown".
    const capture = looks(
      { userCount: 0, readable: false, composerText: QUESTION },
      { userCount: 3, latestUserText: QUESTION, replyStarted: true, assistantCount: 3 }
    );
    await expect(read(capture, entry("unknown", 2))).resolves.toMatchObject({ message: "shown" });
  });

  it("fails, sending nothing, when the conversation cannot be read at all", async () => {
    const capture = looks({ userCount: 0, readable: false });
    await expect(read(capture, entry("unknown", 2))).rejects.toMatchObject({
      code: "UI_CHANGED",
      message: expect.stringContaining("read the conversation again")
    });
  });

  it("still reports a message that was never pressed as not shown, at once", async () => {
    const capture = looks({ userCount: 1, latestUserText: QUESTION, replyStarted: true });
    const started = Date.now();
    await expect(read(capture, entry("not-sent", 1))).resolves.toEqual({
      message: "not-shown",
      reply: "none"
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("reading: which ask, and cancellation", () => {
  it("names the ask whose message it judged", async () => {
    const capture = looks({ userCount: 1, latestUserText: QUESTION, replyStarted: true, assistantCount: 1 });
    await expect(read(capture, entry("unknown", 0, { requestId: "req_first" }))).resolves.toMatchObject({
      message: "shown",
      messageRequestId: "req_first",
      reply: "complete"
    });
    const unknown = looks({ userCount: 0, composerText: QUESTION });
    await expect(read(unknown, entry("unknown", 0, { requestId: "req_first" }))).resolves.toEqual({
      message: "unconfirmed",
      messageRequestId: "req_first",
      reply: "none"
    });
  });

  it("reports a cancellation while the reply is being collected as a cancellation, not as an unfinished reply", async () => {
    const controller = new AbortController();
    const capture = looks({ userCount: 1, latestUserText: QUESTION, replyStarted: true, assistantCount: 1 });
    await expect(
      read(capture, entry("sent", 0), {
        signal: controller.signal,
        overrides: {
          waitForResponseComplete: async () => {
            controller.abort();
            return { complete: false, cancelled: true, reason: "cancelled" };
          }
        }
      })
    ).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT", message: "Reading the conversation was cancelled." });
  });

  it("stops at a cancellation between looks", async () => {
    const controller = new AbortController();
    const capture = vi.fn(async (): Promise<ConversationExchange> => {
      controller.abort();
      return { userCount: 2, assistantCount: 0, replyStarted: false, readable: true, composerText: QUESTION };
    });
    await expect(read(capture, entry("unknown", 2), { signal: controller.signal })).rejects.toMatchObject({
      code: "RESPONSE_TIMEOUT"
    });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("keeps a 65-second delayed submission unconfirmed after the extra default ACK window, then reads it", async () => {
    vi.useFakeTimers();
    try {
      const pressedAt = Date.now();
      const capture = vi.fn(async (): Promise<ConversationExchange> =>
        Date.now() >= pressedAt + 65_000
          ? {
              userCount: 1,
              assistantCount: 1,
              latestUserText: QUESTION,
              replyStarted: true,
              readable: true,
              turn: turnFixture(1)
            }
          : {
              userCount: 0,
              assistantCount: 0,
              replyStarted: false,
              readable: true,
              composerText: QUESTION,
              turn: turnFixture(0)
            }
      );
      // The ask already spent the first default 30-second acknowledgement window.
      await vi.advanceTimersByTimeAsync(30_000);
      const entered = { ...entry("unknown", 0), settledAt: Date.now(), requestId: "req_delayed" };
      const pending = read(capture, entered, { ackTimeoutMs: 30_000 });
      await vi.advanceTimersByTimeAsync(30_200);
      await expect(pending).resolves.toEqual({
        message: "unconfirmed",
        messageRequestId: "req_delayed",
        reply: "none"
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(read(capture, entered, { ackTimeoutMs: 30_000 })).resolves.toMatchObject({
        message: "shown",
        messageRequestId: "req_delayed",
        reply: "complete"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a message that may have been sent the acknowledgement time again before judging it", async () => {
    // Shown only after 150 ms; the ask ended just now, so the read waits up to 300 ms for it.
    const shownAt = Date.now() + 150;
    const capture = vi.fn(async (): Promise<ConversationExchange> =>
      Date.now() >= shownAt
        ? {
            userCount: 1,
            assistantCount: 1,
            latestUserText: QUESTION,
            replyStarted: true,
            readable: true,
            turn: turnFixture(1)
          }
        : {
            userCount: 0,
            assistantCount: 0,
            replyStarted: false,
            readable: true,
            composerText: "",
            turn: turnFixture(0)
          }
    );
    await expect(
      read(capture, entry("unknown", 0, { settledLongAgo: false }), { ackTimeoutMs: 300 })
    ).resolves.toMatchObject({ message: "shown", reply: "complete" });
  });
});
