import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M365CopilotChatAdapter } from "../../src/transports/browser/adapters/index.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { ConversationDriver } from "../../src/transports/browser/conversation-driver.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import { activateSendControl, sendGateScript } from "../../src/transports/browser/send-activation.js";
import {
  COMPOSER_SELECTORS,
  MAIN_REGION_SELECTOR,
  NON_CONTEXT_REGION_SELECTOR,
  PAGE_CONTEXT_ATTRIBUTES
} from "../../src/transports/browser/selectors/common.js";
import type { BrowserAgentDefinition, LocatorLike, PageLike } from "../../src/transports/browser/types.js";
import type { SubmitGuard } from "../../src/transports/browser/ui-adapter.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].find((value): value is string => !!value && existsSync(value));

/** textarea and rich: the composer itself. shadow: a textarea in an open shadow root, which
 * Playwright's lookup reaches. decoy: a second textarea that Playwright counts as disabled through
 * its ancestor's aria-disabled, which a page-side query alone would count as usable. */
type Composer = "textarea" | "rich" | "shadow" | "decoy";
type Change = "composer" | "agent" | "conversation" | "address";
type Benign = "ghost" | "rerender" | "query" | "banner" | "sidebar";
const CHANGES: Change[] = ["composer", "agent", "conversation", "address"];
const ORIGINAL = "ORIGINAL: only this question";

/** A chat page whose send control records what a press sends: the composer text and the agent shown
 * at that moment. `respond` makes it answer like a chat UI; `enterSends` makes Enter send the way
 * chat composers do (`anyEnterSends`: Shift+Enter too). */
