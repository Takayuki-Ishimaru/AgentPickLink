import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentBuilderChatAdapter } from "../../src/transports/browser/adapters/index.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { AttachmentSaver } from "../../src/transports/browser/attachment-saver.js";
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
<button id="send" aria-label="Send">Send</button><button id="new" aria-label="New chat">New chat</button></main>
<script>
(() => {
  window.sent = [];
  window.ackDelay = 0;
  window.drop = false;
  window.ignore = false;
  const composer = document.querySelector('#composer');
  const log = document.querySelector('#log');
  let sequence = 0;
  let threadSequence = 0;
  document.querySelector('#new').addEventListener('click', () => {
    log.replaceChildren();
    log.dataset.conversationId = 'verified-new-thread-' + (++threadSequence);
  });
  const article = (role, html) => {
    const node = document.createElement('article');
    if (window.m365) {
      node.setAttribute('role', 'article');
      node.className = role === 'user' ? 'fai-UserMessage' : 'fai-CopilotMessage';
    } else node.setAttribute('data-message-author-role', role);
    if (window.stableIds) node.setAttribute('data-message-id', 'message-' + (++sequence));
    node.innerHTML = html;
    return node;
  };
  window.answer = (message) => {
    composer.value = '';
    const user = article('user', '');
    user.textContent = message;
    log.append(user);
    log.append(article('assistant', '<p>Use <strong>route B</strong> for this request.</p>'));
  };
  document.querySelector('#send').addEventListener('click', () => {
    const message = composer.value;
    window.sent.push(message);
    if (window.ignore) return;
    if (!window.keepDraft) composer.value = '';
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
    let currentAdapter: AgentBuilderChatAdapter;
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

    const makeAdapter = () =>
      new AgentBuilderChatAdapter({
        hostnames: ["m365.example.test"],
        stabilityWindowMs: 100,
        composerStabilityMs: 50,
        pollIntervalMs: 25,
        quietStreamingGraceMs: 50
      });
    const adapter = () => currentAdapter;
    const driver = (log?: (line: string) => void) =>
      new ConversationDriver(
        new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
        { save: async () => [] } as never,
        { ackTimeoutMs: 400, responseStartTimeoutMs: 1_000, attachmentSettleMs: 0, log }
      );
    async function open(
      options: {
        ackDelay?: number;
        drop?: boolean;
        ignore?: boolean;
        m365?: boolean;
        keepDraft?: boolean;
        stableIds?: boolean;
      } = {}
    ) {
      await page.goto("https://m365.example.test/chat/agent/agent-alpha");
      await page.evaluate((settings) => Object.assign(window, settings), {
        ackDelay: options.ackDelay ?? 0,
        drop: options.drop ?? false,
        ignore: options.ignore ?? false,
        keepDraft: options.keepDraft ?? false,
        m365: options.m365 ?? false,
        stableIds: options.stableIds ?? true
      });
      currentAdapter = makeAdapter();
      const target = page as unknown as PageLike;
      const before = await currentAdapter.captureConversationMarker(target);
      await currentAdapter.startNewConversation(target);
      await currentAdapter.verifyNewConversation(target, before);
      return page as unknown as PageLike;
    }
    const sent = () => page.evaluate(() => (window as unknown as { sent: string[] }).sent);

    it.each([false, true])(
      "refuses an unverified direct landing before typing (conversation ID: %s)",
      async (hasId) => {
        await page.goto(agent.entryPoint.url);
        if (!hasId)
          await page.locator("#log").evaluate((node) => node.removeAttribute("data-conversation-id"));
        currentAdapter = makeAdapter();
        const entered = enteredMessage(QUESTION);
        await expect(
          driver().invoke(page as unknown as PageLike, conversation, agent, adapter(), {
            message: QUESTION,
            entered
          })
        ).rejects.toMatchObject({
          code: "NEW_CONVERSATION_UNVERIFIED",
          details: { submissionState: "not-sent" }
        });
        expect(await sent()).toEqual([]);
        expect(await page.locator("#composer").inputValue()).toBe("");
        expect(entered.typed).not.toBe(true);
      }
    );

    it("retains the draft and reports unknown when the verified conversation ID disappears during typing", async () => {
      const target = await open();
      const fill = adapter().fillComposer.bind(adapter());
      vi.spyOn(adapter(), "fillComposer").mockImplementationOnce(async (...args) => {
        await fill(...args);
        await page.locator("#log").evaluate((node) => node.removeAttribute("data-conversation-id"));
      });
      await expect(
        driver().invoke(target, conversation, agent, adapter(), { message: QUESTION })
      ).rejects.toMatchObject({
        code: "SUBMIT_STATE_UNKNOWN",
        details: { submissionState: "unknown" }
      });
      expect(await sent()).toEqual([]);
      expect(await page.locator("#composer").inputValue()).toBe(QUESTION);
    });

    it("refuses a continuation with a recycled baseline tail before typing", async () => {
      const target = await open();
      await page.locator("#log").evaluate((node) => {
        node.innerHTML =
          '<article data-message-author-role="user" data-message-id="old-user">Earlier question</article><article data-message-author-role="assistant">Earlier answer</article>';
      });
      await expect(
        driver().invoke(target, conversation, agent, adapter(), { message: QUESTION })
      ).rejects.toMatchObject({
        code: "NEW_CONVERSATION_UNVERIFIED",
        details: { submissionState: "not-sent" }
      });
      expect(await sent()).toEqual([]);
      expect(await page.locator("#composer").inputValue()).toBe("");
    });

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

    it.each([
      [QUESTION, "shown", "complete"],
      ["A different question", "differs", "none"]
    ] as const)(
      "reads coherently when a message appears between the count and identity observations: %s",
      async (displayed, message, reply) => {
        const target = await open({ drop: true });
        const entered = enteredMessage(QUESTION);
        await expect(
          driver().invoke(target, conversation, agent, adapter(), {
            message: QUESTION,
            timeoutMs: 10_000,
            entered
          })
        ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
        const inspected = adapter() as unknown as {
          markerData: (target: PageLike) => Promise<{
            id?: string;
            userCount: number;
            assistantCount: number;
            unreadable?: true;
          }>;
        };
        const markerData = inspected.markerData.bind(inspected);
        const observation = vi.spyOn(inspected, "markerData").mockImplementationOnce(async (pageLike) => {
          const counts = await markerData(pageLike);
          expect(counts.userCount).toBe(0);
          // Publish after the real count sample, before the real identity sample.
          await page.evaluate(
            (text) => (window as unknown as { answer: (value: string) => void }).answer(text),
            displayed
          );
          return counts;
        });
        try {
          const reading = await driver().read(target, conversation, agent, adapter(), {
            entered,
            timeoutMs: 10_000
          });
          expect(reading).toMatchObject({ message, reply });
          if (reply === "complete") expect(reading.response?.text).toContain("route B");
          else expect(reading.response).toBeUndefined();
          expect(await sent()).toEqual([QUESTION]);
        } finally {
          observation.mockRestore();
        }
      },
      20_000
    );

    // A retained draft and absent user bubble do not prove that a press was not accepted.
    it("leaves submission unconfirmed even when the composer still holds the message, after waiting the acknowledgement time again", async () => {
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
      ).resolves.toEqual({ message: "unconfirmed", messageRequestId: "req_ask", reply: "none" });
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
      ).resolves.toEqual({ message: "unconfirmed", reply: "none" });
      // One more look to confirm it, not another acknowledgement window (400 ms here).
      expect(Date.now() - started).toBeLessThan(380);
    }, 20_000);

    it("reads a later reply without resending after both ACK windows expired with the draft retained", async () => {
      const target = await open({ ackDelay: 1_500, keepDraft: true });
      const entered = enteredMessage(QUESTION, "req_late");
      await expect(
        driver().invoke(target, conversation, agent, adapter(), {
          message: QUESTION,
          timeoutMs: 10_000,
          entered
        })
      ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
      await expect(
        driver().read(target, conversation, agent, adapter(), { entered, timeoutMs: 10_000 })
      ).resolves.toMatchObject({ message: "unconfirmed", reply: "none" });
      expect(await page.locator("#composer").inputValue()).toBe(QUESTION);
      await page.waitForFunction(
        () => document.querySelectorAll('[data-message-author-role="user"]').length === 1
      );
      await expect(
        driver().read(target, conversation, agent, adapter(), { entered, timeoutMs: 10_000 })
      ).resolves.toMatchObject({
        message: "shown",
        reply: "complete",
        response: { text: expect.stringContaining("route B") }
      });
      expect(await sent()).toEqual([QUESTION]);
    }, 20_000);

    it.each([1, 2])(
      "never returns a historical identical-question answer after %s users are prepended, then recovers the new answer",
      async (count) => {
        const target = await open({ ignore: true });
        await page.evaluate((question) => {
          (window as unknown as { answer(text: string): void }).answer(question);
          document.querySelector('[data-message-author-role="assistant"]')!.textContent =
            "HISTORICAL ANSWER - NOT THE CURRENT RESPONSE";
        }, QUESTION);
        await page.evaluate((amount) => {
          document.querySelector("#send")!.addEventListener("click", () =>
            setTimeout(() => {
              for (let index = 0; index < amount; index++) {
                const old = document.createElement("article");
                old.setAttribute("data-message-author-role", "user");
                old.textContent = "older history";
                document.querySelector("#log")!.prepend(old);
              }
            }, 15)
          );
        }, count);
        const logs: string[] = [];
        const instance = driver((line) => logs.push(line));
        const entered = enteredMessage(QUESTION, "req_history");
        await expect(
          instance.invoke(target, conversation, agent, adapter(), {
            message: QUESTION,
            entered,
            timeoutMs: 3_000
          })
        ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
        await expect(
          instance.read(target, conversation, agent, adapter(), { entered, timeoutMs: 3_000 })
        ).resolves.toEqual({ message: "unconfirmed", messageRequestId: "req_history", reply: "none" });
        expect(logs.join("\n")).toContain("no-unique-appended-user");
        expect(logs.join("\n")).not.toContain(QUESTION);
        expect(logs.join("\n")).not.toContain("HISTORICAL ANSWER");
        await page.evaluate(
          (question) => (window as unknown as { answer(text: string): void }).answer(question),
          QUESTION
        );
        await expect(
          instance.read(target, conversation, agent, adapter(), { entered, timeoutMs: 3_000 })
        ).resolves.toMatchObject({
          message: "shown",
          reply: "complete",
          response: { text: expect.stringContaining("route B") }
        });
        expect(await sent()).toEqual([QUESTION]);
      },
      10_000
    );

    it.each([false, true])(
      "handles a whole-turn redraw conservatively (stable message IDs=%s)",
      async (stableIds) => {
        const target = await open({ stableIds });
        const entered = enteredMessage(QUESTION);
        const invoking = driver().invoke(target, conversation, agent, adapter(), {
          message: QUESTION,
          entered,
          timeoutMs: 3_000,
          expectFiles: false
        });
        if (stableIds) await invoking;
        else await expect(invoking).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
        await page.evaluate(() => {
          const log = document.querySelector("#log")!;
          log.replaceChildren(...Array.from(log.children, (node) => node.cloneNode(true)));
        });
        const result = await driver().read(target, conversation, agent, adapter(), {
          entered,
          timeoutMs: 3_000
        });
        expect(result).toMatchObject(
          stableIds ? { message: "shown", reply: "complete" } : { message: "unconfirmed", reply: "none" }
        );
        expect(await sent()).toEqual([QUESTION]);
      },
      10_000
    );

    it("never adopts historical content rendered in the same recycled message elements", async () => {
      const target = await open();
      const entered = enteredMessage(QUESTION);
      await driver().invoke(target, conversation, agent, adapter(), {
        message: QUESTION,
        entered,
        timeoutMs: 3_000,
        expectFiles: false
      });
      const elementsBefore = await page.evaluate(() =>
        Array.from(document.querySelector("#log")!.children, (node) => node.getAttribute("data-message-id"))
      );
      await page.evaluate(() => {
        const user = document.querySelector('[data-message-author-role="user"]')!;
        const answer = document.querySelector('[data-message-author-role="assistant"]')!;
        user.setAttribute("data-message-id", "historical-user");
        answer.setAttribute("data-message-id", "historical-answer");
        answer.textContent = "HISTORICAL ANSWER";
      });
      expect(elementsBefore).toEqual(["message-1", "message-2"]);
      await expect(
        driver().read(target, conversation, agent, adapter(), { entered, timeoutMs: 3_000 })
      ).resolves.toEqual({ message: "unconfirmed", reply: "none" });
      expect(await sent()).toEqual([QUESTION]);
    }, 10_000);

    it("never confirms a temporarily empty history, even when historical messages have stable IDs", async () => {
      const target = await open({ ignore: true });
      // New adapter has no record of the explicit New chat ID transition performed by open().
      const unverified = makeAdapter();
      const entered = enteredMessage(QUESTION);
      const before = await unverified.captureConversationMarker(target);
      await expect(
        driver().invoke(target, conversation, agent, unverified, {
          message: QUESTION,
          entered,
          timeoutMs: 3_000,
          expectFiles: false
        })
      ).rejects.toMatchObject({
        code: "NEW_CONVERSATION_UNVERIFIED",
        details: { submissionState: "not-sent" }
      });
      expect(await sent()).toEqual([]);
      expect(entered.typed).not.toBe(true);
      // A read of a previously uncertain send must still reject lazy historical messages.
      Object.assign(entered, {
        typed: true,
        state: "unknown",
        userCountBefore: 0,
        turnBefore: before.turn,
        settledAt: Date.now() - 60_000
      });
      await page.evaluate((question) => {
        (window as unknown as { answer(text: string): void }).answer(question);
        document.querySelector('[data-message-author-role="assistant"]')!.textContent = "HISTORICAL ANSWER";
      }, QUESTION);
      await expect(
        driver().read(target, conversation, agent, unverified, { entered, timeoutMs: 3_000 })
      ).resolves.toEqual({ message: "unconfirmed", reply: "none" });
      expect(entered.turnBefore?.emptyVerified).toBeUndefined();
      expect(await sent()).toEqual([]);
    }, 10_000);

    it("does not reuse new-chat verification after an existing conversation briefly becomes empty", async () => {
      const target = await open();
      const first = enteredMessage(QUESTION);
      await driver().invoke(target, conversation, agent, adapter(), {
        message: QUESTION,
        entered: first,
        timeoutMs: 3_000,
        expectFiles: false
      });
      await page.evaluate(() => {
        document.querySelector("#log")!.replaceChildren();
        (window as unknown as { ignore: boolean }).ignore = true;
      });
      const before = await adapter().captureConversationMarker(target);
      expect(before.turn?.emptyVerified).toBeUndefined();
      await page.evaluate(
        (question) =>
          document.querySelector("#send")!.addEventListener("click", () =>
            setTimeout(() => {
              (window as unknown as { answer(text: string): void }).answer(question);
              document.querySelector('[data-message-author-role="assistant"]')!.textContent =
                "HISTORICAL ANSWER";
            }, 20)
          ),
        QUESTION
      );
      const second = enteredMessage(QUESTION);
      await expect(
        driver().invoke(target, conversation, agent, adapter(), {
          message: QUESTION,
          entered: second,
          timeoutMs: 3_000,
          expectFiles: false
        })
      ).rejects.toMatchObject({
        code: "NEW_CONVERSATION_UNVERIFIED",
        details: { submissionState: "not-sent" }
      });
      await expect(
        driver().read(target, conversation, agent, adapter(), { entered: second, timeoutMs: 3_000 })
      ).resolves.toEqual({ message: "not-shown", reply: "none" });
      expect(await sent()).toEqual([QUESTION]);
    }, 10_000);

    it("cannot adopt a response without a message ID when its DOM content is reused", async () => {
      const target = await open({ stableIds: false });
      const entered = enteredMessage(QUESTION);
      await expect(
        driver().invoke(target, conversation, agent, adapter(), {
          message: QUESTION,
          entered,
          timeoutMs: 3_000,
          expectFiles: false
        })
      ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
      await page.evaluate(() => {
        document.querySelector('[data-message-author-role="assistant"]')!.textContent = "HISTORICAL ANSWER";
      });
      await expect(
        driver().read(target, conversation, agent, adapter(), { entered, timeoutMs: 3_000 })
      ).resolves.toEqual({ message: "unconfirmed", reply: "none" });
      expect(await sent()).toEqual([QUESTION]);
    }, 10_000);

    it("recovers a confirmed user after earlier nodes virtualize away and DOM counts shrink", async () => {
      const target = await open();
      await page.evaluate(() =>
        (window as unknown as { answer(text: string): void }).answer("earlier question")
      );
      const entered = enteredMessage(QUESTION);
      await driver().invoke(target, conversation, agent, adapter(), {
        message: QUESTION,
        entered,
        timeoutMs: 3_000,
        expectFiles: false
      });
      await page.evaluate(() => {
        const log = document.querySelector("#log")!;
        log.children[0].remove();
        log.children[0].remove();
      });
      expect((await adapter().captureExchange(target)).userCount).toBe(1);
      await expect(
        driver().read(target, conversation, agent, adapter(), { entered, timeoutMs: 3_000 })
      ).resolves.toMatchObject({
        message: "shown",
        reply: "complete",
        response: { text: expect.stringContaining("route B") }
      });
      expect(await sent()).toEqual([QUESTION]);
    }, 10_000);

    it("discards a completed reply when another turn appears before extraction", async () => {
      const target = await open();
      const entered = enteredMessage(QUESTION);
      await driver().invoke(target, conversation, agent, adapter(), {
        message: QUESTION,
        entered,
        timeoutMs: 3_000,
        expectFiles: false
      });
      const changed = adapter();
      const wait = changed.waitForResponseComplete.bind(changed);
      changed.waitForResponseComplete = async (...args) => {
        const result = await wait(...args);
        await page.evaluate(() =>
          (window as unknown as { answer(text: string): void }).answer("a different question")
        );
        return result;
      };
      await expect(
        driver().read(target, conversation, agent, changed, { entered, timeoutMs: 3_000 })
      ).resolves.toEqual({ message: "unconfirmed", reply: "none" });
      expect(await sent()).toEqual([QUESTION]);
    }, 10_000);

    it("never lets scoped completion/extraction switch to an unrelated later answer", async () => {
      const target = await open();
      const chat = adapter();
      await chat.fillComposer(target, QUESTION);
      const marker = await chat.captureSubmissionMarker(target);
      await chat.submitComposer(target);
      await expect(chat.waitForUserMessageAck(target, marker, 1_000)).resolves.toEqual({ state: "sent" });
      const responseMarker = await chat.waitForResponseStart(target, marker, 1_000);
      await page.evaluate(() =>
        (window as unknown as { answer(text: string): void }).answer("an unrelated question")
      );
      await expect(chat.waitForResponseComplete(target, responseMarker, 200)).resolves.toMatchObject({
        complete: false,
        finalChars: 0
      });
      await expect(chat.extractLatestResponse(target, responseMarker)).rejects.toMatchObject({
        code: "RESPONSE_EXTRACTION_FAILED"
      });
    }, 10_000);

    it("does not activate another answer's file control or file card after its reply anchor is lost", async () => {
      const target = await open();
      const chat = adapter();
      await chat.fillComposer(target, QUESTION);
      const marker = await chat.captureSubmissionMarker(target);
      await chat.submitComposer(target);
      await chat.waitForUserMessageAck(target, marker, 1_000);
      const response = await chat.waitForResponseStart(target, marker, 1_000);
      expect(response.turn).toBeDefined();
      await page.evaluate(() => {
        (window as unknown as { answer(text: string): void }).answer("another question");
        const answer = document.querySelector("#log")!.lastElementChild!;
        answer.innerHTML =
          '<button aria-label="Download example.csv">Download example.csv</button><div role="group" aria-label="example.csv"><button aria-label="Preview example.csv">Preview example.csv</button></div>';
        (window as unknown as { wrongClicks: number }).wrongClicks = 0;
        answer.addEventListener("click", () => (window as unknown as { wrongClicks: number }).wrongClicks++);
      });
      const saver = new AttachmentSaver({
        enabled: true,
        directory: await mkdtemp(path.join(os.tmpdir(), "apl-anchor-files-")),
        allowedHosts: ["m365.example.test"],
        timeoutMs: 150,
        overallTimeoutMs: 500
      });
      const result = await saver.save(
        target,
        [
          { index: 0, name: "example.csv", downloadControlIndex: 0 },
          { index: 1, name: "example.csv", fileCardIndex: 1 }
        ],
        { workspaceKey: "test", requestId: "scope", replyAnchor: response.turn }
      );
      expect(result.every((item) => item.status === "not-saved")).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { wrongClicks: number }).wrongClicks)).toBe(0);
    }, 10_000);

    it("cancels an unconfirmed history read without resubmitting", async () => {
      const target = await open({ ignore: true });
      const entered = enteredMessage(QUESTION);
      await expect(
        driver().invoke(target, conversation, agent, adapter(), {
          message: QUESTION,
          entered,
          timeoutMs: 3_000
        })
      ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20);
      try {
        await expect(
          driver().read(target, conversation, agent, adapter(), {
            entered,
            signal: controller.signal,
            timeoutMs: 3_000
          })
        ).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });
      } finally {
        clearTimeout(timer);
      }
      expect(await sent()).toEqual([QUESTION]);
    }, 10_000);

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
