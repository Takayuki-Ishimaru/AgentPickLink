import * as vscode from "vscode";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { downloadExtensionRelease, type ExtensionRelease } from "../services/extension-update.js";

/** One install at a time across VS Code windows; VS Code validates the VSIX manifest itself. */
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
    const bytes = await download(release, signal);
    if (!enabled()) return false;
    directory = await mkdtemp(path.join(storage, "update-"));
    const file = path.join(directory, release.name);
    await writeFile(file, bytes, { mode: 0o600 });
    if (!enabled()) return false;
    await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(file));
    return true;
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } finally {
      await unlock();
    }
  }
}
