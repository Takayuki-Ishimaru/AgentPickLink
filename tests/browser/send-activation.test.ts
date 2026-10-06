import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { M365CopilotChatAdapter } from "../../src/transports/browser/adapters/index.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { ConversationDriver } from "../../src/transports/browser/conversation-driver.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import { sendGateScript } from "../../src/transports/browser/send-activation.js";
import type { BrowserAgentDefinition, LocatorLike, PageLike } from "../../src/transports/browser/types.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].find((value): value is string => !!value && existsSync(value));

/** When the obstacle in front of the send control goes away (ms after it was set up). */
const CLEARS_AT_MS = 700;
/** When the tests cancel (ms after the send started). */
const CANCEL_AT_MS = 100;
const OBSTACLES = ["cover", "animation", "relocation", "disabled-again"] as const;
type Obstacle = (typeof OBSTACLES)[number];

// v0.2.7 review P1: with the send control covered, a cancellation during the click's actionability
// wait still produced a click once the cover went away (3/3, 755-783 ms after the cancel). Each case
// below checks that nothing is pressed even well after the obstacle has cleared.
describe.skipIf(!executable)("send control activation and cancellation", () => {
  let browser: Browser;
  let page: Page;
  const adapter = (sendClickableTimeoutMs?: number) =>
    new M365CopilotChatAdapter({
      hostnames: ["m365.example.test"],
      stabilityWindowMs: 5,
      sendClickableTimeoutMs
    });
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: executable, headless: true });
    page = await browser.newPage();
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  }, 30_000);
  beforeEach(async () => {
    await page.route("https://m365.example.test/chat", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<main data-surface="m365-copilot"><h1 data-agent-name="Requirements" data-agent-id="agent-1">Requirements</h1><div role="log"></div><div contenteditable="true" role="textbox"></div><button id="send" aria-label="Send" style="position:fixed;left:40px;top:300px;width:80px;height:32px">Send</button></main>
<script>
window.clicks = [];
const record = () => window.clicks.push(performance.now());
document.querySelector('#send').onclick = record;
window.obstruct = (mode, clearsAt) => {
  const send = () => document.querySelector('#send');
  const started = performance.now();
  if (mode === 'cover') {
    // Over the send control only, so the composer stays usable.
    const cover = document.createElement('div');
    cover.style = 'position:fixed;left:20px;top:280px;width:200px;height:80px;background:white;z-index:99';
    document.body.append(cover);
    setTimeout(() => cover.remove(), clearsAt);
  } else if (mode === 'animation') {
    const style = document.createElement('style');
    style.textContent = '@keyframes drift { from { transform: translateX(0) } to { transform: translateX(60px) } } #send { animation: drift 120ms linear infinite alternate }';
    document.head.append(style);
    setTimeout(() => style.remove(), clearsAt);
  } else if (mode === 'relocation') {
    // Re-rendered as a new node at another position on every frame, like a re-laid-out toolbar.
    let index = 0;
    const step = () => {
      const fresh = send().cloneNode(true);
      fresh.onclick = record;
      fresh.style.left = (40 + (index++ % 2) * 50) + 'px';
      send().replaceWith(fresh);
      if (performance.now() - started < clearsAt) requestAnimationFrame(step);
      else fresh.style.left = '40px';
    };
    requestAnimationFrame(step);
  } else if (mode === 'disabled-again') {
    send().disabled = true;
    setTimeout(() => { send().disabled = false; }, clearsAt);
  }
};
// Keeps the main thread busy for busyMs of every periodMs, so animation frames come rarely, like
// the hidden Windows browser's (docs/windows-description-verification-2026-09-08.md: five frames
// in 1.2 s).
window.busy = (busyMs, periodMs) => {
  const spin = () => { const end = performance.now() + busyMs; while (performance.now() < end); };
  setTimeout(spin, 0);
  window.busyTimer = setInterval(spin, periodMs);
};
</script>`
      })
    );
    await page.goto("https://m365.example.test/chat");
    await page.locator("[contenteditable]").fill("must-not-send-after-cancel");
  });
  const clicks = () => page.evaluate(() => (window as unknown as { clicks: number[] }).clicks);
  const obstruct = (mode: Obstacle, clearsAt = CLEARS_AT_MS) =>
    page.evaluate(
      ([value, at]) =>
        (window as unknown as { obstruct(m: string, a: number): void }).obstruct(
          value as string,
          at as number
        ),
      [mode, clearsAt] as const
    );
  /** The page's own clock, which the recorded clicks use. */
  const pageNow = () => page.evaluate(() => performance.now());
  const openGates = () =>
    page.evaluate(
      () =>
        (window as unknown as Record<symbol, Map<string, unknown> | undefined>)[
          Symbol.for("agentpicklink.send-gate")
        ]?.size ?? 0
    );

  /** The real page; the send control's click runs the hooks first. A "disabled-again" obstacle is
   * applied by the first trial, so the control is enabled when found and disabled while it waits. */
  function hooked(hooks: {
    trial?: () => Promise<void>;
    real?: () => void;
    afterReal?: () => void;
  }): PageLike {
    let trialHooked = false;
    const wrap = (locator: LocatorLike): LocatorLike =>
      new Proxy(locator, {
        get(target, key) {
          if (key === "click")
            return async (options?: { timeout?: number; trial?: boolean }) => {
              if (options?.trial && !trialHooked) {
                trialHooked = true;
                await hooks.trial?.();
              }
              if (!options?.trial) hooks.real?.();
              await target.click!(options);
              if (!options?.trial) hooks.afterReal?.();
            };
          if (key === "nth") return (index: number) => wrap(target.nth!(index));
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    return new Proxy(page as unknown as PageLike, {
      get(target, key) {
        if (key === "getByRole")
          return (role: string, options?: { name?: string | RegExp }) =>
            wrap(target.getByRole!(role, options));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }
  /** Sets the obstacle up; returns the page time it was set up at. */
  async function obstructed(
    mode: Obstacle,
    clearsAt = CLEARS_AT_MS
  ): Promise<{ page: PageLike; at: () => number }> {
    let at = Number.NaN;
    const setUp = async () => {
      at = await pageNow();
      await obstruct(mode, clearsAt);
    };
    if (mode === "disabled-again") return { page: hooked({ trial: setUp }), at: () => at };
    await setUp();
    return { page: page as unknown as PageLike, at: () => at };
  }

  it.each(OBSTACLES)(
    "cancelling while the send control is unclickable (%s) never presses it, even after it clears",
    async (mode) => {
      const { page: target, at } = await obstructed(mode);
      const controller = new AbortController();
      let cancelledAt = 0;
      const timer = setTimeout(() => {
        cancelledAt = Date.now();
        controller.abort();
      }, CANCEL_AT_MS);
      try {
        await expect(adapter().submitComposer(target, controller.signal)).rejects.toMatchObject({
          code: "SUBMIT_FAILED",
          details: { submissionState: "not-sent" }
        });
      } finally {
        clearTimeout(timer);
      }
      // Observed when the current trial ends: the first slice is 1 s, doubling to at most 2 s.
      expect(Date.now() - cancelledAt).toBeLessThan(2_500);
      // Well past the moment the obstacle cleared: a pending click would have fired by now.
      await page.waitForTimeout(Math.max(0, at() + CLEARS_AT_MS + 500 - (await pageNow())));
      expect(await clicks()).toEqual([]);
      expect(await openGates()).toBe(0);
    }
  );

  it.each(OBSTACLES)(
    "without a cancellation, waits for an unclickable control (%s) and presses it once, after it clears",
    async (mode) => {
      const { page: target, at } = await obstructed(mode, 400);
      await adapter().submitComposer(target, new AbortController().signal);
      await page.waitForTimeout(300);
      const pressed = await clicks();
      expect(pressed).toHaveLength(1);
      expect(pressed[0]! - at()).toBeGreaterThanOrEqual(390);
    }
  );

  // Independent review: with a fixed 200 ms trial, one stability check (two animation frames) never
  // fit on a page rendering a few frames per second, so a clickable control failed after the budget.
  describe("on a page that renders only a few frames per second", () => {
    const busy = async () => {
      await page.evaluate(() => (window as unknown as { busy(b: number, p: number): void }).busy(235, 240));
      // Let the pattern settle before the send starts.
      await page.waitForTimeout(600);
    };
    const idle = () =>
      page.evaluate(() =>
        clearInterval((window as unknown as { busyTimer: ReturnType<typeof setInterval> }).busyTimer)
      );

    it("still presses a clickable control exactly once", async () => {
      await busy();
      try {
        await adapter().submitComposer(page as unknown as PageLike, new AbortController().signal);
      } finally {
        await idle();
      }
      await page.waitForTimeout(300);
      expect(await clicks()).toHaveLength(1);
    }, 20_000);

    it("still never presses after a cancellation while the control is covered", async () => {
      const { at } = await obstructed("cover");
      await busy();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CANCEL_AT_MS);
      try {
        await expect(
          adapter().submitComposer(page as unknown as PageLike, controller.signal)
        ).rejects.toMatchObject({
          code: "SUBMIT_FAILED",
          details: { submissionState: "not-sent" }
        });
      } finally {
        clearTimeout(timer);
        await idle();
      }
      await page.waitForTimeout(Math.max(0, at() + CLEARS_AT_MS + 500 - (await pageNow())));
      expect(await clicks()).toEqual([]);
    }, 20_000);
  });

  it("fails as not sent, with no later press, when the control stays unclickable past its budget", async () => {
    const { at } = await obstructed("cover", 1_200);
    await expect(adapter(500).submitComposer(page as unknown as PageLike)).rejects.toMatchObject({
      code: "UI_CHANGED",
      message: expect.stringContaining("could not be confirmed clickable"),
      details: { submissionState: "not-sent" }
    });
    await page.waitForTimeout(Math.max(0, at() + 1_700 - (await pageNow())));
    expect(await clicks()).toEqual([]);
  });

  it("swallows the press when the cancellation lands while the real click is already under way", async () => {
    const controller = new AbortController();
    await expect(
      adapter().submitComposer(hooked({ real: () => controller.abort() }), controller.signal)
    ).rejects.toMatchObject({ code: "SUBMIT_FAILED", details: { submissionState: "not-sent" } });
    await page.waitForTimeout(300);
    expect(await clicks()).toEqual([]);
    expect(await openGates()).toBe(0);
    // Nothing is left behind: the next activation on the same page presses normally.
    await adapter().submitComposer(page as unknown as PageLike, new AbortController().signal);
    expect(await clicks()).toHaveLength(1);
  });

  it("treats a press that reached the page before the cancellation as activated, never as not sent", async () => {
    const controller = new AbortController();
    await adapter().submitComposer(hooked({ afterReal: () => controller.abort() }), controller.signal);
    expect(await clicks()).toHaveLength(1);
    expect(await openGates()).toBe(0);
  });

  it("gate: counts trusted presses while open, swallows them once closed, ignores script clicks", async () => {
    const gate = (key: string, op: "install" | "close" | "finish") =>
      page.evaluate(sendGateScript, {
        key,
        op,
        events: ["pointerdown", "mousedown", "pointerup", "mouseup", "click"],
        expiryMs: 30_000
      });
    expect(await gate("open", "install")).toBe(true);
    await page.locator("#send").click();
    await page.locator("#send").evaluate((element) => (element as HTMLButtonElement).click());
    // pointerdown, mousedown, pointerup, mouseup and click of the trusted click; not the script's.
    expect(await gate("open", "finish")).toEqual({ passed: 5, blocked: 0 });
    expect(await clicks()).toHaveLength(2);

    expect(await gate("closed", "install")).toBe(true);
    expect(await gate("closed", "close")).toBe(true);
    await page.locator("#send").click();
    // A cancelled pointerdown also suppresses the compatibility mousedown/mouseup (Pointer Events),
    // so fewer presses arrive; none of them reaches the page.
    const swallowed = (await gate("closed", "finish")) as { passed: number; blocked: number };
    expect(swallowed.passed).toBe(0);
    expect(swallowed.blocked).toBeGreaterThanOrEqual(3);
    expect(await clicks()).toHaveLength(2);
    expect(await openGates()).toBe(0);
    expect(await gate("closed", "finish")).toBe(false);
  });

  it("propagates a cancellation during a covered send through the real driver: not sent, draft cleared", async () => {
    await page.locator("[contenteditable]").fill("");
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const agent: BrowserAgentDefinition = {
      alias: "requirements",
      displayName: "Requirements",
      kind: "m365-agent-builder",
      transport: "browser",
      enabled: true,
      capabilityClass: "knowledge-only",
      uiActionPolicy: "never-click",
      entryPoint: { mode: "direct-chat", url: page.url(), surface: "m365-copilot" },
      verification: {
        status: "verified",
        adapterId: "m365-copilot-chat@1",
        expectedDisplayName: "Requirements",
        expectedStableAgentId: "agent-1",
        expectedSurface: "m365-copilot",
        validatedUrlPattern: "^/chat$",
        bindingFingerprint: fingerprint,
        validatedAt: new Date().toISOString()
      }
    };
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] }))
    );
    // The cover sits over the send control only, for longer than entering the message takes.
    const { at } = await obstructed("cover", 2_500);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        driver.invoke(
          page as unknown as PageLike,
          {
            handle: "conv_fixture",
            agentAlias: agent.alias,
            bindingFingerprint: fingerprint,
            pageKey: "fixture",
            state: "open"
          },
          agent,
          adapter(),
          {
            message: "cancelled question",
            signal: controller.signal,
            onProgress: (event) => {
              if (event.phase === "submitting") timer = setTimeout(() => controller.abort(), CANCEL_AT_MS);
            }
          }
        )
      ).rejects.toMatchObject({ code: "SUBMIT_FAILED", details: { submissionState: "not-sent" } });
    } finally {
      clearTimeout(timer);
    }
    expect(await page.locator("[contenteditable]").textContent()).toBe("");
    await page.waitForTimeout(Math.max(0, at() + 2_500 + 500 - (await pageNow())));
    expect(await clicks()).toEqual([]);
  }, 15_000);
});
