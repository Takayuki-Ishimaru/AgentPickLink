import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  RAIL_ARGS,
  readAgentDetailsDescription,
  readAgentPageDescription,
  readRail,
  readStoreCards
} from "../../src/transports/browser/agent-discovery.js";
import { AuthDetector } from "../../src/transports/browser/auth-detector.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import {
  AgentBuilderChatAdapter,
  CopilotStudioM365Adapter,
  M365CopilotChatAdapter,
  TeamsWebAdapter
} from "../../src/transports/browser/adapters/index.js";
import type { BrowserAgentDefinition, PageLike } from "../../src/transports/browser/types.js";
import { startMockChatApp } from "./server.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome"
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

describe.skipIf(!executable)("mock chat through a real browser", () => {
  let browser: Browser;
  let page: Page;
  let app: Awaited<ReturnType<typeof startMockChatApp>>;
  const adapter = new M365CopilotChatAdapter({
    hostnames: ["127.0.0.1"],
    stabilityWindowMs: 20,
    pollIntervalMs: 5,
    // The fixture's "streaming" mode finishes in ~60 ms, before the completion detector's first
    // poll, so these flow tests never observe a streaming signal. The quiet-stream grace is
    // exercised on its own below, with the production default.
    quietStreamingGraceMs: 50
  });

  beforeAll(async () => {
    app = await startMockChatApp();
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      args: ["--no-first-run", "--no-default-browser-check"]
    });
    page = await browser.newPage();
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    await app?.close();
  }, 30_000);

  it("opens a direct agent whose real DOM renders the composer after domcontentloaded", async () => {
    const url = `${app.origin}/chat/agent/delayed-fixture`;
    const target: BrowserAgentDefinition = {
      alias: "delayed-fixture",
      displayName: "Delayed Agent",
      kind: "m365-agent-builder",
      transport: "browser",
      enabled: true,
      capabilityClass: "knowledge-only",
      uiActionPolicy: "never-click",
      entryPoint: { mode: "direct-chat", url, surface: "m365-copilot" },
      verification: {
        status: "verified",
        adapterId: "agent-builder-chat@1",
        expectedDisplayName: "Delayed Agent",
        expectedStableAgentId: "delayed-fixture",
        expectedSurface: "m365-copilot",
        validatedUrlPattern: "^/chat/agent/delayed-fixture$",
        bindingFingerprint: `sha256:${"a".repeat(64)}`,
        validatedAt: "2026-09-07T00:00:00.000Z"
      }
    };
    const loadingAdapter = new AgentBuilderChatAdapter({ hostnames: ["127.0.0.1"] });
    const probe = vi.spyOn(loadingAdapter, "canHandle");
    const navigator = new AgentNavigator(
      new NavigationPolicy({
        appHosts: ["127.0.0.1"],
        allowInsecureLoopback: true
      })
    );
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html>
      <title>Microsoft 365 Copilot</title><main data-agent-id="delayed-fixture">
      <h1>Delayed Agent</h1><p>Microsoft 365 Copilot</p><div role="log"></div>
      <textarea aria-label="Message" hidden></textarea><button type="submit">Send</button></main>
      <script>setTimeout(() => document.querySelector('textarea').hidden = false, 1000);</script>`
      })
    );
    try {
      await navigator.open(page as unknown as PageLike, target, loadingAdapter, { timeoutMs: 5_000 });

      expect(await probe.mock.results[0].value).toMatchObject({ matched: false });
      expect(await loadingAdapter.canHandle(page as unknown as PageLike)).toMatchObject({ matched: true });
      expect(await page.locator("textarea").inputValue()).toBe("");
      expect(page.url()).toBe(url);
    } finally {
      probe.mockRestore();
      await page.unroute(url);
    }
  }, 10_000);

  it("names a rail row and its link by the text a sighted user reads, not by the DOM's concatenation", async () => {
    // Rows shaped like Microsoft 365's: avatar initials in a role="img" span, the name split across
    // inline spans, a screen-reader-only keyboard hint clipped to one pixel right after the name, and
    // icon-only pin / overflow buttons; then rows that put a description, a hidden conversation list,
    // an icon-only label, transparent text, and zero-size text next to the name.
    await page.setContent(`<!doctype html><html><head><style>
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
      .row { display: flex; align-items: center; gap: 4px; }
      .avatar { display: inline-flex; width: 16px; height: 16px; }
      .desc { display: block; }
      .badge { display: inline-block; }
    </style></head><body><div role="navigation">
      <div class="row" data-agent-id="T_hint" data-nav-item-action-row-scope="">
        <a href="https://m365.example.test/chat/agent/T_hint">
          <span role="img" class="avatar" aria-label="APL-T08-PdfFile">AP</span>
          <span>APL-T08-</span><span>PdfFile</span>
          <span class="sr-only">Tab キーを押して [ピン留め]、[その他のオプション] ボタンにアクセスします。</span>
        </a>
        <button type="button" aria-label="ピン留め"><svg width="8" height="8"></svg></button>
        <button type="button" aria-label="その他のオプション"><span aria-hidden="true">…</span></button>
      </div>
      <div data-agent-id="T_lines">
        <span><b>Sales</b> <i>Agent</i></span>
        <span class="desc">Answers sales questions</span>
        <ul style="display: none"><li>Quarterly numbers</li></ul>
        <button type="button">すべて表示</button>
      </div>
      <div class="row" data-agent-id="T_badge"><span>Finance Agent</span><span class="badge">New</span></div>
      <div class="row" data-agent-id="T_icon" aria-label="Icon Only Agent"><span role="img" aria-label="Icon Only Agent">IO</span></div>
      <div class="row" data-agent-id="T_ghost"><span style="opacity: 0">ghost</span><span style="visibility: hidden">unseen</span><span>Visible Agent</span></div>
      <a href="https://m365.example.test/chat/agent/T_label" aria-label="Labelled Agent"><span role="img">LA</span></a>
    </div></body></html>`);

    const rail = await page.evaluate(readRail, RAIL_ARGS);

    expect(rail.rows).toEqual([
      { id: "T_hint", name: "APL-T08-PdfFile", description: undefined },
      { id: "T_lines", name: "Sales Agent", description: undefined },
      // A badge is its own inline-block box, not part of the name's text run.
      { id: "T_badge", name: "Finance Agent", description: undefined },
      { id: "T_icon", name: "Icon Only Agent", description: undefined },
      { id: "T_ghost", name: "Visible Agent", description: undefined }
    ]);
    expect(rail.links).toEqual([
      { href: "https://m365.example.test/chat/agent/T_hint", name: "APL-T08-PdfFile" },
      { href: "https://m365.example.test/chat/agent/T_label", name: "Labelled Agent" }
    ]);
  });

  it("reads agent descriptions from Microsoft 365 metadata, excluding titles and keyboard instructions", async () => {
    await page.setContent(`<div data-agent-id="explicit" data-agent-name="Agent A" data-agent-description="Official description" title="Wrong tooltip"></div>
      <div data-agent-id="child"><span>Agent B</span><p data-testid="agent-description">Description under the name</p></div>
      <div data-agent-id="referenced" data-agent-name="Agent C" aria-describedby="description"><span>Agent C</span></div>
      <p id="description">Accessible agent description</p>
      <div data-agent-id="tooltip" data-agent-name="Agent D" title="Agent D" aria-describedby="keys"><span>Agent D</span></div>
      <p id="keys">Press Tab to access the Pin and More options buttons</p>`);
    // Give metadata-only rows layout just as the rendered app's rows have.
    await page.addStyleTag({ content: "[data-agent-id] { min-height: 20px; }" });
    const rail = await page.evaluate(readRail, RAIL_ARGS);
    expect(rail.rows.map((row) => row.description)).toEqual([
      "Official description",
      "Description under the name",
      "Accessible agent description",
      undefined
    ]);
  });

  it("reads the catalogue description even when the card's accessible label is only its name", async () => {
    await page.setContent(`<div role="list">
      <button aria-label="Agent A"><span role="img">AA</span><span>Agent A</span><p>Real description A</p></button>
      <button aria-label="Agent B Real description B"><span>Agent B</span><p>Real description B</p></button>
      <button aria-label="Long Agent"><span>Long Agent</span><p>${"Long description. ".repeat(40)}</p></button>
    </div>`);
    const cards = await page.evaluate(readStoreCards, {
      skip: "^More options$",
      forbidden: "^Add$",
      more: [],
      max: 20,
      opens: "opens the agent"
    });
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({ key: "Agent A", name: "Agent A", description: "Real description A" });
    expect(cards[1]).toMatchObject({
      key: "Agent B Real description B",
      name: "Agent B",
      description: "Real description B"
    });
    expect(cards[2].description!.length).toBeGreaterThan(400);
  });

  it("reads only explicitly marked description metadata on a direct-agent page", async () => {
    await page.setContent(`<main>
      <h1>Requirements Agent</h1><p>Conversation text must not become a description.</p>
      <section data-testid="agent-header" aria-describedby="agent-summary"></section>
      <p id="agent-summary">Answers questions about approved requirements.</p>
      <p data-testid="agent-description">Prefer this explicit description.</p>
    </main>`);

    await expect(page.evaluate(readAgentPageDescription)).resolves.toBe("Prefer this explicit description.");
  });

  it("keeps direct-agent identity independent of generic or disappearing composer labels", async () => {
    const id = "T_agent.gpt.instance";
    const name = "APL-T09-MultiFiles";
    await page.setContent(`<main role="main" data-surface="m365-copilot"><h1>${name} にメッセージを送信してください</h1><button>${name}</button><div aria-label="${name} にメッセージを送信してください"></div>
      <div class="composer-wrap" aria-label="Copilot にメッセージを送信する"><textarea placeholder="Copilot にメッセージを送信する"></textarea></div></main>`);
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const identityPage: PageLike = {
      url: () => `https://m365.example.test/chat/agent/${id}`,
      evaluate: page.evaluate.bind(page) as PageLike["evaluate"]
    };
    await expect(adapter.detectAgentIdentity(identityPage, name)).resolves.toMatchObject({
      displayName: name,
      stableAgentId: id
    });
    await expect(
      adapter.assertAgentIdentity(identityPage, {
        expectedDisplayName: `${name} にメッセージを送信してください`,
        expectedStableAgentId: id,
        expectedSurface: "m365-copilot",
        validatedUrlPattern: `^/chat/agent/${id}/?$`
      })
    ).resolves.toMatchObject({ valid: false });
    await page.locator("textarea").fill("hello");
    await page.locator("textarea").evaluate((node) => node.removeAttribute("placeholder"));
    await expect(adapter.detectAgentIdentity(identityPage, name)).resolves.toMatchObject({
      displayName: name,
      stableAgentId: id
    });

    await page.setContent(
      `<main role="main" data-surface="m365-copilot"><div aria-label="Copilot にメッセージを送信する"><textarea aria-label="Copilot にメッセージを送信する"></textarea></div></main>`
    );
    await expect(adapter.detectAgentIdentity(identityPage, name)).resolves.toBeNull();

    await page.setContent(
      `<main role="main" data-surface="m365-copilot"><h1>Other Agent</h1><p>${name}</p><textarea aria-label="Copilot にメッセージを送信する"></textarea></main>`
    );
    await expect(
      adapter.assertAgentIdentity(identityPage, {
        expectedDisplayName: name,
        expectedStableAgentId: id,
        expectedSurface: "m365-copilot",
        validatedUrlPattern: `^/chat/agent/${id}/?$`
      })
    ).resolves.toMatchObject({ valid: false });
  });

  it("recovers an agent identity from the latest assistant card after the upper name disappears", async () => {
    const id = "T_synthetic.gpt.instance";
    const name = "Synthetic Stream Agent";
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const identityPage: PageLike = {
      url: () => `https://m365.example.test/chat/agent/${id}/conversation/conv-1`,
      evaluate: page.evaluate.bind(page) as PageLike["evaluate"]
    };
    const composer = (recipient: string) =>
      `<span contenteditable="true" aria-label="${recipient} にメッセージを送信してください" style="display:inline-block;width:320px;height:24px"></span>`;
    const assistantCard = (cardName: string, options = "") =>
      `<article class="fai-CopilotMessage" role="article" style="display:block;width:640px;height:80px">
        <div><div class="fai-CopilotMessage__name"><div><span>${cardName}</span></div></div></div>
        <div class="fai-CopilotMessage__content">answer ${options}</div><div class="actions"></div>
      </article>`;
    const base = (body: string) => `<main role="main" data-surface="m365-copilot">${body}</main>`;

    await page.setContent(base(composer(name) + assistantCard(name)));
    await expect(adapter.detectAgentIdentity(identityPage, name)).resolves.toMatchObject({
      displayName: name,
      stableAgentId: id,
      surface: "m365-copilot"
    });
    await expect(
      adapter.assertAgentIdentity(identityPage, {
        expectedDisplayName: name,
        expectedStableAgentId: id,
        expectedSurface: "m365-copilot",
        validatedUrlPattern: `^/chat/agent/${id}/?$`
      })
    ).resolves.toMatchObject({ valid: true });

    await page.setContent(base(composer(name) + assistantCard(name, "older") + assistantCard("Other Agent")));
    await expect(adapter.detectAgentIdentity(identityPage, name)).resolves.toBeNull();

    await page.setContent(
      base(
        composer(name) +
          assistantCard(name, `body contains ${name} only`).replace(
            `fai-CopilotMessage__name"><div><span>${name}</span>`,
            `fai-CopilotMessage__name"><div><span style="display:none">${name}</span>`
          )
      )
    );
    await expect(adapter.detectAgentIdentity(identityPage, name)).resolves.toBeNull();

    await page.setContent(
      base(
        composer(name) +
          `<article class="fai-CopilotMessage" role="article" style="display:block;width:640px;height:100px">
            <div><div class="fai-CopilotMessage__name"><div><span>Other Agent</span></div></div></div>
            <div class="fai-CopilotMessage__content">
              <div class="fai-CopilotMessage__name"><div><span>${name}</span></div></div>
              <article class="fai-CopilotMessage" role="article"><div><div class="fai-CopilotMessage__name"><div><span>${name}</span></div></div></div></article>
            </div><div class="actions"></div>
          </article>`
      )
    );
    await expect(adapter.detectAgentIdentity(identityPage, name)).resolves.toBeNull();

    await page.setContent(
      base(composer(name) + `<nav data-agent-id="${id}" data-agent-name="${name}">${name}</nav>`)
    );
    await expect(adapter.detectAgentIdentity(identityPage, name)).resolves.toBeNull();

    await page.setContent(base(composer("Other Agent") + assistantCard(name)));
    await expect(adapter.detectAgentIdentity(identityPage, name)).resolves.toBeNull();
  });

  it("extracts real prose from the exact-title details dialog, not Agent Builder boilerplate", async () => {
    const prose = "Microsoft 365 Copilot 対応。\n短い説明です。";
    const permissions = "この長いアクセス許可の説明は詳細本文ではありません。".repeat(12);
    await page.setContent(`<button id="agent-title">Requirements Agent</button>
      <div id="details" role="dialog" aria-modal="true" aria-labelledby="missing-dialog-title" hidden>
        <span id="dialog-title">Requirements Agent</span>
        <span>Microsoft 365 Copilot エージェント ビルダーを使用して構築します</span>
        <span class="fui-Text"><p>Microsoft 365 Copilot 対応。</p><p>短い説明です。</p></span>
        <h2>アプリの機能</h2><p>Copilot</p><h2>アクセス許可</h2><p>${permissions}</p><button id="dismiss">閉じる</button>
      </div>
      <script>
        const details = document.getElementById('details');
        document.getElementById('agent-title').onclick = () => details.hidden = false;
        document.getElementById('dismiss').onclick = () => details.hidden = true;
      </script>`);
    await page.getByRole("button", { name: "Requirements Agent", exact: true }).click();
    await expect(page.evaluate(readAgentDetailsDescription, "Requirements Agent")).resolves.toBe(prose);
    await expect(page.evaluate(readAgentDetailsDescription, "Wrong Agent")).resolves.toBeUndefined();
    await page.locator("#dialog-title").evaluate((node) => (node.textContent = "Other Agent"));
    await expect(page.evaluate(readAgentDetailsDescription, "Requirements Agent")).resolves.toBeUndefined();
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(page.evaluate(readAgentDetailsDescription, "Requirements Agent")).resolves.toBeUndefined();
  });

  it("reads the unique pre-separator Fluent summary/description pair for an Admin agent", async () => {
    await page.setContent(`<div role="dialog" aria-labelledby="missing" aria-modal="true">
      <span>Microsoft 365 Admin</span><span>Author</span>
      <div><span class="fui-Text">Use AI to help you manage Microsoft 365.</span><span class="fui-Text"><p>Manage tenant settings.</p><ul><li>Review users</li></ul><p>Keep services healthy.</p></span></div>
      <div>アプリの機能</div><div role="separator"></div><div><p>${"Permission prose ".repeat(30)}</p></div>
    </div>`);
    await expect(page.evaluate(readAgentDetailsDescription, "Microsoft 365 Admin")).resolves.toBe(
      "Manage tenant settings.\nReview users\nKeep services healthy."
    );
  });

  it("completes new-chat, one-message acknowledgement, streaming, and latest-response extraction", async () => {
    await page.goto(`${app.origin}/chat?mode=streaming`);
    const browserPage = page as unknown as PageLike;
    await expect(adapter.canHandle(browserPage)).resolves.toMatchObject({
      matched: true,
      confidence: "strong"
    });
    const before = await adapter.captureConversationMarker(browserPage);
    await adapter.startNewConversation(browserPage);
    await expect(adapter.verifyNewConversation(browserPage, before)).resolves.toMatchObject({
      verified: true
    });
    await adapter.fillComposer(browserPage, "hello");
    const submission = await adapter.captureSubmissionMarker(browserPage);
    await adapter.submitComposer(browserPage);
    await expect(adapter.waitForUserMessageAck(browserPage, submission, 1_000)).resolves.toMatchObject({
      state: "sent"
    });
    const response = await adapter.waitForResponseStart(browserPage, submission, 1_000);
    await expect(adapter.waitForResponseComplete(browserPage, response, 2_000)).resolves.toMatchObject({
      complete: true
    });
    await expect(adapter.extractLatestResponse(browserPage, response)).resolves.toMatchObject({
      text: "stream 3"
    });
    expect(await page.locator('[data-message-author-role="user"]').count()).toBe(1);
  });

  it("completes on the stop-generating control's accessible name, without waiting out the quiet grace", async () => {
    // The fixture's only streaming evidence is a stop-generating button identified by its
    // accessible name: it carries no data-streaming attribute, no aria-busy, and no label text,
    // so the body-text heuristic cannot see it either.
    const streamingAdapter = new M365CopilotChatAdapter({
      hostnames: ["127.0.0.1"],
      stabilityWindowMs: 50,
      pollIntervalMs: 25
    });
    await page.goto(`${app.origin}/chat?mode=stop-control-stream`);
    const browserPage = page as unknown as PageLike;
    await streamingAdapter.startNewConversation(browserPage);
    await streamingAdapter.fillComposer(browserPage, "hello");
    const submission = await streamingAdapter.captureSubmissionMarker(browserPage);
    await streamingAdapter.submitComposer(browserPage);
    await streamingAdapter.waitForUserMessageAck(browserPage, submission, 2_000);
    const response = await streamingAdapter.waitForResponseStart(browserPage, submission, 2_000);
    const started = Date.now();
    const completion = await streamingAdapter.waitForResponseComplete(browserPage, response, 5_000);
    // The default 3 s quiet grace is skipped because streaming was actually observed.
    expect(completion).toMatchObject({ complete: true, reason: "stable", sawStreamingSignal: true });
    expect(completion.finalChars).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2_500);
    await expect(streamingAdapter.extractLatestResponse(browserPage, response)).resolves.toMatchObject({
      text: "stream 4"
    });
  }, 30_000);

  it("waits out the quiet grace when a response never shows a streaming signal", async () => {
    // Nothing ever reports "generating" in this mode, so completion must not be declared on
    // stillness alone: an empty assistant node that has not started writing looks exactly the same.
    const quietAdapter = new M365CopilotChatAdapter({
      hostnames: ["127.0.0.1"],
      stabilityWindowMs: 50,
      pollIntervalMs: 25
    });
    await page.goto(`${app.origin}/chat?mode=citations`);
    const browserPage = page as unknown as PageLike;
    await quietAdapter.startNewConversation(browserPage);
    await quietAdapter.fillComposer(browserPage, "hello");
    const submission = await quietAdapter.captureSubmissionMarker(browserPage);
    await quietAdapter.submitComposer(browserPage);
    await quietAdapter.waitForUserMessageAck(browserPage, submission, 2_000);
    const response = await quietAdapter.waitForResponseStart(browserPage, submission, 2_000);
    const started = Date.now();
    const completion = await quietAdapter.waitForResponseComplete(browserPage, response, 10_000);
    expect(completion).toMatchObject({ complete: true, reason: "stable", sawStreamingSignal: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
  }, 30_000);

  it("extracts normalized citations and detects action controls without clicking them", async () => {
    await page.goto(`${app.origin}/chat?mode=citations`);
    const citation = await submitAndExtract(page);
    expect(citation.citations).toEqual([{ index: 1, title: "Source", url: "https://example.test/source" }]);
    await page.goto(`${app.origin}/chat?mode=action-controls`);
    const action = await submitAndExtract(page);
    expect(action.actionRequired).toBe(true);
    expect(await page.getByRole("button", { name: "承認" }).count()).toBe(1);
  });

  const submittingAdapters = [
    [
      "m365-copilot-chat@1",
      () =>
        new M365CopilotChatAdapter({
          hostnames: ["127.0.0.1"],
          stabilityWindowMs: 20,
          pollIntervalMs: 5,
          quietStreamingGraceMs: 50
        }),
      "m365-copilot"
    ],
    [
      "agent-builder-chat@1",
      () =>
        new AgentBuilderChatAdapter({
          hostnames: ["127.0.0.1"],
          stabilityWindowMs: 20,
          pollIntervalMs: 5,
          quietStreamingGraceMs: 50
        }),
      "m365-copilot"
    ],
    [
      "copilot-studio-m365-chat@1",
      () =>
        new CopilotStudioM365Adapter({
          hostnames: ["127.0.0.1"],
          stabilityWindowMs: 20,
          pollIntervalMs: 5,
          quietStreamingGraceMs: 50
        }),
      "m365-copilot"
    ],
    [
      "teams-web-agent-chat@1",
      () =>
        new TeamsWebAdapter({
          hostnames: ["127.0.0.1"],
          stabilityWindowMs: 20,
          pollIntervalMs: 5,
          quietStreamingGraceMs: 50
        }),
      "teams-web"
    ]
  ] as const;

  describe.each(submittingAdapters)("English-locale fixture: %s", (adapterId, createAdapter, surface) => {
    it(`completes new-chat, submit, ack, and extraction against the English page (${adapterId})`, async () => {
      const localeAdapter = createAdapter();
      await page.goto(`${app.origin}/chat?mode=streaming&locale=en&surface=${surface}`);
      const browserPage = page as unknown as PageLike;
      await expect(localeAdapter.canHandle(browserPage)).resolves.toMatchObject({
        matched: true,
        confidence: "strong"
      });
      const before = await localeAdapter.captureConversationMarker(browserPage);
      await localeAdapter.startNewConversation(browserPage);
      await expect(localeAdapter.verifyNewConversation(browserPage, before)).resolves.toMatchObject({
        verified: true
      });
      await localeAdapter.fillComposer(browserPage, "hello");
      const submission = await localeAdapter.captureSubmissionMarker(browserPage);
      await localeAdapter.submitComposer(browserPage);
      await expect(
        localeAdapter.waitForUserMessageAck(browserPage, submission, 1_000)
      ).resolves.toMatchObject({ state: "sent" });
      const response = await localeAdapter.waitForResponseStart(browserPage, submission, 1_000);
      await expect(
        localeAdapter.waitForResponseComplete(browserPage, response, 2_000)
      ).resolves.toMatchObject({ complete: true });
      await expect(localeAdapter.extractLatestResponse(browserPage, response)).resolves.toMatchObject({
        text: "stream 3"
      });
      expect(await page.locator('[data-message-author-role="user"]').count()).toBe(1);
    });
  });

  it("fails closed for wrong identity, changed identity, ambiguous/disabled composers, and unsafe acknowledgements", async () => {
    await page.goto(`${app.origin}/chat?mode=wrong-agent`);
    await expect(
      adapter.assertAgentIdentity(page as unknown as PageLike, verification())
    ).resolves.toMatchObject({ valid: false, code: "AGENT_IDENTITY_MISMATCH" });

    await page.goto(`${app.origin}/chat?mode=identity-change`);
    await adapter.fillComposer(page as unknown as PageLike, "secret");
    await expect(
      adapter.assertAgentIdentity(page as unknown as PageLike, verification())
    ).resolves.toMatchObject({ valid: false });

    await page.goto(`${app.origin}/chat?mode=multiple-composers`);
    await expect(adapter.findComposer(page as unknown as PageLike)).rejects.toMatchObject({
      code: "CHAT_INPUT_AMBIGUOUS"
    });
    await page.goto(`${app.origin}/chat?mode=disabled-controls`);
    await expect(adapter.findComposer(page as unknown as PageLike)).rejects.toMatchObject({
      code: "CHAT_INPUT_NOT_FOUND"
    });

    // Once the send control was activated, an unacknowledged message is "unknown", never
    // "not-sent": only a positive signal (the composer still holding the prompt) may say not-sent.
    for (const [mode, expected] of [
      ["ack-absent", "unknown"],
      ["ack-ambiguous", "unknown"],
      ["duplicate-send", "unknown"],
      ["send-noop", "not-sent"]
    ] as const) {
      await page.goto(`${app.origin}/chat?mode=${mode}`);
      const browserPage = page as unknown as PageLike;
      await adapter.startNewConversation(browserPage);
      await adapter.fillComposer(browserPage, "hello");
      const marker = await adapter.captureSubmissionMarker(browserPage);
      await adapter.submitComposer(browserPage);
      const ack = await adapter.waitForUserMessageAck(browserPage, marker, 100);
      expect({ mode, state: ack.state }).toEqual({ mode, state: expected });
    }
  });

  it("detects unauthenticated UI and refuses an unverifiable new-chat transition", async () => {
    await page.goto(`${app.origin}/chat?mode=unauthenticated`);
    await expect(new AuthDetector().detect(page as unknown as PageLike)).resolves.toBe("sign-in-required");
    await page.goto(`${app.origin}/chat?mode=new-conversation-failure`);
    const browserPage = page as unknown as PageLike;
    const before = await adapter.captureConversationMarker(browserPage);
    await adapter.startNewConversation(browserPage);
    await expect(adapter.verifyNewConversation(browserPage, before)).resolves.toMatchObject({
      verified: false
    });
  });

  async function submitAndExtract(target: Page) {
    const browserPage = target as unknown as PageLike;
    await adapter.startNewConversation(browserPage);
    await adapter.fillComposer(browserPage, "hello");
    const submission = await adapter.captureSubmissionMarker(browserPage);
    await adapter.submitComposer(browserPage);
    await adapter.waitForUserMessageAck(browserPage, submission, 1_000);
    const response = await adapter.waitForResponseStart(browserPage, submission, 1_000);
    await adapter.waitForResponseComplete(browserPage, response, 2_000);
    return adapter.extractLatestResponse(browserPage, response);
  }
});

function verification() {
  return {
    status: "verified" as const,
    adapterId: "m365-copilot-chat@1",
    expectedDisplayName: "Requirements Agent",
    expectedStableAgentId: "agent-requirements",
    expectedSurface: "m365-copilot" as const,
    validatedUrlPattern: "^/chat$",
    bindingFingerprint: `sha256:${"a".repeat(64)}`,
    validatedAt: new Date().toISOString()
  };
}
