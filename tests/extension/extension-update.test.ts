import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { commands } from "vscode";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { ExtensionRelease } from "../../src/services/extension-update.js";
import { verifyExtensionAttestation } from "../../src/services/extension-attestation.js";
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
  vi.mocked(verifyExtensionAttestation).mockClear();
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
  it.each(["missing", "invalid signature", "wrong workflow", "wrong tag", "wrong commit", "offline"])(
    "refuses installation and leaves no success receipt when attestation verification rejects %s",
    async (reason) => {
      vi.mocked(verifyExtensionAttestation).mockRejectedValueOnce(new Error(reason));
      await expect(install()).rejects.toThrow(reason);
      expect(vscodeMock.executedCommands).toHaveLength(0);
      expect(await readdir(storage())).toEqual([]);
      // A failed attempt must release the inter-window lock so a later valid proof can succeed.
      expect(await install()).toBe(true);
    }
  );

  it("checks cancellation after attestation verification and does not install", async () => {
    const controller = new AbortController();
    const verified = await vi.mocked(verifyExtensionAttestation).getMockImplementation()!(
      release,
      bytes,
      controller.signal
    );
    vi.mocked(verifyExtensionAttestation).mockImplementationOnce(async () => {
      controller.abort();
      return verified;
    });
    expect(await install(undefined, () => true, controller.signal)).toBe(false);
    expect(vscodeMock.executedCommands).toHaveLength(0);
    expect(await readdir(storage())).toEqual([]);
  });

  it.each([
    { tag: "v9.9.9" },
    { sha256: "b".repeat(64) },
    { workflow: ".github/workflows/other.yml" },
    { sourceCommit: "missing" },
    { version: 0 }
  ])("refuses inconsistent verification receipts instead of installing: %j", async (change) => {
    const original = await vi.mocked(verifyExtensionAttestation).getMockImplementation()!(
      release,
      bytes,
      new AbortController().signal
    );
    vi.mocked(verifyExtensionAttestation).mockResolvedValueOnce({
      ...original,
      ...change
    } as typeof original);
    await expect(install()).rejects.toThrow("update-attestation-invalid-proof");
    expect(vscodeMock.executedCommands).toHaveLength(0);
    expect(await readdir(storage())).toEqual([]);
  });

  it("does not reuse an older digest-only success receipt without verifying provenance", async () => {
    installed = "0.1.1";
    await mkdir(storage(), { recursive: true });
    const legacy = JSON.stringify({ tag: release.tag, sha256: release.sha256 });
    await writeFile(path.join(storage(), "installed-release.json"), legacy);
    vi.mocked(verifyExtensionAttestation).mockRejectedValueOnce(new Error("no proof"));
    await expect(install()).rejects.toThrow("no proof");
    expect(verifyExtensionAttestation).toHaveBeenCalledOnce();
    expect(vscodeMock.executedCommands).toHaveLength(0);
    expect(await readFile(path.join(storage(), "installed-release.json"), "utf8")).toBe(legacy);
  });

  it("passes the exact downloaded bytes and caller cancellation to mandatory verification", async () => {
    const controller = new AbortController();
    expect(await install(undefined, () => true, controller.signal)).toBe(true);
    expect(verifyExtensionAttestation).toHaveBeenCalledExactlyOnceWith(release, bytes, controller.signal);
    const receipt = JSON.parse(await readFile(path.join(storage(), "installed-release.json"), "utf8"));
    expect(receipt).toMatchObject({
      version: 2,
      tag: release.tag,
      sha256: release.sha256,
      attestation: {
        version: 1,
        sourceCommit: "c".repeat(40),
        workflow: ".github/workflows/release-build.yml"
      }
    });
  });
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
    expect(verifyExtensionAttestation).toHaveBeenCalledOnce();
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
