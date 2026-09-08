import { mkdir, mkdtemp, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupAttachments } from "../../src/observability/attachments-cleanup.js";

const HOUR = 60 * 60_000;

describe("saved attachment retention and quota", () => {
  it("removes request directories past the retention and drops the empty workspace with them", async () => {
    const now = Date.parse("2026-09-05T12:00:00.000Z");
    const root = await mkdtemp(path.join(os.tmpdir(), "apl-attachment-cleanup-"));
    await requestDirectory(root, "workspace-old", "req-old", 1_000, now - 200 * HOUR);
    await requestDirectory(root, "workspace-new", "req-new", 2_000, now - 2 * HOUR);

    const result = await cleanupAttachments(root, { retentionHours: 168, quotaBytes: 1024 * 1024, now });

    expect(result).toEqual({ removedDirectories: 1, freedBytes: 1_000, remainingBytes: 2_000 });
    // The workspace directory that held only the expired request is gone too.
    expect((await readdir(root)).sort()).toEqual(["workspace-new"]);
  });

  it("deletes the oldest request directories until the tree is back under the quota", async () => {
    const now = Date.parse("2026-09-05T12:00:00.000Z");
    const root = await mkdtemp(path.join(os.tmpdir(), "apl-attachment-quota-"));
    await requestDirectory(root, "workspace", "req-1-oldest", 4_000, now - 5 * HOUR);
    await requestDirectory(root, "workspace", "req-2-middle", 4_000, now - 3 * HOUR);
    await requestDirectory(root, "workspace", "req-3-newest", 4_000, now - 1 * HOUR);

    const result = await cleanupAttachments(root, { retentionHours: 168, quotaBytes: 9_000, now });

    // 12 000 bytes held, 9 000 allowed: exactly the oldest directory goes.
    expect(result).toEqual({ removedDirectories: 1, freedBytes: 4_000, remainingBytes: 8_000 });
    expect((await readdir(path.join(root, "workspace"))).sort()).toEqual(["req-2-middle", "req-3-newest"]);
  });

  it("keeps everything, and reports what it holds, when both limits are satisfied", async () => {
    const now = Date.parse("2026-09-05T12:00:00.000Z");
    const root = await mkdtemp(path.join(os.tmpdir(), "apl-attachment-keep-"));
    await requestDirectory(root, "workspace", "req-1", 512, now - 1 * HOUR);
    await requestDirectory(root, "workspace", "req-2", 512, now - 2 * HOUR);

    await expect(
      cleanupAttachments(root, { retentionHours: 168, quotaBytes: 1024 * 1024, now })
    ).resolves.toEqual({ removedDirectories: 0, freedBytes: 0, remainingBytes: 1_024 });
  });

  it("never follows a symbolic link, neither when measuring nor when deleting", async () => {
    const now = Date.parse("2026-09-05T12:00:00.000Z");
    const root = await mkdtemp(path.join(os.tmpdir(), "apl-attachment-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "apl-attachment-outside-"));
    await writeFile(path.join(outside, "precious.pdf"), Buffer.alloc(8_000, 1));
    // A link planted where a workspace directory would be, and one inside an expired request.
    await symlink(outside, path.join(root, "linked-workspace"), "dir");
    const expired = await requestDirectory(root, "workspace", "req-old", 100, now);
    await symlink(outside, path.join(expired, "linked"), "dir");
    // Stamped last: adding the link would otherwise make the directory look freshly written.
    await utimes(expired, new Date(now - 400 * HOUR), new Date(now - 400 * HOUR));

    const result = await cleanupAttachments(root, { retentionHours: 168, quotaBytes: 1024, now });

    // The linked tree was neither counted nor deleted; only the real request directory went.
    expect(result).toEqual({ removedDirectories: 1, freedBytes: 100, remainingBytes: 0 });
    expect(await readdir(outside)).toEqual(["precious.pdf"]);
    expect((await readdir(root)).sort()).toEqual(["linked-workspace"]);
  });

  it("reports nothing to do for an attachments directory that does not exist yet", async () => {
    const root = path.join(await mkdtemp(path.join(os.tmpdir(), "apl-attachment-missing-")), "attachments");
    await expect(cleanupAttachments(root, { retentionHours: 168, quotaBytes: 1024 })).resolves.toEqual({
      removedDirectories: 0,
      freedBytes: 0,
      remainingBytes: 0
    });
  });
});

/** One `<attachments>/<workspaceKey>/<requestId>/` directory holding a file of the given size. */
async function requestDirectory(
  root: string,
  workspace: string,
  requestId: string,
  bytes: number,
  modifiedAt: number
): Promise<string> {
  const directory = path.join(root, workspace, requestId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "report.pdf"), Buffer.alloc(bytes, 7));
  await utimes(directory, new Date(modifiedAt), new Date(modifiedAt));
  return directory;
}
