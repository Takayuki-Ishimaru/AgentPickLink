import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentBuilderChatAdapter } from "../../src/transports/browser/adapters/index.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { ConversationDriver, enteredMessage } from "../../src/transports/browser/conversation-driver.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import type { BrowserAgentDefinition, PageLike } from "../../src/transports/browser/types.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].find((value): value is string => !!value && existsSync(value));
const html = `<main data-agent-id="agent-alpha" data-agent-name="Review Agent" data-surface="m365-copilot">
<h1>Review Agent</h1><div role="log" data-conversation-id="initial" id="log"></div>
<textarea id="composer" aria-label="Message Review Agent"></textarea>
<button id="send" aria-label="Send">Send</button><button id="new" aria-label="New chat">New chat</button></main>
<script>
const log = document.querySelector('#log');
document.querySelector('#new').onclick = () => { log.replaceChildren(); log.dataset.conversationId = 'new-thread'; };
document.querySelector('#send').onclick = () => {
  const composer = document.querySelector('#composer');
  const user = document.createElement('article');
  user.dataset.messageAuthorRole = 'user'; user.dataset.messageId = 'user-1'; user.textContent = composer.value;
  const answer = document.createElement('article');
  answer.dataset.messageAuthorRole = 'assistant'; answer.dataset.messageId = 'answer-1'; answer.textContent = 'Complete answer';
  composer.value = ''; log.append(user, answer);
};
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

describe.skipIf(!executable)("completed reply snapshot", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: executable, headless: true });
    page = await browser.newPage();
    await page.route(
      (url) => url.hostname === "m365.example.test",
      (route) => route.fulfill({ contentType: "text/html", body: html })
    );
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  async function completed(afterCompletion?: () => Promise<void>) {
    await page.goto(agent.entryPoint.url);
    const target = page as unknown as PageLike;
    const adapter = new AgentBuilderChatAdapter({
      hostnames: ["m365.example.test"],
      stabilityWindowMs: 100,
      composerStabilityMs: 50,
      pollIntervalMs: 25,
      quietStreamingGraceMs: 50
    });
    if (afterCompletion) {
      const wait = adapter.waitForResponseComplete.bind(adapter);
      vi.spyOn(adapter, "waitForResponseComplete").mockImplementation(async (...args) => {
        const result = await wait(...args);
        await afterCompletion();
        return result;
      });
    }
    const saver = { save: vi.fn(async () => []) };
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      saver as never,
      { ackTimeoutMs: 400, responseStartTimeoutMs: 1_000, attachmentSettleMs: 0 }
    );
    const before = await adapter.captureConversationMarker(target);
    await adapter.startNewConversation(target);
    await adapter.verifyNewConversation(target, before);
    const entered = enteredMessage("Question", "request-1");
    const answer = await driver.invoke(target, conversation, agent, adapter, {
      message: "Question",
      entered,
      timeoutMs: 3_000,
      expectFiles: false
    });
    return { target, adapter, driver, entered, answer, saver };
  }
  it("returns the confirmed answer on an immediate read", async () => {
    const f = await completed();
    const wait = vi.spyOn(f.adapter, "waitForResponseComplete");
    f.saver.save.mockClear();
    const result = await f.driver.read(f.target, conversation, agent, f.adapter, {
      entered: f.entered,
      waitMs: 0
    });
    expect(result).toMatchObject({
      message: "shown",
      messageRequestId: "request-1",
      reply: "complete",
      response: { text: f.answer.text }
    });
    expect(wait).not.toHaveBeenCalled();
    expect(f.saver.save).not.toHaveBeenCalled();
  }, 10_000);
  it.each(["changed", "streaming"])(
    "does not reuse the answer if it is %s",
    async (change) => {
      const f = await completed();
      await page.locator('[data-message-author-role="assistant"]').evaluate((node, mode) => {
        if (mode === "changed") node.textContent = "Changed answer";
        else node.setAttribute("data-streaming", "true");
      }, change);
      const result = await f.driver.read(f.target, conversation, agent, f.adapter, {
        entered: f.entered,
        waitMs: 0
      });
      expect(result.reply).not.toBe("complete");
      await page.locator('[data-message-author-role="assistant"]').evaluate((node) => {
        node.textContent = "Complete answer";
        node.removeAttribute("data-streaming");
      });
      expect(
        (await f.driver.read(f.target, conversation, agent, f.adapter, { entered: f.entered, waitMs: 0 }))
          .reply
      ).not.toBe("complete");
    },
    10_000
  );
  it("invalidates completion after a positive read observes a missing reply", async () => {
    const f = await completed();
    const markup = await page.locator('[data-message-author-role="assistant"]').evaluate((node) => {
      const html = node.outerHTML;
      node.remove();
      return html;
    });
    expect(
      (await f.driver.read(f.target, conversation, agent, f.adapter, { entered: f.entered, waitMs: 1 })).reply
    ).toBe("none");
    await page.locator("#log").evaluate((node, html) => node.insertAdjacentHTML("beforeend", html), markup);
    expect(
      (await f.driver.read(f.target, conversation, agent, f.adapter, { entered: f.entered, waitMs: 0 })).reply
    ).not.toBe("complete");
  }, 10_000);
  it("does not reuse evidence after a document reload with identical message IDs", async () => {
    const f = await completed();
    await page.reload();
    await page.locator("#log").evaluate((node) => {
      node.setAttribute("data-conversation-id", "new-thread");
      node.innerHTML =
        '<article data-message-author-role="user" data-message-id="user-1">Question</article>' +
        '<article data-message-author-role="assistant" data-message-id="answer-1">Complete answer</article>';
    });
    expect(
      (await f.driver.read(f.target, conversation, agent, f.adapter, { entered: f.entered, waitMs: 0 })).reply
    ).not.toBe("complete");
  }, 10_000);
  it("does not cache text that changed after the completion detector finished", async () => {
    const f = await completed(async () => {
      await page.locator('[data-message-author-role="assistant"]').evaluate((node) => {
        node.textContent = "Changed after completion";
      });
    });
    expect(
      (await f.driver.read(f.target, conversation, agent, f.adapter, { entered: f.entered, waitMs: 0 })).reply
    ).not.toBe("complete");
  }, 10_000);
  it("invalidates cached completion when its current observation is unreadable", async () => {
    const f = await completed();
    const observe = vi.spyOn(f.adapter, "observeResponse").mockRejectedValue(Error("unreadable"));
    expect(
      (await f.driver.read(f.target, conversation, agent, f.adapter, { entered: f.entered, waitMs: 0 })).reply
    ).not.toBe("complete");
    observe.mockRestore();
    expect(
      (await f.driver.read(f.target, conversation, agent, f.adapter, { entered: f.entered, waitMs: 0 })).reply
    ).not.toBe("complete");
  }, 10_000);
  it("does not reuse the answer after the active agent identity changes", async () => {
    const f = await completed();
    await page.locator("main").evaluate((node) => {
      node.setAttribute("data-agent-id", "other-agent");
    });
    await page.locator("h1").evaluate((node) => {
      node.textContent = "Other Agent";
    });
    const result = await f.driver
      .read(f.target, conversation, agent, f.adapter, { entered: f.entered, waitMs: 0 })
      .catch(() => undefined);
    if (result) expect(result.reply).not.toBe("complete");
  }, 10_000);
});
