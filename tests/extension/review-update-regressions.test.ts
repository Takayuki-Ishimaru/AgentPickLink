import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startUpdateCheck,
  UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS
} from "../../src/extension/update-checker.js";
import { installExtensionRelease } from "../../src/extension/extension-update.js";
// These tests exercise installation/receipt behavior; cryptographic trust is covered by the
// attestation service's real signed-bundle tests.
vi.mock("../../src/services/extension-attestation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/extension-attestation.js")>();
  return {
    ...actual,
    verifyExtensionAttestation: vi.fn(async (release: { tag: string; sha256: string }) => ({
      version: 1 as const,
      tag: release.tag,
      sha256: release.sha256,
      sourceCommit: "c".repeat(40),
      workflow: actual.ATTESTATION_WORKFLOW,
      verifiedAt: new Date().toISOString()
    }))
  };
});
import { createRuntimeHarness, type RuntimeHarness } from "./harness.js";
import { resetVscodeMock, vscodeMock, window, env } from "./vscode-mock.js";

const feed = [
  {
    tag_name: "v0.1.1",
    draft: false,
    assets: [
      { name: "agent-pick-link-0.1.1.vsix", state: "uploaded", digest: `sha256:${"a".repeat(64)}`, size: 4 }
    ]
  }
];
let h: RuntimeHarness;
let d: { dispose(): void } | undefined;
let dismiss: ((value: undefined) => void) | undefined;
beforeEach(async () => {
  resetVscodeMock();
  h = await createRuntimeHarness({ language: "ja" });
});
afterEach(async () => {
  d?.dispose();
  d = undefined;
  dismiss?.(undefined);
  dismiss = undefined;
  await Promise.resolve();
  vi.restoreAllMocks();
  Reflect.deleteProperty(env, "openExternal");
  vi.useRealTimers();
  await h.dispose();
});
const dependencies = () => ({ fetch: vi.fn(async () => feed), install: vi.fn(async () => true) });
// Real temp inventory/manifest, in the legacy default-profile layout the reader falls back to.
const inventory = () => path.join(path.dirname(h.extensionRoot), "extensions.json");
async function installedOnDisk(version: string) {
  const folder = `agentpicklink.agent-pick-link-${version}`;
  await mkdir(path.join(path.dirname(h.extensionRoot), folder), { recursive: true });
  await writeFile(
    path.join(path.dirname(h.extensionRoot), folder, "package.json"),
    JSON.stringify({ publisher: "agentpicklink", name: "agent-pick-link", version })
  );
  await writeFile(
    inventory(),
    JSON.stringify([
      { identifier: { id: "agentpicklink.agent-pick-link" }, version, relativeLocation: folder }
    ])
  );
}
const retainNotification = () =>
  vi.spyOn(window, "showInformationMessage").mockImplementation(
    () =>
      new Promise((resolve) => {
        dismiss = resolve;
      })
  );

