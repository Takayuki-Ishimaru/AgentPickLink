import { readFile, readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installExtensionRelease } from "../../src/extension/extension-update.js";
import type { ExtensionRelease } from "../../src/services/extension-update.js";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.js";
import { resetVscodeMock, vscodeMock } from "./vscode-mock.js";

let harness: RuntimeHarness;
const release: ExtensionRelease = {
  tag: "v0.1.1",
  name: "agent-pick-link-0.1.1.vsix",
  url: "https://github.com/Takayuki-Ishimaru/AgentPickLink/releases/download/v0.1.1/agent-pick-link-0.1.1.vsix",
  size: 4,
  sha256: "a".repeat(64)
};
const bytes = Buffer.from("vsix");
beforeEach(async () => {
  resetVscodeMock();
  harness = await createRuntimeHarness();
});
afterEach(async () => {
  await harness.dispose();
});

const install = (
  download = vi.fn(async () => bytes),
  active = () => true,
  signal = new AbortController().signal
) => installExtensionRelease(harness.context as never, release, signal, active, download);
const storage = () => harness.context.globalStorageUri.fsPath;

describe("VS Code VSIX installation", () => {
  it("honors cancellation independently of the preference callback", async () => {
    const controller = new AbortController();
    const download = vi.fn(async () => {
      controller.abort();
      return bytes;
    });
    expect(await install(download, () => true, controller.signal)).toBe(false);
    expect(vscodeMock.executedCommands).toHaveLength(0);
    expect(await readdir(storage())).toEqual([]);
  });
  it("passes a local verified VSIX URI to VS Code and removes temporary files afterwards", async () => {
    let installedBytes: Buffer | undefined;
    vscodeMock.commands.set("workbench.extensions.installExtension", async (uri: unknown) => {
      installedBytes = await readFile((uri as { fsPath: string }).fsPath);
    });
    expect(await install()).toBe(true);
    expect(installedBytes).toEqual(bytes);
    expect(vscodeMock.executedCommands[0].command).toBe("workbench.extensions.installExtension");
    expect(await readdir(storage())).toEqual([]);
  });

  it("skips download and installation when disabled", async () => {
    const download = vi.fn(async () => bytes);
    expect(await install(download, () => false)).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(vscodeMock.executedCommands).toHaveLength(0);
  });

  it("does not install when disabled while downloading, and releases the lock", async () => {
    let active = true;
    const download = vi.fn(async () => {
      active = false;
      return bytes;
    });
    expect(await install(download, () => active)).toBe(false);
    expect(vscodeMock.executedCommands).toHaveLength(0);
    expect(await readdir(storage())).toEqual([]);
    expect(await install()).toBe(true);
  });

  it.each(["download", "install"])("cleans up after a %s failure and allows retries", async (failure) => {
    const download = vi.fn(async () => bytes);
    if (failure === "download") download.mockRejectedValueOnce(new Error("offline"));
    else
      vscodeMock.commands.set("workbench.extensions.installExtension", () => {
        throw new Error("rejected");
      });
    await expect(install(download)).rejects.toThrow();
    expect(await readdir(storage())).toEqual([]);
    vscodeMock.commands.delete("workbench.extensions.installExtension");
    expect(await install()).toBe(true);
  });

  it("prevents concurrent windows from downloading or installing the same update at once", async () => {
    let resolve!: (data: Buffer) => void;
    const download = vi.fn(
      () =>
        new Promise<Buffer>((done) => {
          resolve = done;
        })
    );
    const first = install(download);
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    const secondDownload = vi.fn(async () => bytes);
    expect(await install(secondDownload)).toBe(false);
    expect(secondDownload).not.toHaveBeenCalled();
    resolve(bytes);
    expect(await first).toBe(true);
    expect(vscodeMock.executedCommands).toHaveLength(1);
    expect(await readdir(storage())).toEqual([]);
  });
});