function fixture(composer: Composer): string {
  const field = {
    textarea: '<textarea aria-label="Message Requirements" rows="3" cols="60"></textarea>',
    rich: '<div contenteditable="true" role="textbox" aria-label="Message Requirements" style="white-space:pre-wrap;min-height:40px"></div>',
    shadow: '<div id="host"></div>',
    decoy:
      '<textarea aria-label="Message Requirements" rows="3" cols="60"></textarea><div aria-disabled="true"><textarea rows="1"></textarea></div>'
  }[composer];
  return `<aside><div data-conversation-id="recent-1">Recent chat</div></aside><main data-surface="m365-copilot"><h1 data-agent-name="Requirements" data-agent-id="agent-1">Requirements</h1><div role="log" data-conversation-id="conversation-1"></div>${field}<button id="send" aria-label="Send" style="position:fixed;left:40px;top:300px;width:80px;height:32px">Send</button><button id="other" style="position:fixed;left:200px;top:300px;width:80px;height:32px">Other</button></main>
<script>
(() => {
  const host = document.querySelector('#host');
  if (host) host.attachShadow({ mode: 'open' }).innerHTML = '<textarea aria-label="Message Requirements" rows="3" cols="60"></textarea>';
  window.sent = [];
  // The page's first look at every trusted press, ahead of any gate: also a press that a gate
  // swallows, and the blocked press of a trial click. [event, time, id of the button it landed on].
  window.presses = [];
  window.downs = 0;
  // A test's hook for the start of a press: it runs before any gate has judged the pointerdown.
  window.onPressStart = null;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    window.addEventListener(type, (event) => {
      if (!event.isTrusted) return;
      const button = event.target.closest && event.target.closest('button');
      window.presses.push([type, Date.now(), button ? button.id : '']);
      if (type === 'pointerdown' && window.onPressStart) window.onPressStart();
    }, true);
  window.others = 0;
  window.stops = 0;
  window.respond = false;
  window.mutateOnPress = false;
  window.enterSends = false;
  window.anyEnterSends = false;
  const composer = () => host ? host.shadowRoot.querySelector('textarea') : document.querySelector('main > textarea, main > [contenteditable]');
  // What the editor itself would send: text and line breaks, without decorations hidden from it.
  const plain = (node) => [...node.childNodes].map((child) => child.nodeType === 3 ? child.textContent : child.nodeName === 'BR' ? '\\n' : child.getAttribute('aria-hidden') === 'true' ? '' : plain(child)).join('');
  const text = () => { const c = composer(); return 'value' in c ? c.value : plain(c); };
  const clear = () => { const c = composer(); if ('value' in c) c.value = ''; else c.textContent = ''; };
  const userMessage = (message) => {
    const user = document.createElement('div');
    user.setAttribute('data-message-author-role', 'user');
    user.style.whiteSpace = 'pre-wrap';
    user.textContent = message;
    document.querySelector('[role=log]').append(user);
  };
  const send = (via) => {
    const message = text();
    window.sent.push({ text: message, agent: document.querySelector('h1').dataset.agentId, via });
    if (!window.respond) return;
    userMessage(message);
    clear();
    const answer = document.createElement('div');
    answer.setAttribute('data-message-author-role', 'assistant');
    answer.textContent = 'The answer.';
    document.querySelector('[role=log]').append(answer);
  };
  const button = document.querySelector('#send');
  // The application's own handler for the start of a press, which runs after the gate's.
  button.addEventListener('pointerdown', () => { if (window.mutateOnPress) composer().append(document.createElement('span')); });
  // Presses whose start reached the application, whether or not their click did.
  button.addEventListener('pointerdown', () => window.downs++);
  button.addEventListener('click', () => send('click'));
  document.querySelector('#other').addEventListener('click', () => window.others++);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(window.anyEnterSends || (window.enterSends && !event.shiftKey))) return;
    event.preventDefault();
    send('enter');
    clear();
  }, true);
  window.change = (kind) => {
    if (kind === 'composer') {
      const c = composer();
      if ('value' in c) c.value = 'CHANGED: another question'; else c.textContent = 'CHANGED: another question';
    } else if (kind === 'agent') {
      const heading = document.querySelector('h1');
      heading.textContent = 'Other agent';
      heading.dataset.agentId = 'agent-2';
      heading.dataset.agentName = 'Other agent';
      composer().setAttribute('aria-label', 'Message Other agent');
    } else if (kind === 'conversation') document.querySelector('[role=log]').dataset.conversationId = 'conversation-2';
    else if (kind === 'address') history.pushState({}, '', '/chat/elsewhere' + location.search);
  };
  // Changes a real page makes without changing the message or its recipient.
  window.benign = (kind) => {
    if (kind === 'ghost') {
      const ghost = document.createElement('span');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.textContent = ' suggested completion';
      composer().append(ghost);
    } else if (kind === 'rerender') composer().replaceWith(composer().cloneNode(true));
    else if (kind === 'query') history.replaceState({}, '', location.pathname + location.search + '&tracking=1');
    else if (kind === 'banner') document.querySelector('main').insertAdjacentHTML('afterbegin', '<h2>Service notice</h2>');
    else if (kind === 'sidebar') document.querySelector('aside [data-conversation-id]').dataset.conversationId = 'recent-2';
  };
  // Another way the message leaves: what an Enter key or a page shortcut would do. \`later\`: the
  // composer empties at once and the user message is shown only after that many milliseconds.
  window.sendByOtherMeans = (later) => {
    const message = text();
    window.sent.push({ text: message, agent: 'agent-1', via: 'other' });
    clear();
    if (later) setTimeout(() => userMessage(message), later); else userMessage(message);
  };
  // Over the send control only, so the composer stays usable.
  window.cover = (ms) => {
    const cover = document.createElement('div');
    cover.style = 'position:fixed;left:20px;top:280px;width:120px;height:80px;background:white;z-index:99';
    document.body.append(cover);
    setTimeout(() => cover.remove(), ms);
  };
  // The send control swapped for other nodes, the way a re-rendering UI does. equivalent: the same
  // control again, as a new node with its own handler (recorded as a press of the replacement);
  // twin: two of them; stop: a control that is not a send control, whose presses are only counted.
  window.replaceSend = (kind) => {
    const control = (label, left, onclick, id) => {
      const node = document.createElement('button');
      node.id = id;
      node.setAttribute('aria-label', label);
      node.textContent = label;
      node.style = 'position:fixed;top:300px;width:80px;height:32px;left:' + left + 'px';
      node.addEventListener('click', onclick);
      return node;
    };
    const again = (left, id) => control('Send', left, () => send('replacement'), id);
    const old = document.querySelector('#send');
    if (kind === 'equivalent') old.replaceWith(again(40, 'send'));
    else if (kind === 'twin') old.replaceWith(again(40, 'send'), again(300, 'send-twin'));
    else if (kind === 'stop') old.replaceWith(control('Stop generating', 40, () => window.stops++, 'send'));
  };
})();
</script>`;
}

