import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import type { PanelState } from "../../src/extension/protocol.js";
import { candidate, setupStatus } from "./harness.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome"
].find((value): value is string => !!value && existsSync(value));

function fixture(): PanelState {
  return {
    phase: "connected",
    locale: "ja",
    version: "0.1.0",
    status: setupStatus(),
    candidates: Array.from({ length: 12 }, (_, i) =>
      candidate({
        key: `agent-${i}`,
        displayName: `エージェント ${i} — ${"長い名前".repeat(8)}`,
        description: `Microsoft 365 の説明 ${i}。${"社内の資料を参照して回答します。".repeat(8)}`,
        registered: {
          alias: `agent-${i}`,
          verified: true,
          enabled: true,
          kind: "m365-agent-builder",
          capabilityClass: "knowledge-only",
          description: "Outdated manual description"
        }
      })
    ),
    selectedKeys: ["agent-0"],
    warnings: [],
    diagnostics: [],
    incidents: [],
    integrations: { codex: false, claudeCode: false, vscodeMcpJson: false }
  };
}

describe.skipIf(!executable)("setup webview in a real browser", () => {
  let browser: Browser;
  let page: Page;
  let state: PanelState;
  const post = async (next: PanelState) => {
    await page.evaluate((value) => window.postMessage({ type: "state", state: value }, "*"), next);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  };

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: executable, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    await page?.close();
    page = await browser.newPage({ viewport: { width: 320, height: 800 } });
    await page.setContent(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>'
    );
    await page.addStyleTag({
      content: ":root { --vscode-font-family: system-ui; --vscode-font-size: 13px; }"
    });
    await page.addStyleTag({
      content: await readFile(new URL("../../media/setup.css", import.meta.url), "utf8")
    });
    await page.evaluate(() => {
      Object.assign(window, {
        sent: [],
        acquireVsCodeApi: () => ({
          postMessage: (message: unknown) => {
            (window as unknown as { sent: unknown[] }).sent.push(message);
          }
        })
      });
    });
    await page.addScriptTag({
      content: await readFile(new URL("../../media/setup.js", import.meta.url), "utf8")
    });
    state = fixture();
    await post(state);
  });

  it("distinguishes connected from configured and offers cancellation with readable progress", async () => {
    expect(await page.locator(".connection-status").innerText()).toBe("Microsoft 365 に接続済み");
    expect(await page.locator(".workspace-state").innerText()).toContain("まだ設定されていません");
    state.status!.workspace.configured = true;
    state.status!.workspace.approvalStatus = "approved";
    await post(state);
    expect(await page.locator(".connection-status").innerText()).toBe("利用可能");
    state.phase = "discovering";
    state.progress = {
      phase: "discovering",
      message: "Reading the agent store",
      elapsedMs: 12_000,
      current: 4,
      total: 211
    };
    await post(state);
    expect(await page.locator(".progress").innerText()).toBe("利用できるエージェントを確認しています (12s)");
    await page.getByRole("button", { name: "一覧の更新を中止", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { sent: unknown[] }).sent)).toContainEqual({
      type: "cancelDiscovery"
    });
    state.phase = "connected";
    state.discoverySummary = { total: 10, descriptions: 10, partial: true };
    state.diagnostics = ["store-expansion-failed:TimeoutError:locator.click"];
    await post(state);
    expect(await page.getByText("10件を表示・説明あり 10件", { exact: true }).isVisible()).toBe(true);
    expect(
      await page.getByText("store-expansion-failed:TimeoutError:locator.click", { exact: true }).count()
    ).toBe(0);
    expect(await page.locator('input[type="checkbox"]').first().isEnabled()).toBe(true);
  });

  it.each([220, 280, 340, 480, 800])(
    "keeps controls within the panel at %ipx, including expanded settings",
    async (width) => {
      await page.setViewportSize({ width, height: 800 });
      await page.getByRole("button", { name: "詳細:", exact: false }).first().click();
      await page.getByText("連携とファイルの設定", { exact: true }).click();
      await page.getByRole("button", { name: "▸ 詳細設定", exact: true }).click();
      const outside = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        return Array.from(document.querySelectorAll("button, input, textarea, select, .agent-name, .badge"))
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && (rect.left < -1 || rect.right > width + 1);
          })
          .map((node) => node.outerHTML.slice(0, 180));
      });
      expect(outside).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
      ).toBe(true);
      const layout = await page
        .locator(".agent-head")
        .first()
        .evaluate((head) => {
          const name = head.querySelector(".agent-name")!.getBoundingClientRect();
          const button = head.querySelector("button")!.getBoundingClientRect();
          return name.right <= button.left || name.bottom <= button.top;
        });
      expect(layout).toBe(true);
    }
  );

  it("does not expose an automation visibility control, including legacy visible settings", async () => {
    await post({
      ...state,
      status: { ...state.status!, config: { ...state.status!.config, headless: false } }
    });
    await page.getByRole("button", { name: "▸ 詳細設定", exact: true }).click();
    expect(await page.locator("#advanced-headless").count()).toBe(0);
  });

  it("exposes an empty download allowlist and only prefills standard hosts until Save", async () => {
    await post({
      ...state,
      status: {
        ...state.status!,
        config: { ...state.status!.config, acceptDownloads: true, downloadHosts: [] }
      }
    });
    expect(await page.locator("#download-host-hint").isVisible()).toBe(true);
    await page.getByRole("button", { name: "SharePoint・OneDriveの標準ホストを入力", exact: true }).click();
    expect(await page.locator("#download-hosts").inputValue()).toBe("*.sharepoint.com, onedrive.live.com");
    const sent = await page.evaluate(() => (window as unknown as { sent: Array<{ type: string }> }).sent);
    expect(sent.some((message) => message.type === "save" || message.type === "updateConfig")).toBe(false);
  });

  it("shows the Microsoft 365 description and sends no description override or URL action", async () => {
    expect(await page.locator(".agent-description").first().textContent()).toBe(
      state.candidates[0].description
    );
    expect(await page.getByText("Outdated manual description").count()).toBe(0);
    expect(await page.locator("#add-url").count()).toBe(0);
    await page.getByRole("button", { name: "詳細:", exact: false }).first().click();
    expect(await page.locator('[id^="desc-"]').count()).toBe(0);
    await page.locator("#save-button").click();
    const sent = await page.evaluate(
      () => (window as unknown as { sent: Array<{ type: string; plan?: { agents: unknown[] } }> }).sent
    );
    const save = sent.find((message) => message.type === "save");
    expect(save?.plan?.agents).toHaveLength(1);
    expect(save?.plan?.agents[0]).not.toHaveProperty("description");
  });

  it("retains unsaved selections, search focus and list scroll when refreshed data arrives", async () => {
    await page.locator('[id="select-agent-0"]').uncheck();
    await page.locator('[id="select-agent-1"]').check();
    await page.locator("#agent-list").evaluate((node) => {
      node.scrollTop = 180;
    });
    const before = await page.locator("#agent-list").evaluate((node) => node.scrollTop);
    state = { ...state, candidates: [...state.candidates, candidate({ key: "new-agent" })] };
    await post(state);
    expect(await page.locator('[id="select-agent-0"]').isChecked()).toBe(false);
    expect(await page.locator('[id="select-agent-1"]').isChecked()).toBe(true);
    expect(await page.locator("#agent-list").evaluate((node) => node.scrollTop)).toBe(before);
    await page.getByRole("searchbox").fill("エージェント 1");
    await post({ ...state, liveBrowser: { channel: "chrome", headless: true } });
    expect(await page.getByRole("searchbox").inputValue()).toBe("エージェント 1");
    expect(await page.getByRole("searchbox").evaluate((node) => node === document.activeElement)).toBe(true);
  });
});
