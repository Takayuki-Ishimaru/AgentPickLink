import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
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

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome"
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

// Execute the production page.evaluate callback in a real DOM. Only the polling clock is virtual.
describe.skipIf(!executable)("completion DOM regressions", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: executable, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.each([
    { response: "通常の完成済み回答", history: "", control: "", streaming: false },
    { response: "「生成を停止」ボタンを押してください。", history: "", control: "", streaming: false },
    { response: "Click Stop generating to stop.", history: "", control: "", streaming: false },
    { response: "answer", history: "生成を停止 / Stop generating", control: "", streaming: false },
    { response: "answer", history: "", control: "<button hidden>Stop generating</button>", streaming: false },
    {
      response: "answer",
      history: "",
      control: '<button style="display:none">生成を停止</button><button aria-label="生成を停止"></button>',
      streaming: true
    },
    {
      response: "answer",
      history: "",
      control: '<button aria-label="Stop generating"></button>',
      streaming: true
    }
  ])("ignores prose and detects visible controls: %j", async ({ response, history, control, streaming }) => {
    const page = await browser.newPage();
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await page.setContent(`<main><div data-message-author-role="user">${history}</div>
        <div data-message-author-role="assistant">${response}</div>${control}</main>`);
      const port: PageLike = {
        url: () => page.url(),
        evaluate: page.evaluate.bind(page),
        getByRole: page.getByRole.bind(page) as PageLike["getByRole"],
        waitForTimeout: async (ms) => {
          now += ms;
        }
      };
      const result = await new CompletionDetector().wait(port, { assistantCount: 1 }, 6_000);
      expect(result.complete).toBe(!streaming);
      expect(result.sawStreamingSignal).toBe(streaming);
      if (!streaming) expect(now).toBeLessThanOrEqual(6_000);
    } finally {
      clock.mockRestore();
      await page.close();
    }
  });

  it.each(["aria-busy", "data-streaming"])("observes %s on the current response only", async (attribute) => {
    const page = await browser.newPage();
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await page.setContent(`<div data-message-author-role="assistant" ${attribute}="true">old</div>
        <div id="current" data-message-author-role="assistant" ${attribute}="true">answer</div>`);
      const port: PageLike = {
        url: () => page.url(),
        evaluate: page.evaluate.bind(page),
        getByRole: page.getByRole.bind(page) as PageLike["getByRole"],
        waitForTimeout: async (ms) => {
          now += ms;
          if (now >= 2_000)
            await page.locator("#current").evaluate((node, attr) => node.removeAttribute(attr), attribute);
        }
      };
      expect(await new CompletionDetector().wait(port, { assistantCount: 2 }, 6_000)).toMatchObject({
        complete: true,
        sawStreamingSignal: true
      });
    } finally {
      clock.mockRestore();
      await page.close();
    }
  });
});
