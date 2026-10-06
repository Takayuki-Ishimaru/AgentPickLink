import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { M365CopilotChatAdapter } from "../../src/transports/browser/adapters/index.js";
import { composerTextMatches, readComposerPlainText } from "../../src/transports/browser/composer-text.js";
import { ConversationDriver } from "../../src/transports/browser/conversation-driver.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
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

describe.skipIf(!executable)("composer fidelity in a real browser", () => {
  let browser: Browser;
  let page: Page;
  const create = (typingDelayMs = 0, stabilityWindowMs = 5) =>
    new M365CopilotChatAdapter({ hostnames: ["m365.example.test"], typingDelayMs, stabilityWindowMs });
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
        body: `<main data-surface="m365-copilot"><h1 data-agent-name="Requirements" data-agent-id="agent-1">Requirements</h1><div role="log"></div><div contenteditable="true" role="textbox"></div><button aria-label="Send">Send</button></main><script>window.sends=0; document.querySelector('button').onclick=()=>window.sends++;</script>`
      })
    );
    await page.goto("https://m365.example.test/chat");
  });
  const texts = [
    "第一行\n第二行",
    "a\n",
    "a\n\n",
    "\n",
    "\n\n",
    "\nfirst\n\nlast\n",
    "第一行\r\n第二行\r\n",
    "  code\n    x  \n```ts\n  x = 1\n```",
    "Ａ①㎏ 👩‍💻 e\u0301 \u200b\u200c\ufeff"
  ];
  it.each(texts)("preserves keyboard input, empty lines, whitespace and Unicode: %j", async (text) => {
    const adapter = create();
    await adapter.fillComposer(page as unknown as PageLike, text);
    const marker = await adapter.captureSubmissionMarker(page as unknown as PageLike, "verified");
    // This editor has no pre-wrap, so Chromium stores some typed spaces as NBSP; nothing else differs.
    expect(composerTextMatches(marker.composerValue, text)).toBe(true);
    await page.evaluate(() => {
      const user = document.createElement("article");
      user.setAttribute("data-message-author-role", "user");
      const output = document.createElement("div");
      output.setAttribute("data-testid", "chatOutput");
      output.innerHTML = document.querySelector("[contenteditable]")!.innerHTML;
      user.append(output);
      document.querySelector("[role=log]")!.append(user);
    });
    await expect(adapter.waitForUserMessageAck(page as unknown as PageLike, marker, 500)).resolves.toEqual({
      state: "sent"
    });
  });

  it.each([
    ["a<div>b</div><div><br></div><div><br></div>", "a\nb\n\n"],
    ["<p>a</p><p><br></p><p>  b<br>c<br></p>", "a\n\n  b\nc"],
    ["a<br>b<br><br>", "a\nb\n"],
    ["<div><p>a</p><p>b</p></div><div>c</div>", "a\nb\nc"],
    ["<p style='display:inline'>a</p><p style='display:inline'>b</p>", "a\nb"],
    ["<p><span data-lexical-text='true'>a</span><br><br data-lexical-managed-linebreak='true'></p>", "a\n"],
    ["<span>a<br></span>b", "a\nb"]
  ])("reads div/p/br without CSS-generated spacing: %s", async (html, expected) => {
    await page.locator("[contenteditable]").evaluate((element, value) => {
      element.innerHTML = value;
    }, html);
    expect(await readComposerPlainText(page.locator("[contenteditable]") as unknown as LocatorLike)).toBe(
      expected
    );
  });

  it.each([
    ["Ａ①㎏", "nfkc"],
    ["👩‍💻", "zwj"],
    ["a\u200b\u200cb", "zero-width"],
    ["  code", "indent"],
    ["a  ", "trailing-space"],
    ["hello", "missing"]
  ])("rejects changed characters and clears the draft: %s / %s", async (text, mode) => {
    await page.evaluate((value) => {
      const editor = document.querySelector("[contenteditable]")!;
      editor.addEventListener("input", () => {
        const raw = editor.textContent ?? "";
        editor.textContent =
          value === "nfkc"
            ? raw.normalize("NFKC")
            : value === "zwj"
              ? raw.replace(/\u200d/g, "")
              : value === "zero-width"
                ? raw.replace(/[\u200b\u200c]/g, "")
                : value === "indent"
                  ? raw.replace(/^[\s\u00a0]+/, "")
                  : value === "trailing-space"
                    ? raw.replace(/[\s\u00a0]+$/, "")
                    : raw.slice(0, -1);
      });
    }, mode);
    await expect(create().fillComposer(page as unknown as PageLike, text)).rejects.toMatchObject({
      code: "UI_CHANGED",
      details: { submissionState: "not-sent" }
    });
    expect(await page.locator("[contenteditable]").textContent()).toBe("");
    expect(await page.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(0);
  });

  it.each([
    { text: "日本語".repeat(80), delay: 20 },
    { text: "👩‍💻日本語".repeat(1000), delay: 0 },
    { text: "短文👩‍💻", delay: 20 }
  ])(
    "stops actual keyboard operations before clearing after cancellation: $delay",
    async ({ text, delay }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      let cancelledAt = 0;
      controller.signal.addEventListener("abort", () => {
        cancelledAt = performance.now();
      });
      try {
        await expect(
          create(delay).fillComposer(page as unknown as PageLike, text, controller.signal)
        ).rejects.toMatchObject({ code: "SUBMIT_FAILED", details: { submissionState: "not-sent" } });
        expect(performance.now() - cancelledAt).toBeLessThan(1000);
        expect(await page.locator("[contenteditable]").textContent()).toBe("");
        await page.waitForTimeout(150);
        expect(await page.locator("[contenteditable]").textContent()).toBe("");
        expect(await page.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(0);
      } finally {
        clearTimeout(timer);
      }
    }
  );

  it("propagates cancellation through the real driver and does not submit", async () => {
    const controller = new AbortController();
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
          create(20),
          {
            message: "日本語".repeat(80),
            signal: controller.signal,
            onProgress: (event) => {
              if (event.phase === "filling") timer = setTimeout(() => controller.abort(), 100);
            }
          }
        )
      ).rejects.toMatchObject({ code: "SUBMIT_FAILED", details: { submissionState: "not-sent" } });
      expect(await page.locator("[contenteditable]").textContent()).toBe("");
      expect(await page.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(0);
    } finally {
      clearTimeout(timer);
    }
  });

  it.each(["retry-wait", "slow-fallback"])("cancels %s without allowing later typing", async (mode) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const typedDelays: number[] = [];
    await page.evaluate(() => {
      const editor = document.querySelector("[contenteditable]")!;
      editor.addEventListener("input", () => {
        editor.textContent = (editor.textContent ?? "").normalize("NFKC");
      });
    });
    const wrapped = new Proxy(page, {
      get(target, key) {
        if (key === "locator")
          return (selector: string) => {
            const locator = target.locator(selector);
            return new Proxy(locator, {
              get(item, method) {
                if (method === "pressSequentially")
                  return async (text: string, options: { delay?: number; timeout?: number }) => {
                    typedDelays.push(options.delay ?? 0);
                    if (mode === "retry-wait" && typedDelays.length === 1)
                      timer = setTimeout(() => controller.abort(), 850);
                    if (mode === "slow-fallback" && options.delay === 20)
                      timer = setTimeout(() => controller.abort(), 50);
                    await item.pressSequentially(text, options);
                  };
                const value = Reflect.get(item, method);
                return typeof value === "function" ? value.bind(item) : value;
              }
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    try {
      await expect(
        create().fillComposer(wrapped as unknown as PageLike, "Ａ".repeat(60), controller.signal)
      ).rejects.toMatchObject({ code: "SUBMIT_FAILED" });
      expect(typedDelays.includes(20)).toBe(mode === "slow-fallback");
      const count = typedDelays.length;
      await page.waitForTimeout(100);
      expect(typedDelays.length).toBe(count);
      expect(await page.locator("[contenteditable]").textContent()).toBe("");
      expect(await page.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(0);
    } finally {
      clearTimeout(timer);
    }
  });

  it("keeps another concurrent page's input intact when one request is cancelled", async () => {
    const second = await browser.newPage();
    await second.setContent('<main><div contenteditable="true"></div></main>');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const [first, other] = await Promise.allSettled([
        create(20).fillComposer(page as unknown as PageLike, "日本語".repeat(80), controller.signal),
        create(0).fillComposer(
          second as unknown as PageLike,
          "第二の入力👩‍💻\n  code",
          new AbortController().signal
        )
      ]);
      expect(first.status).toBe("rejected");
      expect(other.status).toBe("fulfilled");
      expect(
        composerTextMatches(
          await readComposerPlainText(second.locator("[contenteditable]") as unknown as LocatorLike),
          "第二の入力👩‍💻\n  code"
        )
      ).toBe(true);
      expect(await page.locator("[contenteditable]").textContent()).toBe("");
    } finally {
      clearTimeout(timer);
      await second.close();
    }
  });

  // v0.2.7 review P2: a literal NBSP was always rejected from rich text, because the read-back
  // folded NBSP into a space. Chromium stores a typed space as NBSP only without pre-wrap, and
  // there it also turns a typed NBSP into a space; with pre-wrap (as Lexical requires) both stay.
  describe("no-break spaces", () => {
    const NBSP = "\u00a0";
    const sends = () => page.evaluate(() => (window as unknown as { sends: number }).sends);
    const preWrap = () =>
      page.locator("[contenteditable]").evaluate((element) => {
        (element as HTMLElement).style.whiteSpace = "pre-wrap";
      });

    it.each([
      `a${NBSP}b`,
      `a ${NBSP} b`,
      `${NBSP}lead`,
      `trail${NBSP}`,
      `日本語${NBSP}${NBSP}テキスト\n${NBSP}x`
    ])(
      "keeps a literal NBSP in a pre-wrap rich-text editor and recognises the sent message: %j",
      async (text) => {
        await preWrap();
        const adapter = create();
        await adapter.fillComposer(page as unknown as PageLike, text);
        expect(await readComposerPlainText(page.locator("[contenteditable]") as unknown as LocatorLike)).toBe(
          text
        );
        const marker = await adapter.captureSubmissionMarker(page as unknown as PageLike, "verified");
        expect(marker.composerValue).toBe(text);
        await page.evaluate(() => {
          const user = document.createElement("article");
          user.setAttribute("data-message-author-role", "user");
          user.innerHTML = `<div data-testid="chatOutput">${document.querySelector("[contenteditable]")!.innerHTML}</div>`;
          document.querySelector("[role=log]")!.append(user);
        });
        await expect(
          adapter.waitForUserMessageAck(page as unknown as PageLike, marker, 500)
        ).resolves.toEqual({
          state: "sent"
        });
      }
    );

    it.each(["a  b", "abc ", " abc", "x  y  z", "a\n  b  "])(
      "accepts ordinary spaces that a plain rich-text editor stores as NBSP: %j",
      async (text) => {
        const adapter = create();
        await adapter.fillComposer(page as unknown as PageLike, text);
        const marker = await adapter.captureSubmissionMarker(page as unknown as PageLike, "verified");
        expect(marker.composerValue.replace(/\u00a0/g, " ")).toBe(text);
      }
    );

    it("names the change, clears the draft and does not retype when a literal NBSP becomes a space", async () => {
      const typed: string[] = [];
      const wrapped = new Proxy(page, {
        get(target, key) {
          if (key === "locator")
            return (selector: string) =>
              new Proxy(target.locator(selector), {
                get(item, method) {
                  if (method === "pressSequentially")
                    return async (text: string, options: { delay?: number; timeout?: number }) => {
                      typed.push(text);
                      await item.pressSequentially(text, options);
                    };
                  const value = Reflect.get(item, method);
                  return typeof value === "function" ? value.bind(item) : value;
                }
              });
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      await expect(create().fillComposer(wrapped as unknown as PageLike, `a${NBSP}b`)).rejects.toMatchObject({
        code: "UI_CHANGED",
        message: expect.stringContaining("no-break space (U+00A0)"),
        remediation: expect.stringContaining("ordinary spaces"),
        details: { submissionState: "not-sent", composerChange: "no-break-space" }
      });
      expect(typed).toEqual([`a${NBSP}b`]);
      expect(await page.locator("[contenteditable]").textContent()).toBe("");
      expect(await sends()).toBe(0);
    });

    it("keeps a literal NBSP in a textarea composer", async () => {
      await page.evaluate(() => {
        document.querySelector("[contenteditable]")!.replaceWith(document.createElement("textarea"));
      });
      await create().fillComposer(page as unknown as PageLike, `a${NBSP}b `);
      expect(await page.locator("textarea").inputValue()).toBe(`a${NBSP}b `);
    });
  });

  it("cancels the stability wait and a delayed send control before clicking", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    await expect(
      create(0, 2500).fillComposer(page as unknown as PageLike, "hello", controller.signal)
    ).rejects.toMatchObject({ code: "SUBMIT_FAILED" });
    clearTimeout(timer);
    await page.locator("button").evaluate((element) => {
      (element as HTMLButtonElement).disabled = true;
    });
    const submit = new AbortController();
    const submitTimer = setTimeout(() => submit.abort(), 100);
    await expect(create().submitComposer(page as unknown as PageLike, submit.signal)).rejects.toMatchObject({
      code: "SUBMIT_FAILED",
      details: { submissionState: "not-sent" }
    });
    clearTimeout(submitTimer);
    expect(await page.evaluate(() => (window as unknown as { sends: number }).sends)).toBe(0);
  });
});
