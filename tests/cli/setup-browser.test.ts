import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { startSetupServer } from "../../src/cli/setup-server/server.js";
const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome"
].find((item): item is string => !!item && existsSync(item));
it.skipIf(!executable)(
  "renders the shared page and exchanges authenticated messages under its CSP",
  async () => {
    const received = vi.fn();
    const server = await startSetupServer({
      mediaDirectory: path.resolve("media"),
      onExpired: () => undefined,
      onMessage: async (message) => {
        received(message);
        if (message.type === "ready")
          server.send({
            type: "state",
            state: {
              phase: "idle",
              candidates: [],
              selectedKeys: [],
              warnings: [],
              diagnostics: [],
              incidents: [],
              integrations: { codex: false, claudeCode: false, vscodeMcpJson: false },
              locale: "ja",
              version: "1.2.3"
            }
          });
        if (message.type === "setup") server.send({ type: "terminal", text: "端末で確認してください。" });
      }
    });
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.name));
      await page.goto(server.url);
      await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ type: "ready" }));
      await page.getByRole("button", { name: "環境をセットアップする", exact: true }).click();
      await vi.waitFor(async () =>
        expect(await page.locator("#terminal-notice").textContent()).toBe("端末で確認してください。")
      );
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        "rgb(242, 238, 245)"
      );
      await server.close();
      await vi.waitFor(async () =>
        expect(await page.locator("#terminal-notice").textContent()).toContain("終了")
      );
    } finally {
      await browser.close();
      await server.close();
    }
  },
  20_000
);
