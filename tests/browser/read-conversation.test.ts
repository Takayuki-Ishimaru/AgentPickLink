import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentBuilderChatAdapter } from "../../src/transports/browser/adapters/index.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { ConversationDriver, enteredMessage } from "../../src/transports/browser/conversation-driver.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import type { BrowserAgentDefinition, PageLike } from "../../src/transports/browser/types.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].find((value): value is string => !!value && existsSync(value));

/** The review's chat page (2026-10-10): pressing Send records the request at once, while the
 * conversation shows the user's message and the answer only `window.ackDelay` ms later -- or never,
 * with `window.drop` (the page took the message: the composer is emptied). With `window.ignore` the
 * page does not take the message at all: the composer keeps it. `window.m365` renders Microsoft
 * 365's article markup instead. */
const PAGE = `<main data-agent-id="agent-alpha" data-agent-name="Review Agent" data-surface="m365-copilot">
<h1>Review Agent</h1><div role="log" data-conversation-id="review-thread" id="log"></div>
<textarea id="composer" aria-label="Message Review Agent" rows="4" cols="60"></textarea>
<button id="send" aria-label="Send">Send</button></main>
<script>
(() => {
  window.sent = [];
  window.ackDelay = 0;
  window.drop = false;
  window.ignore = false;
  const composer = document.querySelector('#composer');
  const log = document.querySelector('#log');
  const article = (role, html) => {
    const node = document.createElement('article');
    if (window.m365) {
      node.setAttribute('role', 'article');
      node.className = role === 'user' ? 'fai-UserMessage' : 'fai-CopilotMessage';
    } else node.setAttribute('data-message-author-role', role);
    node.innerHTML = html;
    return node;
  };
  window.answer = (message) => {
    const user = article('user', '');
    user.textContent = message;
    log.append(user);
    log.append(article('assistant', '<p>Use <strong>route B</strong> for this request.</p>'));
  };
  document.querySelector('#send').addEventListener('click', () => {
    const message = composer.value;
    window.sent.push(message);
    if (window.ignore) return;
    composer.value = '';
    if (window.drop) return;
    setTimeout(() => window.answer(message), window.ackDelay);
  });
})();
</script>`;

const agent: BrowserAgentDefinition = {
  alias: "review-agent",
  displayName: "Review Agent",
  kind: "m365-agent-builder",
  transport: "browser",
  enabled: true,
  capabilityClass: "knowledge-only",
  uiActionPolicy: "never-click",
  entryPoint: {
    mode: "direct-chat",
    url: "https://m365.example.test/chat/agent/agent-alpha",
    surface: "m365-copilot"
  },
  verification: {
    status: "verified",
    adapterId: "agent-builder-chat@1",
    expectedDisplayName: "Review Agent",
    expectedStableAgentId: "agent-alpha",
    expectedSurface: "m365-copilot",
    validatedUrlPattern: "^/chat/agent/agent-alpha/?$",
    bindingFingerprint: `sha256:${"b".repeat(64)}`,
    validatedAt: new Date().toISOString()
  }
};
const conversation = {
  handle: "conv_review",
  agentAlias: agent.alias,
  bindingFingerprint: agent.verification.bindingFingerprint,
  pageKey: "review",
  state: "ready"
};
const QUESTION = "日本語の質問\n条件 A  B\n😀 重要";

