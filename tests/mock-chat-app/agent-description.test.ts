import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { AgentDiscovery } from "../../src/transports/browser/agent-discovery.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import type { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import type { PageLike } from "../../src/transports/browser/types.js";
import { summarizeDiscoveryCompleteness } from "../../src/domain/discovery-warnings.js";

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
          navigationTimeoutMs: 3_000,
          descriptionWaitMs: 1_000,
          renderTimeoutMs: 500,
          rowsSettleMs: 20,
          storeWaitMs: 100,
          storeItemWaitMs: 3_000
        });
        // Use the production card-click budget: 500ms can expire during navigation even
        // when the click succeeds. Keep the description inspection at one second.
        // Keep enough total budget for the real browser to start alongside the other
        // integration fixtures. The description retry itself remains bounded by the
        // implementation's per-card wait and the assertions below still require exactly
        // one optional revisit.
        const result = await discovery.discover(20_000);
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
    process.platform === "win32" ? 60_000 : 30_000
  );
});

/**
 * Real-tenant discovery (Issue-09, docs/validation-log-2026-09-13-windows.md) returned 6 candidates
 * on one run and 10 with a `store-expansion-failed` warning on the very next run against the same
 * account. These fixtures reproduce, one at a time and without any real tenant, the concrete ways a
 * store card can silently drop out of one run and not another: a dialog that only opens on a second
 * click, a card that does not exist in the DOM until its list has actually scrolled to it, a card
 * that a rail re-render invalidates between marking and clicking, and a card whose dialog legitimately
 * offers nothing to click (which must stay a clean non-match, not a retried failure). The last test
 * checks the actual regression: the same account's two discoveries must return the same list, in the
 * same order.
 */
