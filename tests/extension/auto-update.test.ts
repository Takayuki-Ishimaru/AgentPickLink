import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startUpdateCheck,
  UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS
} from "../../src/extension/update-checker.js";
import { createRuntimeHarness, logText, type RuntimeHarness } from "./harness.js";
import { answerWith, resetVscodeMock, vscodeMock } from "./vscode-mock.js";

const feed = [
  {
    tag_name: "v0.1.1",
    draft: false,
    assets: [
      { name: "agent-pick-link-0.1.1.vsix", state: "uploaded", digest: `sha256:${"a".repeat(64)}`, size: 1 }
    ]
  }
];
let harness: RuntimeHarness;
let disposable: { dispose(): void };
const deps = () => ({
  fetch: vi.fn(async (_signal: AbortSignal): Promise<unknown> => feed),
  install: vi.fn(async () => true)
});

beforeEach(async () => {
  resetVscodeMock();
  harness = await createRuntimeHarness({ language: "ja" });
  vi.useFakeTimers();
});
afterEach(async () => {
  disposable?.dispose();
  vi.useRealTimers();
  await harness.dispose();
});

function start(options = deps()) {
  disposable = startUpdateCheck(harness.context as never, harness.runtime, options);
  return options;
}

describe("automatic extension updates", () => {
  it("defaults to enabled, installs after startup and waits for an explicit reload", async () => {
    const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(manifest.contributes.configuration.properties["agentpicklink.autoUpdate"]).toMatchObject({
      default: true,
      scope: "application"
    });
    const options = start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS - 1);
    expect(options.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(options.install).toHaveBeenCalledOnce();
    expect(vscodeMock.messages[0].message).toContain("v0.1.1 に更新しました");
    expect(vscodeMock.executedCommands).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(options.install).toHaveBeenCalledOnce();
  });

  it("reloads only when the completion notification action is selected", async () => {
    answerWith("再読み込み");
    start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(vscodeMock.executedCommands).toEqual([{ command: "workbench.action.reloadWindow", args: [] }]);
  });

  it("keeps notifications once per version when automatic installation is disabled", async () => {
    vscodeMock.configuration.set("agentpicklink.autoUpdate", false);
    const options = start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS + UPDATE_CHECK_INTERVAL_MS);
    expect(options.install).not.toHaveBeenCalled();
    expect(vscodeMock.messages).toHaveLength(1);
    expect(vscodeMock.messages[0].message).toContain("が公開されています");
  });

  it("respects the existing release-check opt-out and re-enables checks immediately", async () => {
    vscodeMock.configuration.set("agentpicklink.checkForUpdates", false);
    const options = start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(options.fetch).not.toHaveBeenCalled();
    vscodeMock.configuration.set("agentpicklink.checkForUpdates", true);
    vscodeMock.changeConfiguration("agentpicklink.checkForUpdates");
    await vi.advanceTimersByTimeAsync(0);
    expect(options.install).toHaveBeenCalledOnce();
  });

  it("enables installation from the sidebar preference without restarting VS Code", async () => {
    vscodeMock.configuration.set("agentpicklink.autoUpdate", false);
    const options = start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    vscodeMock.configuration.set("agentpicklink.autoUpdate", true);
    vscodeMock.changeConfiguration("agentpicklink.autoUpdate");
    await vi.advanceTimersByTimeAsync(0);
    expect(options.install).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "disposed"])("cancels an in-flight fetch when %s without installing", async (mode) => {
    let resolve!: (value: unknown) => void;
    const options = deps();
    options.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    start(options);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    const signal = options.fetch.mock.calls[0][0];
    if (mode === "disposed") disposable.dispose();
    else {
      vscodeMock.configuration.set("agentpicklink.checkForUpdates", false);
      vscodeMock.changeConfiguration("agentpicklink.checkForUpdates");
    }
    expect(signal.aborted).toBe(true);
    resolve(feed);
    await vi.advanceTimersByTimeAsync(0);
    expect(options.install).not.toHaveBeenCalled();
    expect(vscodeMock.messages).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(options.fetch).toHaveBeenCalledOnce();
  });

  it("retries failed installations at the next interval without claiming success", async () => {
    const options = deps();
    options.install.mockRejectedValueOnce(new Error("offline"));
    start(options);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(vscodeMock.messages).toHaveLength(0);
    expect(logText()).toContain("will retry later");
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(options.install).toHaveBeenCalledTimes(2);
    expect(vscodeMock.messages[0].message).toContain("に更新しました");
  });

  it("keeps checks single-flight across rapid configuration changes", async () => {
    let resolve!: (value: unknown) => void;
    const options = deps();
    options.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    start(options);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    for (const enabled of [false, true, false, true]) {
      vscodeMock.configuration.set("agentpicklink.autoUpdate", enabled);
      vscodeMock.changeConfiguration("agentpicklink.autoUpdate");
    }
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(options.fetch).toHaveBeenCalledOnce();
    resolve(feed);
    await vi.advanceTimersByTimeAsync(1);
    expect(options.fetch).toHaveBeenCalledTimes(2);
    expect(options.install).toHaveBeenCalledOnce();
  });
});
