import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { AgentDiscovery } from "../../src/transports/browser/agent-discovery.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import type { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import type { PageLike } from "../../src/transports/browser/types.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome"
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

describe.skipIf(!executable)("agent description discovery through a real browser", () => {
  it("reuses fresh descriptions, expires them, and cancels only the discovery page", async () => {
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    const context = await browser.newContext();
    const otherPage = await context.newPage();
    let details = 0;
    let delay = false;
    const origin = "http://127.0.0.1:9";
    await context.exposeFunction("detailsOpened", () => details++);
    await context.route(`${origin}/**`, async (route) => {
      const direct = new URL(route.request().url()).pathname.endsWith("/agent/one");
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: direct
          ? `<main>Microsoft 365 Copilot<button id="title" ${delay ? "hidden" : ""} onclick="document.getElementById('details').hidden=false; detailsOpened()">One</button></main>
          <div role="dialog" aria-label="One" id="details" hidden><span>Microsoft 365 Copilot エージェント ビルダーを使用して構築します</span><span><p>Actual description.</p></span><button onclick="document.getElementById('details').hidden=true">閉じる</button></div>`
          : '<main>Microsoft 365 Copilot</main><nav><a href="/chat/agent/one">One</a></nav>'
      });
    });
    const pages = new Map<string, import("playwright-core").Page>();
    const policy = new NavigationPolicy({ appHosts: ["127.0.0.1"], allowInsecureLoopback: true });
    const discovery = new AgentDiscovery({
      manager: {
        createConversationPage: async (key: string) => {
          const page = await context.newPage();
          pages.set(key, page);
          return { page };
        },
        closePage: async (key: string) => {
          await pages.get(key)?.close();
          pages.delete(key);
        }
      } as unknown as BrowserManager,
      policy,
      navigator: new AgentNavigator(policy),
      appHosts: ["127.0.0.1"],
      neutralAppUrl: `${origin}/chat`,
      rowsSettleMs: 20,
      storeWaitMs: 20,
      storeItemWaitMs: 20,
      descriptionWaitMs: 10_000
    });
    try {
      expect((await discovery.discover(15_000)).agents[0]?.description).toBe("Actual description.");
      expect(details).toBe(1);
      expect((await discovery.discover(15_000)).agents[0]?.description).toBe("Actual description.");
      expect(details).toBe(1);
      const originalNow = Date.now.bind(Date);
      const now = vi.spyOn(Date, "now").mockImplementation(() => originalNow() + 31 * 60_000);
      try {
        expect((await discovery.discover(15_000)).agents[0]?.description).toBe("Actual description.");
      } finally {
        now.mockRestore();
      }
      expect(details).toBe(2);
      discovery.clearDescriptionCache();
      delay = true;
      const controller = new AbortController();
      let cancelledAt = 0;
      const result = await discovery.discover(
        15_000,
        (event) => {
          if (event.message?.startsWith("Retrying"))
            setTimeout(() => {
              cancelledAt = Date.now();
              controller.abort();
            }, 100);
        },
        controller.signal
      );
      expect(result.warnings).toEqual(["discovery-cancelled"]);
      expect(result.agents.map((agent) => agent.displayName)).toEqual(["One"]);
      expect(Date.now() - cancelledAt).toBeLessThan(2_000);
      expect(pages.size).toBe(0);
      expect(otherPage.isClosed()).toBe(false);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it(
    "waits for cold metadata for every rail agent even when the store yielded no descriptions",
    async () => {
      const browser = await chromium.launch({ executablePath: executable, headless: true });
      try {
        const page = await browser.newPage();
        const origin = "http://127.0.0.1:9";
        const visits: string[] = [];
        await page.route(`${origin}/**`, async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          const match = /agent\/(agent-\d)$/.exec(pathname);
          if (match) visits.push(match[1]!);
          const body = match
            ? `<main>Microsoft 365 Copilot<button id="title" hidden onclick="document.getElementById('details').hidden=false">Agent ${match[1]!.slice(-1)}</button></main>
            <div role="dialog" aria-label="Agent ${match[1]!.slice(-1)}" id="details" hidden>
              <span>Microsoft 365 Copilot エージェント ビルダーを使用して構築します</span>
              <span><p>Description ${match[1]}</p></span>
              <button onclick="document.getElementById('details').hidden=true">閉じる</button>
            </div><script>setTimeout(() => document.getElementById("title").hidden=false, 300)</script>`
            : `<main>Microsoft 365 Copilot</main><nav>${[1, 2, 3, 4].map((n) => `<a href="/chat/agent/agent-${n}">Agent ${n}</a>`).join("")}</nav>`;
          await route.fulfill({ contentType: "text/html; charset=utf-8", body });
        });
        const policy = new NavigationPolicy({ appHosts: ["127.0.0.1"], allowInsecureLoopback: true });
        const discovery = new AgentDiscovery({
          manager: {
            createConversationPage: async () => ({ page: page as unknown as PageLike }),
            closePage: async () => page.close()
          } as unknown as BrowserManager,
          policy,
          navigator: new AgentNavigator(policy),
          appHosts: ["127.0.0.1"],
          neutralAppUrl: `${origin}/chat`,
          rowsSettleMs: 20,
          storeWaitMs: 100,
          storeItemWaitMs: 50,
          descriptionWaitMs: 1_000
        });
        const result = await discovery.discover(10_000);
        expect(result.agents.map((agent) => agent.description)).toEqual(
          [1, 2, 3, 4].map((n) => `Description agent-${n}`)
        );
        expect(visits).toEqual(["agent-1", "agent-2", "agent-3", "agent-4"]);
        expect(result.warnings).toContain("description-retry:attempted=4 recovered=4");
        expect(page.isClosed()).toBe(true);
      } finally {
        await browser.close();
      }
    },
    process.platform === "win32" ? 60_000 : 15_000
  );

  it.each([false, true])(
    "bounds retries and closes the page when missing metadata recovers: %s",
    async (recover) => {
      const browser = await chromium.launch({ executablePath: executable, headless: true });
      try {
        const page = await browser.newPage();
        const actions: string[] = [];
        await page.exposeFunction("recordAction", (action: string) => actions.push(action));
        const origin = "http://127.0.0.1:9";
        let missingVisits = 0;
        await page.route(`${origin}/**`, async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === "/chat/agent/no-details") missingVisits++;
          const recoveredVisit = recover && pathname === "/chat/agent/no-details" && missingVisits > 1;
          const titleName = recoveredVisit ? "No Details Agent" : "Requirements Agent";
          let body = '<main>Microsoft 365 Copilot <a href="/chat/agentstore">Agent catalogue</a></main>';
          if (pathname === "/chat/agentstore") {
            body = `<main>Microsoft 365 Copilot<div role="list">
            <button aria-description="Press Enter to open the agent" onclick="location.href='/chat/agent/no-details'">No Details Agent</button>
            <button aria-description="Press Enter to open the agent" onclick="location.href='/chat/agent/requirements'">Requirements Agent</button>
          </div></main>`;
          } else if (pathname === "/chat/agent/requirements" || recoveredVisit) {
            body = `<main>Microsoft 365 Copilot
            <button id="title" hidden>${titleName}</button>
            <textarea aria-label="Message"></textarea>
            <button onclick="recordAction('send')">Send</button>
          </main>
          <div role="dialog" aria-modal="true" aria-labelledby="missing-dialog-title" id="details" hidden>
            <div id="metadata" hidden><span id="dialog-title">${titleName}</span>
            <span class="fui-Text">Microsoft 365 Copilot エージェント ビルダーを使用して構築します</span>
            <span class="fui-Text"><p>短い説明です。</p></span></div>
            <h2>アクセス許可</h2><p>Permission prose must never become the agent description.</p>
            <button onclick="recordAction('open')">開く</button>
            <button onclick="recordAction('add')">追加</button>
            <button onclick="dismiss()">閉じる</button>
          </div><script>
            const title = document.getElementById('title');
            const details = document.getElementById('details');
            title.onclick = () => { details.hidden = false; recordAction('details'); setTimeout(() => document.getElementById('metadata').hidden = false, 100); };
            function dismiss() { details.hidden = true; recordAction('dismiss'); }
            details.onkeydown = (event) => { if (event.key === 'Escape') dismiss(); };
            setTimeout(() => title.hidden = false, 100);
          </script>`;
          } else if (pathname === "/chat/agent/no-details") {
            body = "<main>Microsoft 365 Copilot — no inspectable agent title</main>";
          }
          await route.fulfill({ contentType: "text/html; charset=utf-8", body });
        });
        let created = 0;
        let closed = 0;
        const manager = {
          createConversationPage: async () => {
            created++;
            return { page: page as unknown as PageLike };
          },
          closePage: async () => {
            closed++;
            await page.close();
          }
        } as unknown as BrowserManager;
        const policy = new NavigationPolicy({ appHosts: ["127.0.0.1"], allowInsecureLoopback: true });
        const discovery = new AgentDiscovery({
          manager,
          policy,
          navigator: new AgentNavigator(policy),
          appHosts: ["127.0.0.1"],
          neutralAppUrl: `${origin}/chat`,
          navigationTimeoutMs: 1_000,
          renderTimeoutMs: 500,
          rowsSettleMs: 20,
          storeWaitMs: 100,
          storeItemWaitMs: 500
        });
        // Keep enough total budget for the real browser to start alongside the other
        // integration fixtures. The description retry itself remains bounded by the
        // implementation's per-card wait and the assertions below still require exactly
        // one optional revisit.
        const result = await discovery.discover(10_000);
        expect(result.agents.map(({ displayName, description }) => ({ displayName, description }))).toEqual([
          { displayName: "No Details Agent", description: recover ? "短い説明です。" : undefined },
          { displayName: "Requirements Agent", description: "短い説明です。" }
        ]);
        expect(actions).toEqual(
          recover ? ["details", "dismiss", "details", "dismiss"] : ["details", "dismiss"]
        );
        expect(missingVisits).toBe(2);
        expect(result.warnings).toContain(`description-retry:attempted=1 recovered=${Number(recover)}`);
        expect(created).toBe(1);
        expect(closed).toBe(1);
        expect(page.isClosed()).toBe(true);
      } finally {
        await browser.close();
      }
    },
    process.platform === "win32" ? 60_000 : 15_000
  );
});