const fingerprint = `sha256:${"a".repeat(64)}`;
const agent: BrowserAgentDefinition = {
  alias: "requirements",
  displayName: "Requirements",
  kind: "m365-agent-builder",
  transport: "browser",
  enabled: true,
  capabilityClass: "knowledge-only",
  uiActionPolicy: "never-click",
  entryPoint: { mode: "direct-chat", url: "https://m365.example.test/chat", surface: "m365-copilot" },
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
const conversation = {
  handle: "conv_fixture",
  agentAlias: agent.alias,
  bindingFingerprint: fingerprint,
  pageKey: "fixture",
  state: "open"
};

describe.skipIf(!executable)("the send press guard (v0.2.8 review)", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: executable, headless: true });
    page = await browser.newPage();
    await page.route(
      (url) => url.hostname === "m365.example.test",
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(new URL(route.request().url()).searchParams.get("composer") as Composer)
        })
    );
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  const adapter = (overrides: ConstructorParameters<typeof M365CopilotChatAdapter>[0] = {}) =>
    new M365CopilotChatAdapter({
      hostnames: ["m365.example.test"],
      stabilityWindowMs: 60,
      composerStabilityMs: 60,
      pollIntervalMs: 20,
      quietStreamingGraceMs: 40,
      ...overrides
    });
  const target = () => page as unknown as PageLike;
  async function open(composer: Composer, text = ORIGINAL): Promise<PageLike> {
    await page.goto(`https://m365.example.test/chat?composer=${composer}`);
    if (text) await (await adapter().findComposer(target())).fill!(text);
    return target();
  }
  const sent = () =>
    page.evaluate(
      () => (window as unknown as { sent: Array<{ text: string; agent: string; via: string }> }).sent
    );
  const call = (name: "change" | "benign" | "replaceSend", kind: string) =>
    page.evaluate(
      ([fn, value]) =>
        (window as unknown as Record<string, (kind: string) => void>)[fn as string]!(value as string),
      [name, kind] as const
    );
  const setFlag = (name: "respond" | "mutateOnPress" | "enterSends" | "anyEnterSends", value: boolean) =>
    page.evaluate(
      ([key, on]) => ((window as unknown as Record<string, boolean>)[key as string] = on as boolean),
      [name, value] as const
    );
  const openGates = () =>
    page.evaluate(
      () =>
        (window as unknown as Record<symbol, Map<string, unknown> | undefined>)[
          Symbol.for("agentpicklink.send-gate")
        ]?.size ?? 0
    );
  /** The guard the driver hands the adapter: the requested message and the marker captured when the
   * message was verified (with its page context), and the broker's own check. */
  async function guard(
    message = ORIGINAL,
    verify: () => Promise<void> = async () => undefined
  ): Promise<SubmitGuard> {
    const marker = await adapter().captureSubmissionMarker(target(), "verified");
    return { message, marker, verifyBeforePress: verify };
  }
  const expectedCode = (kind: Change) => (kind === "composer" ? "UI_CHANGED" : "AGENT_CONTEXT_CHANGED");
  const pressedOnce = async (text = ORIGINAL) => {
    expect(await sent()).toEqual([{ text, agent: "agent-1", via: "click" }]);
    expect(await openGates()).toBe(0);
  };

  describe("at the press itself (page-side gate)", () => {
    // The broker's own checks have passed; the page changes right after them, before the press. Only
    // the gate is left to notice.
    for (const composer of ["textarea", "rich"] as const)
      it.each(CHANGES)(
        `${composer} composer: a %s change after the last check swallows the press`,
        async (kind) => {
          await open(composer);
          await expect(
            adapter().submitComposer(
              target(),
              new AbortController().signal,
              await guard(ORIGINAL, () => call("change", kind))
            )
          ).rejects.toMatchObject({ code: expectedCode(kind), details: { submissionState: "not-sent" } });
          await page.waitForTimeout(200);
          expect(await sent()).toEqual([]);
          expect(await openGates()).toBe(0);
        }
      );

    // Independent review: the gate re-queried the composer itself and lost it in a shadow root, or
    // next to a decoy Playwright counts as disabled, and then let a changed composer be sent.
    it.each(["shadow", "decoy"] as const)(
      "%s composer: watches the very composer the adapter verified",
      async (composer) => {
        await open(composer);
        await expect(
          adapter().submitComposer(
            target(),
            new AbortController().signal,
            await guard(ORIGINAL, () => call("change", "composer"))
          )
        ).rejects.toMatchObject({ code: "UI_CHANGED", details: { submissionState: "not-sent" } });
        await page.waitForTimeout(200);
        expect(await sent()).toEqual([]);
      }
    );

    it.each(["textarea", "rich", "shadow", "decoy"] as const)(
      "%s composer: with nothing changed, presses exactly once with the verified text",
      async (composer) => {
        await open(composer);
        await adapter().submitComposer(target(), new AbortController().signal, await guard());
        await pressedOnce();
      }
    );

    // Independent review: watching every mutation and the whole document refused presses that a
    // real page's ordinary behaviour would cause.
    it.each(["ghost", "rerender", "query", "banner", "sidebar"] as const)(
      "does not refuse a press for a change that leaves the message and its recipient alone: %s",
      async (kind: Benign) => {
        await open("rich");
        await adapter().submitComposer(
          target(),
          new AbortController().signal,
          await guard(ORIGINAL, () => call("benign", kind))
        );
        await pressedOnce();
      }
    );

    it("judges a press as it starts: the page's own handlers changing the composer mid-press do not block it", async () => {
      await open("rich");
      await setFlag("mutateOnPress", true);
      await adapter().submitComposer(target(), new AbortController().signal, await guard());
      await pressedOnce();
    });

    it.each(["textarea", "rich"] as const)(
      "%s composer: refuses to arm, and checks and presses nothing, when the composer no longer holds the message",
      async (composer) => {
        await open(composer);
        let verified = false;
        await expect(
          adapter().submitComposer(
            target(),
            new AbortController().signal,
            await guard("the question that was verified", async () => {
              verified = true;
            })
          )
        ).rejects.toMatchObject({ code: "UI_CHANGED", details: { submissionState: "not-sent" } });
        expect(verified).toBe(false);
        expect(await sent()).toEqual([]);
        expect(await openGates()).toBe(0);
      }
    );

    it("refuses without pressing when the broker's check finds a change", async () => {
      await open("rich");
      const refusal = new Error("changed");
      await expect(
        adapter().submitComposer(
          target(),
          new AbortController().signal,
          await guard(ORIGINAL, async () => {
            throw refusal;
          })
        )
      ).rejects.toBe(refusal);
      await page.waitForTimeout(200);
      expect(await sent()).toEqual([]);
      expect(await openGates()).toBe(0);
    });

    it("keeps the cancellation gate: a cancellation during the check presses nothing", async () => {
      await open("rich");
      const controller = new AbortController();
      await expect(
        adapter().submitComposer(
          target(),
          controller.signal,
          await guard(ORIGINAL, async () => controller.abort())
        )
      ).rejects.toMatchObject({ code: "SUBMIT_FAILED", details: { submissionState: "not-sent" } });
      await page.waitForTimeout(200);
      expect(await sent()).toEqual([]);
      expect(await openGates()).toBe(0);
    });

    it("counts a check that throws as a change", async () => {
      await open("rich");
      const broken = () =>
        page.evaluate(() => {
          Element.prototype.closest = () => {
            throw new Error("patched by the page");
          };
        });
      await expect(
        adapter().submitComposer(target(), new AbortController().signal, await guard(ORIGINAL, broken))
      ).rejects.toMatchObject({ code: "UI_CHANGED", details: { submissionState: "not-sent" } });
      await page.waitForTimeout(200);
      expect(await sent()).toEqual([]);
    });

    it("removes a gate a lost activation left behind before arming its own", async () => {
      await open("textarea");
      // A closed gate whose finish never came: it would swallow every later press.
      const lost = {
        key: "lost",
        events: ["pointerdown", "mousedown", "pointerup", "mouseup", "click"],
        expiryMs: 30_000
      };
      await page.evaluate(sendGateScript, { ...lost, op: "install" as const });
      await page.evaluate(sendGateScript, { ...lost, op: "close" as const });
      await adapter().submitComposer(target(), new AbortController().signal, await guard());
      await pressedOnce();
    });

    // Independent review: an install answer that came too late left a gate behind, which closed on
    // the next change and swallowed every later click on the page for 30 s.
    it("presses nothing when the gate cannot be armed in time, and leaves no gate behind", async () => {
      await open("rich");
      const composer = await adapter().findComposer(target());
      const send = page.getByRole("button", { name: "Send" }) as unknown as LocatorLike;
      await expect(
        activateSendControl(target(), send, new AbortController().signal, {
          diagnostics: async () => ({}),
          gateArmTimeoutMs: 200,
          press: {
            // The renderer stalls just as the gate is being armed.
            composer: async () => {
              await page.evaluate(() =>
                setTimeout(() => {
                  const end = performance.now() + 800;
                  while (performance.now() < end);
                }, 0)
              );
              return composer;
            },
            verify: async () => undefined,
            check: {
              composerSelector: COMPOSER_SELECTORS.join(", "),
              contextAttributes: PAGE_CONTEXT_ATTRIBUTES,
              mainSelector: MAIN_REGION_SELECTOR,
              ignoredSelector: NON_CONTEXT_REGION_SELECTOR,
              message: ORIGINAL
            }
          }
        })
      ).rejects.toMatchObject({
        code: "UI_CHANGED",
        message: expect.stringContaining("could not be prepared"),
        details: { submissionState: "not-sent" }
      });
      await page.waitForTimeout(1_500);
      expect(await sent()).toEqual([]);
      expect(await openGates()).toBe(0);
      await call("change", "composer");
      await page.locator("#other").click();
      expect(await page.evaluate(() => (window as unknown as { others: number }).others)).toBe(1);
    });
  });

  describe("through the real conversation driver", () => {
    const driver = (ackTimeoutMs = 1_000) =>
      new ConversationDriver(
        new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
        undefined,
        {
          ackTimeoutMs,
          responseStartTimeoutMs: 1_000,
          attachmentSettleMs: 0
        }
      );
    /** The review's sequence: the send control is covered when submission starts; 200 ms later the
     * page changes, and at 650 ms the cover goes away. */
    async function invokeCovered(during: (() => Promise<unknown>) | undefined, message = ORIGINAL) {
      await open("rich", "");
      await setFlag("respond", true);
      const timers: ReturnType<typeof setTimeout>[] = [];
      try {
        return await driver().invoke(target(), conversation, agent, adapter(), {
          message,
          timeoutMs: 10_000,
          onProgress: (event) => {
            if (event.phase !== "submitting") return;
            void page.evaluate(() => (window as unknown as { cover(ms: number): void }).cover(650));
            if (during) timers.push(setTimeout(() => void during(), 200));
          }
        });
      } finally {
        await page.waitForTimeout(1_000);
        timers.forEach(clearTimeout);
      }
    }

    it("control: an unchanged page is sent once, after the cover goes away", async () => {
      const response = await invokeCovered(undefined);
      expect(response).toMatchObject({ submissionState: "sent", text: "The answer." });
      expect(await sent()).toEqual([{ text: ORIGINAL, agent: "agent-1", via: "click" }]);
    }, 20_000);

    it.each(CHANGES)(
      "a %s change while the send control is covered ends the request as not sent, with no press",
      async (kind) => {
        await expect(invokeCovered(() => call("change", kind))).rejects.toMatchObject({
          code: expectedCode(kind),
          details: { submissionState: "not-sent" }
        });
        expect(await sent()).toEqual([]);
        // Nothing is left for a later press either.
        expect(await page.locator("[contenteditable]").textContent()).toBe("");
      },
      20_000
    );

    // Independent review: the composer emptied because the message went out some other way was
    // reported not-sent, inviting a resend -- also when the page shows the user message only later.
    it.each([0, 1_500])(
      "a message sent some other way while the control is covered is unknown, never not-sent, and not pressed (shown after %i ms)",
      async (later) => {
        await expect(
          invokeCovered(() =>
            page.evaluate(
              (ms) => (window as unknown as { sendByOtherMeans(ms: number): void }).sendByOtherMeans(ms),
              later
            )
          )
        ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN", details: { submissionState: "unknown" } });
        expect(await sent()).toEqual([{ text: ORIGINAL, agent: "agent-1", via: "other" }]);
      },
      20_000
    );

    it("a press the page never acknowledges is unknown, even with the text still in the composer", async () => {
      await open("rich", "");
      await expect(
        driver().invoke(target(), conversation, agent, adapter(), { message: ORIGINAL, timeoutMs: 10_000 })
      ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN", details: { submissionState: "unknown" } });
      expect(await sent()).toHaveLength(1);
      expect(await page.locator("[contenteditable]").textContent()).toBe(ORIGINAL);
    }, 20_000);

    // Independent review: Playwright types "\n" as Enter, which a chat composer takes as "send".
    it("types a multi-line question into a composer that sends on Enter without sending any part early", async () => {
      await open("rich", "");
      await setFlag("respond", true);
      await setFlag("enterSends", true);
      const message = "first line\nsecond line\n\nlast line";
      await expect(
        driver().invoke(target(), conversation, agent, adapter(), { message, timeoutMs: 10_000 })
      ).resolves.toMatchObject({ submissionState: "sent" });
      expect(await sent()).toEqual([{ text: message, agent: "agent-1", via: "click" }]);
    }, 20_000);
  });

  it("stops typing at the first send, and reports unknown, when typing itself made the page send", async () => {
    await open("rich", "");
    await setFlag("respond", true);
    await setFlag("anyEnterSends", true);
    await expect(adapter().fillComposer(target(), "line 1\nline 2\nline 3\nline 4")).rejects.toMatchObject({
      code: "SUBMIT_STATE_UNKNOWN",
      details: { submissionState: "unknown" }
    });
    // Sent once by the page's own Shift+Enter handling; nothing more was typed, nor typed again.
    expect(await sent()).toEqual([{ text: "line 1", agent: "agent-1", via: "enter" }]);
  });

  // Review 2026-10-10 lists two acceptance conditions that the cases above leave out: "button
  // replacement" and "overlay removal coinciding with cancellation". The send control is a locator
  // found by its accessible name, so it is resolved again at every action: whatever stands there when
  // the wait ends is what is pressed, and the gate and the broker's checks have to hold for that press.
  describe("a replaced send control, and a cancellation as the cover goes away (review 2026-10-10)", () => {
    const driver = () =>
      new ConversationDriver(
        new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
        undefined,
        { ackTimeoutMs: 1_000, responseStartTimeoutMs: 1_000, attachmentSettleMs: 0 }
      );
    type Failure = { code?: string; message?: string; details?: { submissionState?: string } };
    type Sequence = {
      /** Runs 200 ms after submission starts, while the control is covered. */
      during?: () => Promise<unknown>;
      adapter?: Parameters<typeof adapter>[0];
      /** Cancels the request this long after submission started. */
      cancelAfterMs?: number;
      /** Cancels it this long after the broker's check before the press ended. The final cancellation
       * check and the real click follow at once, so from there a cancellation meets a click that is
       * already under way. */
      cancelAfterCheckMs?: number;
      /** Cancels it as the real press starts in the page, which then takes 60 ms to finish handling it. */
      cancelWhenPressStarts?: boolean;
      /** How long to watch for a late press once the request has ended. */
      settleMs?: number;
    };
    let whenPressStarts: (() => void) | undefined;
    beforeAll(async () => {
      await page.exposeFunction("pressStarted", () => whenPressStarts?.());
    });
    /** invokeCovered's sequence (the control is covered when submission starts, `during` runs 200 ms
     * later, the cover goes away at 650 ms), settled instead of thrown, with the moments that a race
     * needs. Everything is read after the settle time, so that a late press counts. */
    async function covered(sequence: Sequence = {}) {
      await open("rich", "");
      await setFlag("respond", true);
      const controller = new AbortController();
      const timers: ReturnType<typeof setTimeout>[] = [];
      const moments: { verified?: number; cancelled?: number } = {};
      const cancel = () => {
        if (moments.cancelled !== undefined) return;
        moments.cancelled = Date.now();
        controller.abort();
      };
      whenPressStarts = sequence.cancelWhenPressStarts ? cancel : undefined;
      // Notes the end of the broker's check: the final cancellation check and the click start there.
      const live = adapter(sequence.adapter);
      const submit = live.submitComposer.bind(live);
      live.submitComposer = (where, signal, guard) =>
        submit(
          where,
          signal,
          guard && {
            ...guard,
            verifyBeforePress: async () => {
              await guard.verifyBeforePress();
              moments.verified = Date.now();
              if (sequence.cancelAfterCheckMs !== undefined)
                timers.push(setTimeout(cancel, sequence.cancelAfterCheckMs));
              if (sequence.cancelWhenPressStarts)
                await page.evaluate(() => {
                  const hook = window as unknown as {
                    onPressStart: (() => void) | null;
                    pressStarted(): void;
                  };
                  hook.onPressStart = () => {
                    hook.onPressStart = null;
                    void hook.pressStarted();
                    for (const end = performance.now() + 60; performance.now() < end;);
                  };
                });
            }
          }
        );
      const settled: { response?: Awaited<ReturnType<ConversationDriver["invoke"]>>; error?: Failure } =
        await driver()
          .invoke(target(), conversation, agent, live, {
            message: ORIGINAL,
            timeoutMs: 10_000,
            signal: controller.signal,
            onProgress: (event) => {
              if (event.phase !== "submitting") return;
              void page.evaluate(() => (window as unknown as { cover(ms: number): void }).cover(650));
              if (sequence.during) timers.push(setTimeout(() => void sequence.during!(), 200));
              if (sequence.cancelAfterMs !== undefined)
                timers.push(setTimeout(cancel, sequence.cancelAfterMs));
            }
          })
          .then(
            (response) => ({ response }),
            (error: Failure) => ({ error })
          );
      await page.waitForTimeout(sequence.settleMs ?? 1_000);
      timers.forEach(clearTimeout);
      whenPressStarts = undefined;
      const seen = await page.evaluate(() => {
        const state = window as unknown as { presses: Array<[string, number, string]>; downs: number };
        return { presses: state.presses, downs: state.downs };
      });
      return { ...settled, ...moments, ...seen, recorded: await sent(), gates: await openGates() };
    }
    type Run = Awaited<ReturnType<typeof covered>>;
    const stateOf = (run: Run) =>
      run.response ? run.response.submissionState : run.error?.details?.submissionState;
    const composerText = () => page.locator("[contenteditable]").textContent();

    describe("the send control replaced while it is covered", () => {
      // A re-rendered send button is a new node with the same name. The press goes to the new node, and
      // nothing about the message or its recipient has changed: no false refusal, and no second press.
      it("a send control re-rendered while covered is pressed once, as the new node", async () => {
        const run = await covered({ during: () => call("replaceSend", "equivalent") });
        expect(run.response).toMatchObject({ submissionState: "sent", text: "The answer." });
        expect(run.recorded).toEqual([{ text: ORIGINAL, agent: "agent-1", via: "replacement" }]);
        expect(run.gates).toBe(0);
      }, 20_000);

      // The new button must not let a changed page through: the gate and the check judge the page,
      // not the control. Nothing reaches the replacement's handler.
      it.each(CHANGES)(
        "a %s change together with a re-rendered send control ends the request as not sent, with no press",
        async (kind) => {
          const run = await covered({
            during: () =>
              page.evaluate((change) => {
                const api = window as unknown as Record<string, (kind: string) => void>;
                api.replaceSend!("equivalent");
                api.change!(change);
              }, kind)
          });
          expect(run.error).toMatchObject({
            code: expectedCode(kind),
            details: { submissionState: "not-sent" }
          });
          expect(run.recorded).toEqual([]);
          expect(run.gates).toBe(0);
          // Nothing is left for a later press either.
          expect(await composerText()).toBe("");
        },
        20_000
      );

      // No send control is left to find, so the wait ends by its own budget (lowered here to stay fast,
      // but past the moment the cover goes away, so that a press on the stop control would show).
      it("a send control replaced by a control that is not a send control presses nothing", async () => {
        const run = await covered({
          during: () => call("replaceSend", "stop"),
          adapter: { sendClickableTimeoutMs: 1_200 }
        });
        expect(run.error).toMatchObject({
          code: "UI_CHANGED",
          message: expect.stringContaining("could not be confirmed clickable"),
          details: { submissionState: "not-sent" }
        });
        expect(run.recorded).toEqual([]);
        expect(await page.evaluate(() => (window as unknown as { stops: number }).stops)).toBe(0);
        expect(run.gates).toBe(0);
        expect(await composerText()).toBe("");
      }, 20_000);

      // Two controls of the same name leave no unique target: Playwright refuses to act on the
      // ambiguous locator, which the activation reports as a send control that changed, not sent.
      it("a send control replaced by two equivalent ones presses nothing", async () => {
        const run = await covered({ during: () => call("replaceSend", "twin") });
        expect(run.error).toMatchObject({
          code: "UI_CHANGED",
          message: expect.stringContaining("changed before it could be clicked"),
          details: { submissionState: "not-sent" }
        });
        expect(run.recorded).toEqual([]);
        expect(run.gates).toBe(0);
        expect(await composerText()).toBe("");
      }, 20_000);
    });

    // The cancellation meets the press. The cover goes away 650 ms into the submission, but the press
    // follows only after the wait's next attempt, the gate being armed, the broker's check and the
    // click's own checks (about 300 ms later here), and then arrives as a burst: pointerdown to click
    // within a millisecond or two. A cancellation within 40 ms of the cover's removal therefore always
    // comes first; the runs that meet the press are aimed at it, relative to the delay between the end
    // of the broker's check and the press as measured on this machine. Whatever the outcome, nothing may
    // be pressed after a cancellation that was seen before the click started, and a press that may have
    // reached the page is never "not sent".
    describe("a cancellation as the cover goes away", () => {
      /** Delays from the end of the broker's check to the press reaching the page (swallowed or not). */
      const lags: number[] = [];
      const endings: string[] = [];
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
      /** The page's first look at the real press: the first pointerdown on the send control after the
       * broker's check ended (the trial click's blocked press comes before it). */
      const pressAt = (run: Run) =>
        run.verified === undefined
          ? undefined
          : run.presses.find(
              ([type, at, id]) => type === "pointerdown" && id === "send" && at >= run.verified!
            )?.[1];
      const rel = (run: Run, moment: number | undefined) =>
        moment === undefined || run.verified === undefined
          ? "-"
          : `${moment >= run.verified ? "+" : ""}${moment - run.verified} ms`;
      /** The delay as measured by a run without a cancellation (and by every press seen since). */
      async function pressLag(): Promise<number> {
        if (!lags.length) await control();
        return median(lags);
      }
      async function control() {
        const run = await covered({ settleMs: 300 });
        expect(run.response).toMatchObject({ submissionState: "sent", text: "The answer." });
        expect(run.recorded).toEqual([{ text: ORIGINAL, agent: "agent-1", via: "click" }]);
        lags.push(pressAt(run)! - run.verified!);
        return run;
      }
      /** What must hold wherever the cancellation landed. The line noted for the run comes first, so
       * that a failing run shows how it went. */
      async function judged(run: Run, label: string, annotate: (message: string) => Promise<unknown>) {
        const state = stateOf(run);
        const at = pressAt(run);
        if (at !== undefined) lags.push(at - run.verified!);
        const ending = `${run.response ? "completed" : state}, ${run.recorded.length ? "press recorded" : at !== undefined ? "press swallowed" : "no press"}`;
        endings.push(ending);
        await annotate(
          `${label}: cancel ${rel(run, run.cancelled)}, press ${rel(run, at)} from the check: ${ending}`
        );

        expect(["not-sent", "unknown", "sent"]).toContain(state);
        // One press at most, and the right one; a sent message was pressed.
        expect(run.recorded.length).toBeLessThanOrEqual(1);
        if (run.recorded.length)
          expect(run.recorded).toEqual([{ text: ORIGINAL, agent: "agent-1", via: "click" }]);
        if (state === "sent") expect(run.recorded).toHaveLength(1);
        // Not sent means that no press reached the page, and a press that did is never not sent.
        if (state === "not-sent") expect(run.recorded).toEqual([]);
        if (run.recorded.length) expect(state).not.toBe("not-sent");
        // A cancellation seen before the click started ends the request, with no press at all.
        const beforeClick =
          run.cancelled !== undefined && (run.verified === undefined || run.cancelled < run.verified);
        if (beforeClick) {
          expect(state).toBe("not-sent");
          expect(run.recorded).toEqual([]);
        }
        // Nothing is left behind: the page takes presses again.
        expect(run.gates).toBe(0);
        await page.locator("#other").click();
        expect(await page.evaluate(() => (window as unknown as { others: number }).others)).toBe(1);
      }

      it("control: without a cancellation the request is sent once", async ({ annotate }) => {
        const run = await control();
        await annotate(`press ${rel(run, pressAt(run))} from the check`);
      }, 20_000);

      // The cancellation lands while the control is still covered, as the cover goes away: the wait
      // for the control ends at its next attempt, and the request with it.
      it.for([-40, 0, 40])(
        "cancelled %i ms from the cover's removal: not sent, with no press",
        async (offset, { annotate }) => {
          const run = await covered({ cancelAfterMs: 650 + offset, settleMs: 300 });
          await judged(run, `cover removal ${offset >= 0 ? "+" : ""}${offset} ms`, annotate);
          expect(stateOf(run)).toBe("not-sent");
          expect(run.recorded).toEqual([]);
        },
        20_000
      );

      // From 30 ms before the press to 30 ms after it, as far as the measured delay can tell: the
      // outcome flips from "swallowed, not sent" to "pressed, sent" somewhere in the middle, and
      // either is fine as long as the classification matches what reached the page.
      it.for([-30, -10, -6, -3, 0, 3, 6, 10, 30])(
        "cancelled %i ms from the press reaching the page: the classification matches what the page saw",
        async (offset, { annotate }) => {
          const lag = await pressLag();
          const run = await covered({ cancelAfterCheckMs: Math.max(0, lag + offset), settleMs: 300 });
          await judged(
            run,
            `press ${offset >= 0 ? "+" : ""}${offset} ms (lag ${Math.round(lag)} ms)`,
            annotate
          );
        },
        20_000
      );

      // The press has started in the page (its pointerdown is being handled) when the cancellation
      // arrives. Playwright sends the release at once, so the rest of the press is queued ahead of the
      // gate's closing and the click goes through; had the closing come first, the click would be
      // swallowed. Either way the message may be out: unknown, never not sent.
      it("cancelled as the press starts in the page: unknown, not not-sent", async ({ annotate }) => {
        const run = await covered({ cancelWhenPressStarts: true, settleMs: 300 });
        expect(run.error).toMatchObject({
          code: "SUBMIT_STATE_UNKNOWN",
          details: { submissionState: "unknown" }
        });
        expect(run.downs).toBe(1);
        await judged(run, "cancelled as the press starts", annotate);
      }, 20_000);

      it("summary: how the runs ended", async ({ annotate }) => {
        const tally = new Map<string, number>();
        for (const ending of endings) tally.set(ending, (tally.get(ending) ?? 0) + 1);
        await annotate(
          `${endings.length} runs: ${[...tally].map(([ending, count]) => `${count} x ${ending}`).join("; ") || "none"}`
        );
      });
    });
  });
});
