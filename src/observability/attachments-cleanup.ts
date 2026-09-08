import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";

export type AttachmentsCleanupOptions = {
  /** Request directories older than this are removed regardless of the quota. */
  retentionHours: number;
  /** Upper bound on what the attachments tree may hold once the retention pass is done. */
  quotaBytes: number;
  /** Injectable clock (tests); defaults to Date.now(). */
  now?: number;
};

export type AttachmentsCleanupResult = {
  removedDirectories: number;
  freedBytes: number;
  remainingBytes: number;
};

/** One `<attachments>/<workspaceKey>/<requestId>/` directory and what it costs on disk. */
type RequestDirectory = { path: string; workspace: string; modifiedAt: number; bytes: number };

/**
 * Enforces the two limits on saved response attachments: `security.attachmentRetentionHours` (age)
 * and `security.attachmentQuotaBytes` (total size). Called by the broker at startup and every six
 * hours afterwards.
 *
 * The unit of deletion is one request directory (`<attachments>/<workspaceKey>/<requestId>/`),
 * never an individual file, so a saved response is either wholly present or wholly gone. Symbolic
 * links are never followed -- neither while measuring nor while deleting -- so a link planted
 * inside the attachments tree can never make this delete or measure anything outside it. Nothing
 * is logged: the caller gets the numbers back and decides whether they are worth reporting.
 */
export async function cleanupAttachments(
  directory: string,
  options: AttachmentsCleanupOptions
): Promise<AttachmentsCleanupResult> {
  const now = options.now ?? Date.now();
  const cutoff = now - options.retentionHours * 60 * 60_000;
  const { workspaces, requests } = await collectRequestDirectories(directory);

  let removedDirectories = 0;
  let freedBytes = 0;
  const kept: RequestDirectory[] = [];
  for (const request of requests) {
    if (request.modifiedAt >= cutoff) {
      kept.push(request);
      continue;
    }
    if (!(await removeDirectory(request.path))) {
      kept.push(request);
      continue;
    }
    removedDirectories++;
    freedBytes += request.bytes;
  }

  // Oldest first: a quota overrun drops the least recently written responses.
  kept.sort((left, right) => left.modifiedAt - right.modifiedAt);
  let remainingBytes = kept.reduce((total, request) => total + request.bytes, 0);
  const survivors: RequestDirectory[] = [];
  for (const request of kept) {
    if (remainingBytes <= options.quotaBytes) {
      survivors.push(request);
      continue;
    }
    if (!(await removeDirectory(request.path))) {
      survivors.push(request);
      continue;
    }
    removedDirectories++;
    freedBytes += request.bytes;
    remainingBytes -= request.bytes;
  }

  // A workspace directory that holds nothing any more goes too; rmdir refuses a non-empty one,
  // so anything unexpected in there is left alone rather than deleted.
  for (const workspace of workspaces)
    if (!survivors.some((request) => request.workspace === workspace))
      await rmdir(workspace).catch(() => undefined);

  return { removedDirectories, freedBytes, remainingBytes };
}

/** Every request directory under the attachments root, with its size and last-modified time. */
async function collectRequestDirectories(
  directory: string
): Promise<{ workspaces: string[]; requests: RequestDirectory[] }> {
  const requests: RequestDirectory[] = [];
  const workspaces = await realSubdirectories(directory);
  for (const workspace of workspaces) {
    for (const request of await realSubdirectories(workspace)) {
      const info = await lstat(request).catch(() => undefined);
      if (!info?.isDirectory()) continue;
      requests.push({
        path: request,
        workspace,
        modifiedAt: info.mtimeMs,
        bytes: await directorySize(request)
      });
    }
  }
  return { workspaces, requests };
}

/** Immediate subdirectories, excluding symbolic links (which are never followed or deleted). */
async function realSubdirectories(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(directory, entry.name));
}

/** Bytes held by real files under `directory`; symbolic links count as nothing and are not read. */
async function directorySize(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(child);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await lstat(child).catch(() => undefined);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

/** `fs.rm` recursion uses lstat, so a symlink inside the tree is unlinked, never descended into. */
async function removeDirectory(directory: string): Promise<boolean> {
  try {
    await rm(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
