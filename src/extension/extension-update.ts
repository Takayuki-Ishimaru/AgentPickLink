import * as vscode from "vscode";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { compareVersions } from "../services/update-checker.js";
import { downloadExtensionRelease, type ExtensionRelease } from "../services/extension-update.js";

/** Durable proof, in storage shared by every window, that an exact release finished installing. */
const RECEIPT_FILE = "installed-release.json";

type Receipt = { tag: string; sha256: string };

const isReceipt = (value: Receipt | undefined, release: ExtensionRelease): boolean =>
  !!value && value.tag === release.tag && value.sha256 === release.sha256;

/** A torn, truncated or hand-edited receipt must never claim that an install happened. */
function parseReceipt(text: string): Receipt | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (
      value &&
      typeof value.tag === "string" &&
      /^[A-Za-z0-9._+-]{1,100}$/.test(value.tag) &&
      typeof value.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.sha256)
    )
      return { tag: value.tag, sha256: value.sha256 };
  } catch {
    return undefined;
  }
  return undefined;
}

async function readReceipt(file: string): Promise<Receipt | undefined> {
  try {
    return parseReceipt(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Rename is atomic, so a reader never sees a half-written receipt. */
async function writeReceipt(file: string, receipt: Receipt): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * One install at a time across VS Code windows; VS Code validates the VSIX manifest itself. The
 * lock only covers the install itself, so the receipt written after each success is what tells a
 * second window that the identical release is already installed (success -> reload) instead of
 * downloading and installing it again. Every receipt read happens under the lock, so a receipt a
 * faster window wrote -- identical or newer -- is never missed. Failures write nothing and retry.
 */
export async function installExtensionRelease(
  context: vscode.ExtensionContext,
  release: ExtensionRelease,
  signal: AbortSignal,
  active: () => boolean,
  download = downloadExtensionRelease
): Promise<boolean> {
  const enabled = () => !signal.aborted && active();
  if (!enabled()) return false;
  const storage = context.globalStorageUri.fsPath;
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const receiptFile = path.join(storage, RECEIPT_FILE);
  let unlock: () => Promise<void>;
  try {
    unlock = await lockfile.lock(path.join(storage, "extension-update"), { realpath: false, retries: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return false;
    throw error;
  }
  let directory: string | undefined;
  try {
    if (!enabled()) return false;
    const receipt = await readReceipt(receiptFile);
    // Reading the receipt is asynchronous: re-check cancellation before claiming anything.
    if (!enabled()) return false;
    if (isReceipt(receipt, release)) return true;
    // A newer release is installed here: a stale window must not roll the shared install back.
    if (receipt && compareVersions(release.tag, receipt.tag) === -1) return false;
    const bytes = await download(release, signal);
    if (!enabled()) return false;
    directory = await mkdtemp(path.join(storage, "update-"));
    const file = path.join(directory, release.name);
    await writeFile(file, bytes, { mode: 0o600 });
    if (!enabled()) return false;
    await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(file));
    await writeReceipt(receiptFile, { tag: release.tag, sha256: release.sha256 });
    return true;
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } finally {
      await unlock();
    }
  }
}