describe("independent review: actual notification lifetime and multiple windows", () => {
  it("continues six-hour checks while an earlier update notice is retained in the notification center", async () => {
    vi.useFakeTimers();
    vscodeMock.configuration.set("agentpicklink.autoUpdate", false);
    retainNotification();
    const deps = dependencies();
    d = startUpdateCheck(h.context as never, h.runtime, deps);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    // Desired public contract: check every six hours, without requiring notification dismissal.
    expect(deps.fetch).toHaveBeenCalledTimes(3);
  });

  it("applies auto-update ON immediately even when a prior manual notice is still open", async () => {
    vi.useFakeTimers();
    vscodeMock.configuration.set("agentpicklink.autoUpdate", false);
    retainNotification();
    const deps = dependencies();
    d = startUpdateCheck(h.context as never, h.runtime, deps);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    vscodeMock.configuration.set("agentpicklink.autoUpdate", true);
    vscodeMock.changeConfiguration("agentpicklink.autoUpdate");
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.install).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(deps.install).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the same successful update in a second already-open window", async () => {
    await installedOnDisk("0.1.0");
    vscodeMock.commands.set("workbench.extensions.installExtension", async (uri: unknown) =>
      installedOnDisk(
        path
          .basename((uri as { fsPath: string }).fsPath)
          .replace(/^agent-pick-link-/, "")
          .replace(/\.vsix$/, "")
      )
    );
    vi.useFakeTimers();
    const download = vi.fn(async () => Buffer.from("vsix"));
    const deps = {
      fetch: vi.fn(async () => feed),
      install: (
        context: Parameters<typeof installExtensionRelease>[0],
        release: Parameters<typeof installExtensionRelease>[1],
        signal: AbortSignal,
        active: () => boolean
      ) => installExtensionRelease(context, release, signal, active, download)
    };
    // Separate schedulers model two existing windows with the same running version and storage.
    const first = startUpdateCheck(h.context as never, h.runtime, deps);
    const other = startUpdateCheck(h.context as never, h.runtime, deps);
    d = {
      dispose: () => {
        first.dispose();
        other.dispose();
      }
    };
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    await vi.waitFor(() => expect(vscodeMock.messages).toHaveLength(1));
    // One window lost the simultaneous lock; its next scheduled check should discover the install.
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    await vi.waitFor(() => expect(vscodeMock.messages.length).toBeGreaterThanOrEqual(2));
    expect.soft(download).toHaveBeenCalledTimes(1);
    expect(
      vscodeMock.executedCommands.filter((x) => x.command === "workbench.extensions.installExtension")
    ).toHaveLength(1);
  });

  it("control: disabling during a successful download prevents any install command", async () => {
    let enabled = true;
    const release = {
      tag: "v0.1.1",
      name: "agent-pick-link-0.1.1.vsix",
      url: "https://github.com/Takayuki-Ishimaru/AgentPickLink/releases/download/v0.1.1/agent-pick-link-0.1.1.vsix",
      sha256: "a".repeat(64),
      size: 4
    };
    const download = vi.fn(async () => {
      enabled = false;
      return Buffer.from("vsix");
    });
    expect(
      await installExtensionRelease(
        h.context as never,
        release,
        new AbortController().signal,
        () => enabled,
        download
      )
    ).toBe(false);
    expect(vscodeMock.executedCommands).toHaveLength(0);
  });

  it.each(["unchanged", "disabled", "disposed", "automatic"])(
    "handles a retained manual notification action when %s",
    async (mode) => {
      vi.useFakeTimers();
      vscodeMock.configuration.set("agentpicklink.autoUpdate", false);
      let select!: (value: string | undefined) => void;
      vi.spyOn(window, "showInformationMessage")
        .mockResolvedValue(undefined)
        .mockImplementationOnce(
          () =>
            new Promise<string | undefined>((resolve) => {
              select = resolve;
            })
        );
      const open = vi.fn(async () => true);
      Object.assign(env, { openExternal: open });
      d = startUpdateCheck(h.context as never, h.runtime, dependencies());
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
      if (mode === "disposed") d.dispose();
      if (mode === "disabled" || mode === "automatic") {
        const key = mode === "disabled" ? "agentpicklink.checkForUpdates" : "agentpicklink.autoUpdate";
        vscodeMock.configuration.set(key, mode === "automatic");
        vscodeMock.changeConfiguration(key);
        await vi.advanceTimersByTimeAsync(0);
      }
      select("リリースを開く");
      await vi.advanceTimersByTimeAsync(0);
      expect(open).toHaveBeenCalledTimes(mode === "unchanged" ? 1 : 0);
    }
  );

  it("handles notification and detached reload-command failures without stopping checks", async () => {
    vi.useFakeTimers();
    vscodeMock.configuration.set("agentpicklink.autoUpdate", false);
    vi.spyOn(window, "showInformationMessage")
      .mockRejectedValueOnce(new Error("notification rejected"))
      .mockResolvedValue("再読み込み");
    const deps = dependencies();
    d = startUpdateCheck(h.context as never, h.runtime, deps);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS + UPDATE_CHECK_INTERVAL_MS);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    vscodeMock.commands.set("workbench.action.reloadWindow", () => {
      throw new Error("reload rejected");
    });
    vscodeMock.configuration.set("agentpicklink.autoUpdate", true);
    vscodeMock.changeConfiguration("agentpicklink.autoUpdate");
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.install).toHaveBeenCalledOnce();
  });

  it.each(["unchanged", "disabled", "disposed"])("handles a retained reload action when %s", async (mode) => {
    vi.useFakeTimers();
    let select!: (value: string | undefined) => void;
    vi.spyOn(window, "showInformationMessage").mockImplementationOnce(
      () =>
        new Promise<string | undefined>((resolve) => {
          select = resolve;
        })
    );
    d = startUpdateCheck(h.context as never, h.runtime, dependencies());
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    if (mode === "unchanged") await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    if (mode === "disposed") d.dispose();
    if (mode === "disabled") {
      vscodeMock.configuration.set("agentpicklink.checkForUpdates", false);
      vscodeMock.changeConfiguration("agentpicklink.checkForUpdates");
    }
    select("再読み込み");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      vscodeMock.executedCommands.filter((entry) => entry.command === "workbench.action.reloadWindow")
    ).toHaveLength(mode === "unchanged" ? 1 : 0);
  });
});

describe("v0.2.13 install completion preferences", () => {
  it.each(["checkForUpdates", "autoUpdate", "dispose"])(
    "does not create a stale reload action after %s changes during native install",
    async (setting) => {
      vi.useFakeTimers();
      let finish!: (value: boolean) => void;
      const deps = {
        fetch: vi.fn(async () => feed),
        install: vi.fn(
          () =>
            new Promise<boolean>((resolve) => {
              finish = resolve;
            })
        )
      };
      d = startUpdateCheck(h.context as never, h.runtime, deps);
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
      expect(deps.install).toHaveBeenCalledOnce();
      if (setting === "dispose") d.dispose();
      else {
        vscodeMock.configuration.set(`agentpicklink.${setting}`, false);
        vscodeMock.changeConfiguration(`agentpicklink.${setting}`);
      }
      finish(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(vscodeMock.messages).toHaveLength(0);
      expect(vscodeMock.executedCommands).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
      expect(deps.install).toHaveBeenCalledOnce();
    }
  );
});