describe.skipIf(!executable)("store catalogue resilience through a real browser", () => {
  function discoveryFor(page: PageLike, origin: string) {
    const policy = new NavigationPolicy({ appHosts: ["127.0.0.1"], allowInsecureLoopback: true });
    return new AgentDiscovery({
      manager: {
        createConversationPage: async () => ({ page }),
        closePage: async () => page.close?.()
      } as unknown as BrowserManager,
      policy,
      navigator: new AgentNavigator(policy),
      appHosts: ["127.0.0.1"],
      neutralAppUrl: `${origin}/chat`,
      rowsSettleMs: 20,
      storeWaitMs: 1_000,
      storeItemWaitMs: 500,
      descriptionWaitMs: 500
    });
  }

  it("retries a store card whose dialog only opens on a second click, resolves it, and counts the retry as recovered (not partial)", async () => {
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const page = await browser.newPage();
      const origin = "http://127.0.0.1:9";
      await page.route(`${origin}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        let body = '<main>Microsoft 365 Copilot <a href="/chat/agentstore">Agent catalogue</a></main>';
        if (pathname === "/chat/agentstore") {
          body = `<main>Microsoft 365 Copilot<div role="list">
            <button onclick="handleClick()">Second Click Agent</button>
          </div></main>
          <script>
            let clicked = false;
            function handleClick() {
              if (!clicked) { clicked = true; return; }
              location.href = '/chat/agent/second-click';
            }
          </script>`;
        } else if (pathname === "/chat/agent/second-click") {
          body = "<main>Microsoft 365 Copilot<h1>Second Click Agent</h1></main>";
        }
        await route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      const discovery = discoveryFor(page as unknown as PageLike, origin);

      const result = await discovery.discover(15_000);

      expect(result.agents.some((agent) => agent.stableAgentId === "second-click")).toBe(true);
      const catalogue = result.warnings.find((line) => line.startsWith("store-catalog:"));
      expect(catalogue).toContain(
        "nav=1 dialog=0 open=0 forbidden-only=0 skipped=0 none=0 errors=0 off-host=0 more=0 retried=1" +
          " recovered=1"
      );
      // A retry that recovered the card is not a loss: no trailing " partial", no expansion tag.
      expect(catalogue?.endsWith(" partial")).toBe(false);
      expect(result.warnings.some((line) => line.startsWith("store-expansion-failed"))).toBe(false);
      expect(page.isClosed()).toBe(true);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("scrolls a store list to the card that exists only once it has actually scrolled into view", async () => {
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const page = await browser.newPage();
      const origin = "http://127.0.0.1:9";
      await page.route(`${origin}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        let body = '<main>Microsoft 365 Copilot <a href="/chat/agentstore">Agent catalogue</a></main>';
        if (pathname === "/chat/agentstore") {
          // A tall spacer keeps the list genuinely scrollable; the card itself is appended to the
          // DOM only on the list's first real scroll event, the way a virtualized tenant list
          // renders a row solely once it has scrolled into view (see MOCK_LAZY_AGENT for the same
          // idea on the sidebar rail).
          body = `<main>Microsoft 365 Copilot<div role="list" id="cards" style="display:block;max-height:60px;overflow-y:auto;">
            <div style="height:240px;"></div>
          </div></main>
          <script>
            const list = document.getElementById('cards');
            let revealed = false;
            list.addEventListener('scroll', () => {
              if (revealed) return;
              revealed = true;
              const button = document.createElement('button');
              button.style.display = 'block';
              button.style.height = '30px';
              button.textContent = 'Below Fold Agent';
              button.onclick = () => { location.href = '/chat/agent/below-fold'; };
              list.appendChild(button);
            });
          </script>`;
        } else if (pathname === "/chat/agent/below-fold") {
          body = "<main>Microsoft 365 Copilot<h1>Below Fold Agent</h1></main>";
        }
        await route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      const discovery = discoveryFor(page as unknown as PageLike, origin);

      const result = await discovery.discover(15_000);

      expect(result.agents.some((agent) => agent.stableAgentId === "below-fold")).toBe(true);
      expect(result.warnings.find((line) => line.startsWith("store-catalog:"))).toMatch(/\bscroll=[1-9]\d*/);
      expect(page.isClosed()).toBe(true);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("never resolves a card whose details dialog offers nothing but forbidden controls", async () => {
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const page = await browser.newPage();
      const actions: string[] = [];
      await page.exposeFunction("recordAction", (action: string) => actions.push(action));
      const origin = "http://127.0.0.1:9";
      await page.route(`${origin}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        let body = '<main>Microsoft 365 Copilot <a href="/chat/agentstore">Agent catalogue</a></main>';
        if (pathname === "/chat/agentstore") {
          body = `<main>Microsoft 365 Copilot<div role="list">
            <button onclick="document.getElementById('dialog').hidden=false">Forbidden Only Agent</button>
          </div>
          <div role="dialog" id="dialog" aria-label="Forbidden Only Agent" hidden>
            <button onclick="recordAction('add'); document.getElementById('dialog').hidden=true">追加</button>
            <button onclick="recordAction('close'); document.getElementById('dialog').hidden=true">閉じる</button>
          </div></main>`;
        }
        await route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      const discovery = discoveryFor(page as unknown as PageLike, origin);

      const result = await discovery.discover(15_000);

      expect(result.agents).toEqual([]);
      expect(actions).not.toContain("add");
      const catalogue = result.warnings.find((line) => line.startsWith("store-catalog:"));
      expect(catalogue).toContain("forbidden-only=1");
      // A legitimate "nothing to click here" outcome is not a failure: it must never cost a retry.
      expect(catalogue).toContain("retried=0");
      expect(page.isClosed()).toBe(true);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("recovers a card whose click target a rail re-render replaces between marking and clicking", async () => {
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const page = await browser.newPage();
      const origin = "http://127.0.0.1:9";
      await page.route(`${origin}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        let body = '<main>Microsoft 365 Copilot <a href="/chat/agentstore">Agent catalogue</a></main>';
        if (pathname === "/chat/agentstore") {
          // The observer rebuilds the list's own children -- with the same visible content and
          // click handler, but new DOM node identities -- the instant discovery's own marker
          // attribute appears, reproducing a framework re-render that lands between the card being
          // marked and the follow-up click that was meant to land on it.
          body = `<main>Microsoft 365 Copilot<div role="list" id="cards">
            <button onclick="location.href='/chat/agent/rerender-target'">Rerender Agent</button>
          </div></main>
          <script>
            const list = document.getElementById('cards');
            const cleanHtml = list.innerHTML;
            let rebuilt = false;
            const observer = new MutationObserver((mutations) => {
              if (rebuilt) return;
              for (const mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'data-agentpicklink-card') {
                  rebuilt = true;
                  list.innerHTML = cleanHtml;
                  break;
                }
              }
            });
            observer.observe(list, { attributes: true, subtree: true });
          </script>`;
        } else if (pathname === "/chat/agent/rerender-target") {
          body = "<main>Microsoft 365 Copilot<h1>Rerender Agent</h1></main>";
        }
        await route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      const discovery = discoveryFor(page as unknown as PageLike, origin);

      const result = await discovery.discover(15_000);

      expect(result.agents.some((agent) => agent.stableAgentId === "rerender-target")).toBe(true);
      expect(result.warnings.find((line) => line.startsWith("store-catalog:"))).toContain("retried=1");
      expect(page.isClosed()).toBe(true);
    } finally {
      await browser.close();
    }
  }, 20_000);

  /**
   * ISSUE-2026-09-14-01 (docs/validation-log-2026-09-14-windows.md, T3): a real tenant's "load more"
   * click timed out at the true end of a 210-item catalogue (`items=210 nav=10 skipped=200 more=2`,
   * unchanged across two runs) and was reported as `store-expansion-failed`, marking the run
   * `partial: true` even though `errors=0 none=0` -- no candidate was actually lost. These three
   * fixtures isolate `expandStore`'s post-timeout re-inspection: a control that stays visible and
   * enabled but yields nothing is the end of the list (no tag, no partial); a control whose timeout
   * coincides with items genuinely still arriving is a real failure (tag, partial, an unknown-count
   * `failedCount` of 1); and, separately, a card (not the "load more" control) that never resolves
   * even after its one bounded retry is a real, *known* loss (`none=1`).
   */
  it('an end-of-list "load more" that stays visible and enabled but yields nothing is not a failure', async () => {
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const page = await browser.newPage();
      const origin = "http://127.0.0.1:9";
      await page.route(`${origin}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        let body = '<main>Microsoft 365 Copilot <a href="/chat/agentstore">Agent catalogue</a></main>';
        if (pathname === "/chat/agentstore") {
          // The blocker sits exactly over "Show more" (never over the list) so only that control's
          // click ever times out -- the actual end-of-list symptom (a real M365 tenant's own
          // reason for the click never landing is unconfirmed; this reproduces the observable
          // TimeoutError without depending on a real tenant's specific mechanism). Nothing is ever
          // added to the list, so item counts never move.
          body = `<main>Microsoft 365 Copilot<div role="list" id="cards">
            <button onclick="location.href='/chat/agent/only-agent'">Only Agent</button>
          </div>
          <div style="position:relative;display:inline-block;">
            <button>Show more</button>
            <div style="position:absolute;inset:0;"></div>
          </div></main>`;
        } else if (pathname === "/chat/agent/only-agent") {
          body = "<main>Microsoft 365 Copilot<h1>Only Agent</h1></main>";
        }
        await route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      const discovery = discoveryFor(page as unknown as PageLike, origin);

      const result = await discovery.discover(15_000);

      expect(result.agents.some((agent) => agent.stableAgentId === "only-agent")).toBe(true);
      const catalogue = result.warnings.find((line) => line.startsWith("store-catalog:"));
      expect(catalogue).toContain("none=0 errors=0");
      expect(catalogue?.endsWith(" partial")).toBe(false);
      expect(result.warnings.some((line) => line.startsWith("store-expansion-failed"))).toBe(false);
      expect(page.isClosed()).toBe(true);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it('a "load more" timeout while items are still arriving is a real, unknown-count failure', async () => {
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const page = await browser.newPage();
      const origin = "http://127.0.0.1:9";
      await page.route(`${origin}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        let body = '<main>Microsoft 365 Copilot <a href="/chat/agentstore">Agent catalogue</a></main>';
        if (pathname === "/chat/agentstore") {
          // Same blocked "Show more" as above, but a second card is appended in the background
          // shortly after the click is attempted -- simulating content that was genuinely still
          // loading -- so the post-timeout re-inspection must see the catalogue grow and report it,
          // instead of mistaking it for the end of the list.
          body = `<main>Microsoft 365 Copilot<div role="list" id="cards">
            <button onclick="location.href='/chat/agent/first-agent'">First Agent</button>
          </div>
          <div style="position:relative;display:inline-block;">
            <button>Show more</button>
            <div style="position:absolute;inset:0;"></div>
          </div></main>
          <script>
            setTimeout(function () {
              var list = document.getElementById('cards');
              var button = document.createElement('button');
              button.textContent = 'Second Agent';
              button.onclick = function () { location.href = '/chat/agent/second-agent'; };
              list.appendChild(button);
            }, 150);
          </script>`;
        } else if (pathname === "/chat/agent/first-agent") {
          body = "<main>Microsoft 365 Copilot<h1>First Agent</h1></main>";
        } else if (pathname === "/chat/agent/second-agent") {
          body = "<main>Microsoft 365 Copilot<h1>Second Agent</h1></main>";
        }
        await route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      const discovery = discoveryFor(page as unknown as PageLike, origin);

      const result = await discovery.discover(15_000);

      expect(result.agents.some((agent) => agent.stableAgentId === "first-agent")).toBe(true);
      expect(result.agents.some((agent) => agent.stableAgentId === "second-agent")).toBe(true);
      const catalogue = result.warnings.find((line) => line.startsWith("store-catalog:"));
      expect(catalogue).toContain("none=0 errors=0");
      expect(catalogue?.endsWith(" partial")).toBe(true);
      expect(result.warnings.some((line) => line.startsWith("store-expansion-failed:"))).toBe(true);
      const completeness = summarizeDiscoveryCompleteness(result.warnings);
      expect(completeness).toEqual({ partial: true, failedCount: 1, failedCountKnown: false });
      expect(page.isClosed()).toBe(true);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("a card that never resolves even after its one bounded retry is a real, known loss (none=1)", async () => {
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const page = await browser.newPage();
      const origin = "http://127.0.0.1:9";
      await page.route(`${origin}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        let body = '<main>Microsoft 365 Copilot <a href="/chat/agentstore">Agent catalogue</a></main>';
        if (pathname === "/chat/agentstore") {
          // No onclick at all: the click itself never throws, but it never navigates and never
          // opens a dialog either, so both the first attempt and its one retry time out unresolved.
          body = `<main>Microsoft 365 Copilot<div role="list">
            <button>Stuck Agent</button>
          </div></main>`;
        }
        await route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      const discovery = discoveryFor(page as unknown as PageLike, origin);

      const result = await discovery.discover(15_000);

      expect(result.agents).toEqual([]);
      const catalogue = result.warnings.find((line) => line.startsWith("store-catalog:"));
      expect(catalogue).toContain("none=1 errors=0");
      expect(catalogue).toContain("retried=1 recovered=0");
      expect(catalogue?.endsWith(" partial")).toBe(false);
      const completeness = summarizeDiscoveryCompleteness(result.warnings);
      expect(completeness).toEqual({ partial: true, failedCount: 1, failedCountKnown: true });
      expect(page.isClosed()).toBe(true);
    } finally {
      await browser.close();
    }
  }, 20_000);
});
