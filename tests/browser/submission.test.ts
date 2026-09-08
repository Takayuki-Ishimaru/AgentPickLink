import { describe, expect, it } from "vitest";
import { GenericDiagnosticAdapter } from "../../src/transports/browser/adapters/generic-diagnostic-adapter.js";
import { M365CopilotChatAdapter } from "../../src/transports/browser/adapters/index.js";
import { SubmissionTracker } from "../../src/transports/browser/submission-tracker.js";
import type { LocatorLike, PageLike, SubmissionMarker } from "../../src/transports/browser/types.js";

describe("submission safety", () => {
  it("keeps generic diagnostics non-submitting", async () => {
    const adapter = new GenericDiagnosticAdapter();
    expect(adapter.canSubmit).toBe(false);
    await expect(adapter.fillComposer({ url: () => "https://example.com" }, "do not send")).rejects.toThrow(
      "CANNOT_SUBMIT"
    );
  });

  it("fails closed with a DomainError on every method that could click, fill, or prepare a send", async () => {
    const adapter = new GenericDiagnosticAdapter();
    const page = { url: () => "https://example.com" };
    const attempts: Array<() => Promise<unknown>> = [
      () => adapter.findComposer(page),
      () => adapter.startNewConversation(page),
      () => adapter.verifyNewConversation(page, { userCount: 0, assistantCount: 0 }),
      () => adapter.captureSubmissionMarker(page),
      () => adapter.fillComposer(page, "do not send"),
      () => adapter.submitComposer(page)
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow("CANNOT_SUBMIT");
      await expect(attempt()).rejects.toMatchObject({ name: "DomainError", code: "UNSUPPORTED_UI" });
    }
  });

  it("never reaches the base class's real new-chat click path", async () => {
    const adapter = new GenericDiagnosticAdapter();
    let touched = false;
    const page = {
      url: () => "https://example.com",
      getByRole: () => {
        touched = true;
        return {
          count: async () => 1,
          isVisible: async () => true,
          isEnabled: async () => true,
          click: async () => {
            touched = true;
          }
        };
      }
    };
    await expect(adapter.startNewConversation(page)).rejects.toThrow("CANNOT_SUBMIT");
    expect(touched).toBe(false);
  });

  it("reports an acknowledgement timeout as unknown, because the send control was already activated", async () => {
    // The prompt may well have been sent and simply not rendered yet. Calling this "not-sent"
    // invites a duplicate submission, which is the one thing that must never happen.
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });

    const ack = await adapter.waitForUserMessageAck(ackPage({ composerText: "" }), marker(), 30);

    expect(ack.state).toBe("unknown");
    expect(ack.reason).toContain("after the send control was activated");
  });

  it("reports not-sent only on the positive signal that the composer still holds the exact text", async () => {
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });

    const ack = await adapter.waitForUserMessageAck(ackPage({ composerText: "hello" }), marker(), 30);

    expect(ack).toMatchObject({ state: "not-sent" });
  });

  it("stays unknown when a user message did appear but could not be correlated", async () => {
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });

    const ack = await adapter.waitForUserMessageAck(
      ackPage({ composerText: "hello", userCount: 2 }),
      marker(),
      30
    );

    expect(ack.state).toBe("unknown");
  });

  it("does not turn unknown acknowledgement into sent", () => {
    const tracker = new SubmissionTracker();
    tracker.record({
      userCount: 0,
      assistantCount: 0,
      url: "https://example.com",
      identityDigest: "x",
      composerValue: "x",
      capturedAt: 0
    });
    tracker.acknowledge({ state: "unknown" });
    expect(tracker.state).toBe("unknown");
    expect(tracker.phase).toBe("FAILED");
  });
});

function marker(): SubmissionMarker {
  return {
    userCount: 0,
    assistantCount: 0,
    url: "https://m365.example.test/chat",
    identityDigest: "digest",
    composerValue: "hello",
    capturedAt: Date.now()
  };
}

/** A chat page that never acknowledges: the user message count does not move past `userCount`. */
function ackPage(options: { composerText: string; userCount?: number }): PageLike {
  const composer: LocatorLike = {
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    textContent: async () => options.composerText
  };
  return {
    url: () => "https://m365.example.test/chat",
    locator: () => composer,
    evaluate: async (fn: unknown) =>
      (String(fn).includes("const all")
        ? { userCount: options.userCount ?? 0, assistantCount: 0 }
        : undefined) as never,
    waitForTimeout: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  };
}
