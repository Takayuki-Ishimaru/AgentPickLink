/**
 * The version actually installed on disk, as opposed to the version this extension host runs.
 *
 * VS Code's extensionsProfileScannerService keeps `<profile>/extensions.json`, whose entries carry
 * `identifier`, `version` and `relativeLocation` (or an absolute `location`). Relative locations
 * resolve against the shared extension directory, independently of the profile inventory.
 * Installing a new version replaces that entry immediately while the running extension host keeps
 * executing the old code until a reload, so cached `vscode.extensions` metadata
 * alone cannot tell an auto-update receipt whether it still matches the on-disk install.
 * Native format: https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionsProfileScannerService.ts
 */
import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compareVersions } from "../services/update-checker.js";

const EXTENSION_ID = "agentpicklink.agent-pick-link";

type InventoryEntry = {
  identifier?: { id?: unknown };
  version?: unknown;
  relativeLocation?: unknown;
  location?: unknown;
};

/** Keep inventory reads separate from payload validation so ENOENT has an unambiguous meaning. */
async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

/** The installed package folder: a single child of `parent`; a traversal is never trusted. */
function packageRoot(entry: InventoryEntry, parent: string): string | undefined {
  if (typeof entry.relativeLocation === "string") {
    if (
      !entry.relativeLocation ||
      entry.relativeLocation === "." ||
      entry.relativeLocation === ".." ||
      path.isAbsolute(entry.relativeLocation) ||
      /[\\/]/.test(entry.relativeLocation)
    )
      return undefined;
    const root = path.resolve(parent, entry.relativeLocation);
    return path.dirname(root) === path.resolve(parent) ? root : undefined;
  }
  // Without relativeLocation the scanner stores an absolute file-scheme location instead.
  const location = entry.location;
  if (
    location &&
    typeof location === "object" &&
    (location as vscode.Uri).scheme === "file" &&
    typeof (location as { path?: unknown }).path === "string"
  )
    return vscode.Uri.from(location as Parameters<typeof vscode.Uri.from>[0]).fsPath;
  return undefined;
}

async function versionFromInventory(entries: unknown, parent: string): Promise<string | undefined> {
  if (!Array.isArray(entries)) return undefined;
  const matches = entries.filter(
    (entry: InventoryEntry) =>
      typeof entry?.identifier?.id === "string" && entry.identifier.id.toLowerCase() === EXTENSION_ID
  );
  if (matches.length !== 1) return undefined;
  const entry: InventoryEntry = matches[0];
  if (typeof entry.version !== "string" || compareVersions(entry.version, entry.version) !== 0)
    return undefined;
  const root = packageRoot(entry, parent);
  if (!root) return undefined;
  const manifest = (await readJson(path.join(root, "package.json"))) as Record<string, unknown>;
  if (
    typeof manifest.publisher === "string" &&
    manifest.publisher.toLowerCase() === "agentpicklink" &&
    manifest.name === "agent-pick-link" &&
    manifest.version === entry.version
  )
    return entry.version;
  return undefined;
}

/**
 * Reads the installed version of this extension from the native profile inventory. The primary
 * inventory sits two levels above the standard `<profile>/globalStorage/<id>` storage path; only on
 * ENOENT does the legacy default-profile/extension-folder layout serve as fallback, so a malformed
 * primary or a missing target never falls back.
 */
export async function readInstalledExtensionVersion(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  try {
    const storage = context.globalStorageUri.fsPath;
    const parent = path.dirname(context.extensionUri.fsPath);
    const primary = path.resolve(storage, "../..", "extensions.json");
    if (path.basename(path.dirname(storage)) === "globalStorage") {
      let entries: unknown;
      let primaryMissing = false;
      try {
        entries = await readJson(primary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        primaryMissing = true;
      }
      // Only an absent inventory enables legacy fallback. A missing payload in a present
      // inventory is inconsistent installation state, so its validation must fail closed.
      if (!primaryMissing) return await versionFromInventory(entries, parent);
    }
    return await versionFromInventory(await readJson(path.join(parent, "extensions.json")), parent);
  } catch {
    return undefined;
  }
}
