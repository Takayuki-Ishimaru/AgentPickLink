import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import type { PanelState, SavePlanInput } from "../../src/extension/protocol.js";
import { buildApplyPlan } from "../../src/extension/plan.js";
import { candidate, setupStatus } from "./harness.js";
import { DOWNLOAD_HOST_VECTORS } from "./download-host-vectors.js";

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

  it("updates completion, count and save availability for 0 → 1 → 2 → 0 without replacing the list", async () => {
    await page.locator('[id="select-agent-0"]').uncheck();
    await page.locator(".completion-section summary").click();
    await page.getByRole("searchbox").fill("エージェント");
    const list = await page.locator("#agent-list").elementHandle();
    await page.locator("#agent-list").evaluate((node) => {
      node.scrollTop = 180;
    });
    const scroll = await page.locator("#agent-list").evaluate((node) => node.scrollTop);
    for (const count of [0, 1, 2, 0]) {
      // Dispatch the same change event without scrolling checkboxes into view.
      await page.evaluate((count) => {
        for (let i = 0; i < 2; i++) {
          const checkbox = document.getElementById(`select-agent-${i}`) as HTMLInputElement;
          checkbox.checked = i < count;
          checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, count);
      expect(await page.locator("#agent-count").innerText()).toBe(`エージェント (${count} 選択中)`);
      expect(await page.locator("#completion-selection").innerText()).toBe(
        count ? `${count} 件を選択` : "未確認"
      );
      expect(await page.locator("#save-button").isEnabled()).toBe(count > 0);
      expect(await list!.evaluate((node) => node === document.getElementById("agent-list"))).toBe(true);
      expect(await page.locator("#agent-list").evaluate((node) => node.scrollTop)).toBe(scroll);
      expect(
        await page.locator(".completion-section").evaluate((node) => (node as HTMLDetailsElement).open)
      ).toBe(true);
      expect(await page.getByRole("searchbox").inputValue()).toBe("エージェント");
      expect(await page.getByRole("searchbox").evaluate((node) => node === document.activeElement)).toBe(
        true
      );
    }
  });

  it.each(["complete", "partial", "not-selected"] as const)(
    "replaces stale %s client completion with unsaved status immediately and until save completes",
    async (clientApplication) => {
      await post({ ...state, phase: "done", clientApplication });
      await page.locator(".completion-section summary").click();
      await page.getByText("連携とファイルの設定", { exact: true }).click();
      await page.locator("#integration-codex").check();
      expect(await page.locator("#completion-clients").innerText()).toBe("未保存の変更あり");
      await post({ ...state, phase: "done", clientApplication });
      expect(await page.locator("#completion-clients").innerText()).toBe("未保存の変更あり");
      await page.locator("#save-button").click();
      await post({ ...state, phase: "saving", clientApplication });
      expect(await page.locator("#completion-clients").innerText()).toBe("未保存の変更あり");
      await post({
        ...state,
        phase: "done",
        clientApplication: "complete",
        integrations: { ...state.integrations, codex: true }
      });
      expect(await page.locator("#completion-clients").innerText()).toBe("確認済み");
    }
  );
  const sentSaves = async () =>
    (await page.evaluate(() => (window as unknown as { sent: Array<{ type: string; plan?: unknown }> }).sent))
      .filter((message) => message.type === "save")
      .map((message) => message.plan as SavePlanInput);
  const hostFeedback = () =>
    page.evaluate(() => ({
      hosts: (document.getElementById("download-host-preview")?.getAttribute("data-hosts") ?? "")
        .split(",")
        .filter(Boolean),
      invalid: Array.from(document.querySelectorAll("#download-host-feedback li")).map((node) => ({
        value: node.getAttribute("data-value"),
        problem: node.getAttribute("data-problem")
      }))
    }));

  // APL-REVIEW-04: the live check must reach the same verdict as the host's checkDownloadHosts().
  it.each(DOWNLOAD_HOST_VECTORS)("checks download hosts like the host does: $text", async (vector) => {
    await page.getByText("連携とファイルの設定", { exact: true }).click();
    await page.locator("#download-hosts").fill(vector.text);
    expect(await hostFeedback()).toEqual({ hosts: vector.hosts, invalid: vector.invalid });
  });

  it("explains an unusable download host next to the field and blocks Save until it is fixed", async () => {
    await page.getByText("連携とファイルの設定", { exact: true }).click();
    await page.locator("#download-hosts").fill("https://bad host/");
    expect(await page.locator("#download-host-feedback .field-error").innerText()).toContain(
      "「https://bad host/」: 空白を含んでいます"
    );
    expect(await page.locator("#download-host-preview").innerText()).toBe("保存されるホストはありません");
    expect(await page.locator("#save-button").isEnabled()).toBe(false);
    expect(await page.locator("#save-blocked-note").isVisible()).toBe(true);
    // A state refresh re-renders the panel; the verdict and the typed text must survive it.
    await post({ ...state, liveBrowser: { channel: "chrome", headless: true } });
    expect(await page.locator("#download-hosts").inputValue()).toBe("https://bad host/");
    expect(await page.locator("#save-button").isEnabled()).toBe(false);

    await page.locator("#download-hosts").fill("https://Files.Example.com/docs, *.sharepoint.com");
    expect(await page.locator("#download-host-feedback .field-error").count()).toBe(0);
    expect(await page.locator("#download-host-preview").innerText()).toBe(
      "保存されるホスト: *.sharepoint.com, files.example.com"
    );
    expect(await page.locator("#save-blocked-note").isVisible()).toBe(false);
    await page.locator("#save-button").click();
    expect((await sentSaves()).at(-1)?.downloadHosts).toEqual([
      "https://Files.Example.com/docs",
      "*.sharepoint.com"
    ]);
  });

  it("shows a typed value verbatim even when it contains replacement patterns", async () => {
    await page.getByText("連携とファイルの設定", { exact: true }).click();
    await page.locator("#download-hosts").fill("bad $& $' host");
    expect(await page.locator("#download-host-feedback li").innerText()).toBe(
      "「bad $& $' host」: 空白を含んでいます"
    );
  });

  it("opens the settings to show the host's refusal, only while the field holds the submitted text", async () => {
    await post({
      ...state,
      status: { ...state.status!, config: { ...state.status!.config, downloadHosts: ["files.example.com"] } }
    });
    expect(await page.locator(".options-section").evaluate((node) => (node as HTMLDetailsElement).open)).toBe(
      false
    );
    await page.locator("#save-button").click();
    await post({
      ...state,
      status: { ...state.status!, config: { ...state.status!.config, downloadHosts: ["files.example.com"] } },
      downloadHostIssues: [{ value: "files.example.com", problem: "invalid-host" }]
    });
    expect(await page.locator(".options-section").evaluate((node) => (node as HTMLDetailsElement).open)).toBe(
      true
    );
    expect(await page.locator("#download-host-feedback .field-error").innerText()).toContain(
      "「files.example.com」: ホスト名に使えない文字または形式です"
    );
    expect(await page.locator("#save-button").isEnabled()).toBe(false);
    await page.locator("#download-hosts").fill("files.example.com, other.example.com");
    expect(await page.locator("#download-host-feedback .field-error").count()).toBe(0);
    expect(await page.locator("#save-button").isEnabled()).toBe(true);
  });

  // APL-REVIEW-03: what the panel submits for an agent registered with OLD_HINT, and what the plan
  // builder makes of it (apply() and the read-back are covered in tests/unit/setup-service.test.ts).
  it.each([
    ["unedited", undefined, "OLD_HINT"],
    ["changed", "NEW_HINT", "NEW_HINT"],
    ["cleared", "", ""]
  ] as const)("submits a %s usage hint as the user left it", async (_case, typed, planned) => {
    const hinted: PanelState = {
      ...state,
      candidates: state.candidates.map((entry, index) =>
        index === 0 ? { ...entry, registered: { ...entry.registered!, usageHint: "OLD_HINT" } } : entry
      )
    };
    await post(hinted);
    await page.getByRole("button", { name: "詳細:", exact: false }).first().click();
    const field = page.locator('[id="usage-agent-0"]');
    expect(await field.inputValue()).toBe("OLD_HINT");
    if (typed !== undefined) await field.fill(typed);
    await page.locator("#save-button").click();
    const submitted = (await sentSaves()).at(-1)!;
    expect(submitted.agents[0]).toMatchObject({ key: "agent-0", usageHint: typed ?? "OLD_HINT" });
    const { plan } = buildApplyPlan(submitted, hinted.candidates);
    expect(plan.agents[0].usageHint).toBe(planned);
  });
});
