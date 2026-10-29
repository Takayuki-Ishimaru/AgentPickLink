import { afterEach, expect, it, vi } from "vitest";
import { CompletionDetector } from "../../src/transports/browser/completion-detector.js";
import type { PageLike } from "../../src/transports/browser/types.js";

afterEach(() => vi.useRealTimers());

it("does not certify a cache digest from just one readable poll after unknown streaming probes", async () => {
  vi.useFakeTimers();
  let polls = 0;
  const page = {
    getByRole: () => ({
      count: async () => {
        if (++polls <= 3) throw Error("unreadable");
        return 0;
      }
    }),
    evaluate: async () => ({ text: "answer", streaming: false }),
    waitForTimeout: (ms: number) => vi.advanceTimersByTimeAsync(ms)
  } as unknown as PageLike;
  const detector = new CompletionDetector({
    stabilityWindowMs: 30,
    pollIntervalMs: 10,
    quietStreamingGraceMs: 0
  });
  const result = await detector.wait(page, { assistantCount: 1 }, 100);
  expect(result.complete).toBe(true);
  expect(result.responseDigest).toBeUndefined();
  const confirmed = await detector.wait(page, { assistantCount: 1 }, 100);
  expect(confirmed.responseDigest).toMatch(/^[a-f0-9]{64}$/);
});
