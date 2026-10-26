import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { commands } from "vscode";
import lockfile from "proper-lockfile";
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
// Faithful model of the on-disk install: the version changes only when the native install command
// succeeds, never after a download or install failure.
let installed = "0.1.0";
const installedVersion = async () => installed;
beforeEach(async () => {
  resetVscodeMock();
  harness = await createRuntimeHarness();
  installed = "0.1.0";
  const execute = commands.executeCommand.bind(commands);
  vi.spyOn(commands, "executeCommand").mockImplementation(async (command: string, ...args: unknown[]) => {
    const result = await execute(command, ...args);
    if (command === "workbench.extensions.installExtension") {
      installed = path
        .basename((args[0] as { fsPath: string }).fsPath)
        .replace(/^agent-pick-link-/, "")
        .replace(/\.vsix$/, "");
    }
    return result;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

const install = (
  download = vi.fn(async () => bytes),
  active = () => true,
  signal = new AbortController().signal
) => installExtensionRelease(harness.context as never, release, signal, active, download, installedVersion);
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
    // Only the intentional successful-install receipt remains; every temporary file is cleaned.
    expect(await readdir(storage())).toEqual(["installed-release.json"]);
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
    expect(installed).toBe("0.1.0");
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
    expect(await readdir(storage())).toEqual(["installed-release.json"]);
  });

  it("reuses an exact successful installation receipt without downloading again", async () => {
    const download = vi.fn(async () => bytes);
    expect(await install(download)).toBe(true);
    expect(await install(download)).toBe(true);
    expect(download).toHaveBeenCalledOnce();
    expect(vscodeMock.executedCommands).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(storage(), "installed-release.json"), "utf8"))).toMatchObject({
      tag: release.tag,
      sha256: release.sha256
    });
  });

  it.each(["{", JSON.stringify({ tag: "not-semver", sha256: "a".repeat(64) })])(
    "retries with an invalid receipt %s",
    async (receipt) => {
      await mkdir(storage(), { recursive: true });
      await writeFile(path.join(storage(), "installed-release.json"), receipt);
      const download = vi.fn(async () => bytes);
      expect(await install(download)).toBe(true);
      expect(download).toHaveBeenCalledOnce();
    }
  );

  it("does not mistake the same version with a different digest for an exact installation", async () => {
    expect(await install()).toBe(true);
    const download = vi.fn(async () => bytes);
    const different = { ...release, sha256: "b".repeat(64) };
    expect(
      await installExtensionRelease(
        harness.context as never,
        different,
        new AbortController().signal,
        () => true,
        download,
        installedVersion
      )
    ).toBe(true);
    expect(download).toHaveBeenCalledOnce();
    expect(vscodeMock.executedCommands).toHaveLength(2);
  });

  it.each([false, true])(
    "rejects an older update when the newer receipt appears %s during lock acquisition",
    async (duringLock) => {
      await mkdir(storage(), { recursive: true });
      // The newer release is on disk now: the running window's older update must not roll it back.
      installed = "0.2.0";
      const receipt = path.join(storage(), "installed-release.json");
      const newer = JSON.stringify({ tag: "v0.2.0", sha256: "b".repeat(64) });
      if (duringLock) {
        const original = lockfile.lock.bind(lockfile);
        vi.spyOn(lockfile, "lock").mockImplementationOnce(async (...args) => {
          await writeFile(receipt, newer);
          return original(...args);
        });
      } else await writeFile(receipt, newer);
      const download = vi.fn(async () => bytes);
      expect(await install(download)).toBe(false);
      expect(download).not.toHaveBeenCalled();
      expect(vscodeMock.executedCommands).toHaveLength(0);
    }
  );

  it("checks cancellation again before acknowledging an existing receipt", async () => {
    expect(await install()).toBe(true);
    const download = vi.fn(async () => bytes);
    const active = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(await install(download, active)).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(vscodeMock.executedCommands).toHaveLength(1);
  });
});
