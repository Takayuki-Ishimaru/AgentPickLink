import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBuilderChatAdapter } from "../../src/transports/browser/adapters/index.js";
import type { PageLike, SubmissionMarker } from "../../src/transports/browser/types.js";
import { turnFixture } from "../helpers/turn-fixtures.js";

describe("unknown response structure wait", () => {
  afterEach(() => vi.restoreAllMocks());
  function fixture(
    observe: (time: number) => { elements: number; chars: number } | undefined,
    replyAt = Infinity
  ) {
    let time = 0;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const adapter = new AgentBuilderChatAdapter();
    vi.spyOn(adapter, "captureExchange").mockImplementation(async () => ({
      userCount: 1,
      assistantCount: time >= replyAt ? 1 : 0,
      replyStarted: time >= replyAt,
      readable: true,
      turn: turnFixture(1, time >= replyAt)
    }));
    const page = {
      url: () => "https://m365.example.test/chat",
      evaluate: async () => observe(time),
      waitForTimeout: async (ms: number) => {
        time += ms;
      }
    } as unknown as PageLike;
    const marker: SubmissionMarker = {
      userCount: 0,
      assistantCount: 0,
      turn: turnFixture(0),
      userKey: "user-0",
      url: page.url(),
      identityDigest: "identity",
      composerValue: "question",
      capturedAt: 0
    };
    return { adapter, page, marker, time: () => time };
  }
  it("reports UI_CHANGED after 15 seconds of confirmed, unrecognized response content", async () => {
    const f = fixture(() => ({ elements: 2, chars: 120 }));
    await expect(f.adapter.waitForResponseStart(f.page, f.marker, 90000)).rejects.toMatchObject({
      code: "UI_CHANGED",
      details: {
        submissionState: "sent",
        completion: { reason: "unrecognized-response-dom", finalChars: 120 }
      }
    });
    expect(f.time()).toBe(15000);
  });
  it("keeps ordinary no-response timeouts and unreadable/progress-only samples unchanged", async () => {
    const f = fixture(() => undefined);
    await expect(f.adapter.waitForResponseStart(f.page, f.marker, 20000)).rejects.toMatchObject({
      code: "RESPONSE_TIMEOUT"
    });
    expect(f.time()).toBe(20000);
  });
  it("resets the suspicion when content disappears and accepts a recognized reply", async () => {
    const f = fixture((time) => ({ elements: time === 14000 ? 0 : 1, chars: 120 }), 20000);
    await expect(f.adapter.waitForResponseStart(f.page, f.marker, 30000)).resolves.toMatchObject({
      turn: { responseKey: "assistant-0" }
    });
    expect(f.time()).toBe(20000);
  });
  it("does not diagnose a response belonging to an unconfirmed question", async () => {
    const f = fixture(() => ({ elements: 1, chars: 120 }));
    f.marker.userKey = "different-user";
    await expect(f.adapter.waitForResponseStart(f.page, f.marker, 20000)).rejects.toMatchObject({
      code: "RESPONSE_TIMEOUT"
    });
  });
});
