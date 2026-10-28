import * as vscode from "vscode";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { compareVersions } from "../services/update-checker.js";
import { downloadExtensionRelease, type ExtensionRelease } from "../services/extension-update.js";
import { readInstalledExtensionVersion } from "./installed-extension.js";
import {
  ATTESTATION_WORKFLOW,
  verifyExtensionAttestation,
  type VerifiedExtensionAttestation
} from "../services/extension-attestation.js";

/** Durable proof, in storage shared by every window, that an exact release finished installing. */
const RECEIPT_FILE = "installed-release.json";

type Receipt = { version: 2; tag: string; sha256: string; attestation: VerifiedExtensionAttestation };

const isReceipt = (value: Receipt | undefined, release: ExtensionRelease): boolean =>
  !!value && value.tag === release.tag && value.sha256 === release.sha256;

function validAttestation(
  value: unknown,
  tag: string,
  sha256: string
): value is VerifiedExtensionAttestation {
  if (!value || typeof value !== "object") return false;
  const proof = value as Record<string, unknown>;
  return (
    proof.version === 1 &&
    proof.tag === tag &&
    proof.sha256 === sha256 &&
    proof.workflow === ATTESTATION_WORKFLOW &&
    typeof proof.sourceCommit === "string" &&
    /^[a-f0-9]{40}$/.test(proof.sourceCommit) &&
    typeof proof.verifiedAt === "string" &&
    Number.isFinite(Date.parse(proof.verifiedAt))
  );
}

/** A torn, truncated or hand-edited receipt must never claim that an install happened. */
function parseReceipt(text: string): Receipt | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (
      value &&
      value.version === 2 &&
      typeof value.tag === "string" &&
      /^[A-Za-z0-9._+-]{1,100}$/.test(value.tag) &&
      typeof value.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.sha256) &&
      validAttestation(value.attestation, value.tag, value.sha256)
    )
      return { version: 2, tag: value.tag, sha256: value.sha256, attestation: value.attestation };
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
 * downloading and installing it again. The on-disk inventory must agree with the receipt before
 * it can be reused; external downgrades invalidate that proof, and newer installs are protected.
 * Unavailable installation state defers the update. Failed native installs write no receipt.
 */
export async function installExtensionRelease(
  context: vscode.ExtensionContext,
  release: ExtensionRelease,
  signal: AbortSignal,
  active: () => boolean,
  download = downloadExtensionRelease,
  installedVersionReader: (
    context: vscode.ExtensionContext
  ) => Promise<string | undefined> = readInstalledExtensionVersion,
  verify: typeof verifyExtensionAttestation = verifyExtensionAttestation
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
    // The receipt describes the install on disk, not this window's runtime, so nothing is skipped
    // or downloaded before the actual installed version is known: unknown defers, newer is protected.
    const actual = await installedVersionReader(context);
    if (!actual) return false;
    const againstRelease = compareVersions(actual, release.tag);
    if (againstRelease === undefined || againstRelease === 1) return false;
    const receipt = await readReceipt(receiptFile);
    // Reading the receipt is asynchronous: re-check cancellation before claiming anything.
    if (!enabled()) return false;
    // Exact only when the disk still holds the receipted version; a stale receipt of a version that
    // is no longer on disk (external downgrade) must not block a repair, newer or identical.
    if (receipt && isReceipt(receipt, release) && compareVersions(actual, receipt.tag) === 0) return true;
    const bytes = await download(release, signal);
    if (!enabled()) return false;
    // SHA-256 transport integrity is insufficient: installation also requires authenticated
    // provenance for these exact bytes, the official workflow, and this release tag's commit.
    const attestation = await verify(release, bytes, signal);
    if (!enabled()) return false;
    if (!validAttestation(attestation, release.tag, release.sha256))
      throw new Error("update-attestation-invalid-proof");
    directory = await mkdtemp(path.join(storage, "update-"));
    const file = path.join(directory, release.name);
    await writeFile(file, bytes, { mode: 0o600 });
    if (!enabled()) return false;
    // Another window or an external change may have moved the install while downloading.
    const after = await installedVersionReader(context);
    if (!after) return false;
    const againstAfter = compareVersions(after, release.tag);
    if (againstAfter === undefined || againstAfter === 1 || !enabled()) return false;
    await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(file));
    await writeReceipt(receiptFile, { version: 2, tag: release.tag, sha256: release.sha256, attestation });
    return true;
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } finally {
      await unlock();
    }
  }
}