describe.skipIf(!executable)(
  "reading a conversation instead of sending again (v0.2.8 review 2026-10-10)",
  () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await chromium.launch({ executablePath: executable, headless: true });
      page = await browser.newPage();
      await page.route(
        (url) => url.hostname === "m365.example.test",
        (route) => route.fulfill({ contentType: "text/html", body: PAGE })
      );
    }, 30_000);
    afterAll(async () => {
      await browser?.close();
    }, 30_000);

    const adapter = () =>
      new AgentBuilderChatAdapter({
        hostnames: ["m365.example.test"],
        stabilityWindowMs: 100,
        composerStabilityMs: 50,
        pollIntervalMs: 25,
        quietStreamingGraceMs: 50
      });
    const driver = () =>
      new ConversationDriver(
        new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
        { save: async () => [] } as never,
        { ackTimeoutMs: 400, responseStartTimeoutMs: 1_000, attachmentSettleMs: 0 }
      );
    async function open(
      options: { ackDelay?: number; drop?: boolean; ignore?: boolean; m365?: boolean } = {}
    ) {
      await page.goto("https://m365.example.test/chat/agent/agent-alpha");
      await page.evaluate((settings) => Object.assign(window, settings), {
        ackDelay: options.ackDelay ?? 0,
        drop: options.drop ?? false,
        ignore: options.ignore ?? false,
        m365: options.m365 ?? false
      });
      return page as unknown as PageLike;
    }
    const sent = () => page.evaluate(() => (window as unknown as { sent: string[] }).sent);

    // The ask gives up after 400 ms; the page shows the message at 650 ms, inside the second window
    // the read gives it (another 400 ms, counted from the end of the ask).
    it("collects the answer of a message the page showed only after the acknowledgement time, without sending it again", async () => {
      const target = await open({ ackDelay: 650 });
      const entered = enteredMessage(QUESTION);
      await expect(
        driver().invoke(target, conversation, agent, adapter(), {
          message: QUESTION,
          timeoutMs: 10_000,
          entered
        })
      ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN", details: { submissionState: "unknown" } });
      expect(entered.state).toBe("unknown");
      const reading = await driver().read(target, conversation, agent, adapter(), {
        entered,
        timeoutMs: 10_000
      });
      expect(reading).toMatchObject({ message: "shown", reply: "complete" });
      expect(reading.response?.text).toContain("route B");
      // One press in all: reading sent nothing.
      expect(await sent()).toEqual([QUESTION]);
    }, 20_000);

    // Not shown means the message can be sent again, so it needs the page's own evidence: the
    // composer still holds the message, and no user message appeared.
    it("reports a message the page did not take as not shown, after waiting the acknowledgement time again", async () => {
      const target = await open({ ignore: true });
      const entered = enteredMessage(QUESTION, "req_ask");
      await expect(
        driver().invoke(target, conversation, agent, adapter(), {
          message: QUESTION,
          timeoutMs: 10_000,
          entered
        })
      ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
      const askEnded = entered.settledAt!;
      await expect(
        driver().read(target, conversation, agent, adapter(), { entered, timeoutMs: 10_000 })
      ).resolves.toEqual({ message: "not-shown", messageRequestId: "req_ask", reply: "none" });
      // Not before the second acknowledgement window, counted from the end of the ask, has passed.
      expect(Date.now() - askEnded).toBeGreaterThanOrEqual(380);
      expect(await sent()).toEqual([QUESTION]);
    }, 20_000);

    // The page emptied the composer -- it took the message -- but never showed it: nothing says it
    // was not sent, so it must not be offered for sending again.
    it("reports a message the page took but never showed as unconfirmed, not as not shown", async () => {
      const target = await open({ drop: true });
      const entered = enteredMessage(QUESTION);
      await expect(
        driver().invoke(target, conversation, agent, adapter(), {
          message: QUESTION,
          timeoutMs: 10_000,
          entered
        })
      ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
      await expect(
        driver().read(target, conversation, agent, adapter(), { entered, timeoutMs: 10_000 })
      ).resolves.toEqual({ message: "unconfirmed", reply: "none" });
      expect(await sent()).toEqual([QUESTION]);
    }, 20_000);

    it("does not wait again when the read comes long after the ask", async () => {
      const target = await open({ ignore: true });
      const entered = enteredMessage(QUESTION);
      await expect(
        driver().invoke(target, conversation, agent, adapter(), {
          message: QUESTION,
          timeoutMs: 10_000,
          entered
        })
      ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
      entered.settledAt = Date.now() - 60_000;
      const started = Date.now();
      await expect(
        driver().read(target, conversation, agent, adapter(), { entered, timeoutMs: 10_000 })
      ).resolves.toEqual({ message: "not-shown", reply: "none" });
      // One more look to confirm it, not another acknowledgement window (400 ms here).
      expect(Date.now() - started).toBeLessThan(380);
    }, 20_000);

    it("finds the reply that follows the latest user message in Microsoft 365's article markup", async () => {
      const target = await open({ m365: true });
      await page.evaluate(() => (window as unknown as { answer(text: string): void }).answer("first"));
      const exchange = await adapter().captureExchange(target);
      expect(exchange).toMatchObject({
        userCount: 1,
        assistantCount: 1,
        latestUserText: "first",
        replyStarted: true
      });
      // A newer user message without a reply yet: the older reply is not its reply.
      await page.evaluate(() => {
        const user = document.createElement("article");
        user.setAttribute("role", "article");
        user.className = "fai-UserMessage";
        user.textContent = "second";
        document.querySelector("#log")!.append(user);
      });
      expect(await adapter().captureExchange(target)).toMatchObject({
        userCount: 2,
        latestUserText: "second",
        replyStarted: false
      });
    }, 20_000);
  }
);
