import { describe, expect, it } from "vitest";
import { CompletionDetector } from "../../src/transports/browser/completion-detector.js";
import type { LocatorLike, PageLike } from "../../src/transports/browser/types.js";

type Signal = { text: string; streaming?: boolean; stopControl?: boolean };

/** A page whose observable state is a scripted sequence: one entry per completion poll. */
function scriptedPage(steps: Signal[]): { page: PageLike; polls: () => number } {
  let index = 0;
  const current = () => steps[Math.min(index, steps.length - 1)] ?? { text: "" };
  const page: PageLike = {
    url: () => "https://m365.example.test/chat",
    evaluate: async () => {
      const step = current();
      return { text: step.text, streaming: step.streaming === true } as never;
    },
    getByRole: (_role, options) => {
      const name = options?.name;
      const matchesStop = name instanceof RegExp && name.test("生成を停止");
      const visible = matchesStop && current().stopControl === true;
      const locator: LocatorLike = { count: async () => (visible ? 1 : 0), isVisible: async () => true };
      return locator;
    },
    waitForTimeout: async () => {
      index++;
    }
  };
  return { page, polls: () => index };
}

describe("CompletionDetector", () => {
  it("treats a visible stop-generating control as a streaming signal and completes once it is gone", async () => {
    // The control carries no attribute and no page text: only its accessible name identifies it.
    const { page } = scriptedPage([
      { text: "partial", stopControl: true },
      { text: "partial answer", stopControl: true },
      { text: "answer" },
      { text: "answer" },
      { text: "answer" }
    ]);
    const detector = new CompletionDetector({
      stabilityWindowMs: 0,
      pollIntervalMs: 1,
      quietStreamingGraceMs: 60_000
    });

    const result = await detector.wait(page, { assistantCount: 1 }, 5_000);

    // The 60 s quiet grace is not applied: streaming really was observed.
    expect(result).toEqual({
      complete: true,
      reason: "stable",
      sawStreamingSignal: true,
      finalChars: 6
    });
  });

  it("waits out the quiet grace when no streaming signal is ever observed", async () => {
    const { page } = scriptedPage([{ text: "answer" }]);
    const detector = new CompletionDetector({
      stabilityWindowMs: 0,
      pollIntervalMs: 1,
      quietStreamingGraceMs: 120
    });

    const started = Date.now();
    const result = await detector.wait(page, { assistantCount: 1 }, 5_000);

    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect(result).toMatchObject({ complete: true, reason: "stable", sawStreamingSignal: false });
  });

  it("does not declare an unchanged response complete before the grace elapses", async () => {
    const { page } = scriptedPage([{ text: "answer" }]);
    const detector = new CompletionDetector({
      stabilityWindowMs: 0,
      pollIntervalMs: 1,
      quietStreamingGraceMs: 60_000
    });

    await expect(detector.wait(page, { assistantCount: 1 }, 60)).resolves.toMatchObject({
      complete: false,
      timedOut: true,
      reason: "timeout",
      sawStreamingSignal: false,
      partial: "answer",
      finalChars: 6
    });
  });

  it("reports a timeout with the observed metadata when a response keeps streaming", async () => {
    const { page } = scriptedPage([{ text: "still writing", streaming: true }]);
    const detector = new CompletionDetector({ stabilityWindowMs: 0, pollIntervalMs: 1 });

    await expect(detector.wait(page, { assistantCount: 1 }, 40)).resolves.toMatchObject({
      complete: false,
      timedOut: true,
      reason: "timeout",
      sawStreamingSignal: true,
      finalChars: 13
    });
  });

  it("reports cancellation without claiming completion", async () => {
    const controller = new AbortController();
    controller.abort();
    const { page } = scriptedPage([{ text: "answer" }]);
    const detector = new CompletionDetector({ stabilityWindowMs: 0, pollIntervalMs: 1 });

    await expect(detector.wait(page, { assistantCount: 1 }, 1_000, controller.signal)).resolves.toMatchObject(
      { complete: false, cancelled: true, reason: "cancelled" }
    );
  });

  it("never reports completion for an empty response node", async () => {
    const { page } = scriptedPage([{ text: "" }]);
    const detector = new CompletionDetector({
      stabilityWindowMs: 0,
      pollIntervalMs: 1,
      quietStreamingGraceMs: 0
    });

    await expect(detector.wait(page, { assistantCount: 1 }, 30)).resolves.toMatchObject({
      complete: false,
      timedOut: true,
      finalChars: 0
    });
  });
});
