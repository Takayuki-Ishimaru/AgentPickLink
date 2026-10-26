import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { withFileLock } from "../../src/config/storage.js";

async function tempTarget(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "apl-storage-lock-"));
  return path.join(dir, name);
}

describe("withFileLock contention budget", () => {
  it("lets a default waiter wait past 1200ms and observe the holder's committed state", async () => {
    const target = await tempTarget("state.json");
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const started = Date.now();
    let first: Promise<void>;
    try {
      first = withFileLock(target, async () => {
        firstEntered();
        await firstRelease;
        await readFile(target, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 1250));
        await writeFile(target, "updated");
      });
      await entered;
      const second = withFileLock(target, () => readFile(target, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseFirst();
      await expect(second).resolves.toBe("updated");
    } finally {
      releaseFirst();
      await first;
    }
    expect(Date.now() - started).toBeLessThan(25_000);
  }, 30_000);

  it("still fails a caller-supplied short timeout promptly while the lock is held", async () => {
    const target = await tempTarget("short-timeout.json");
    let releaseHolder!: () => void;
    const holderRelease = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      holderEntered = resolve;
    });
    let callbackRan = false;
    let holder: Promise<void>;
    // Measure the real lockfile.lock retry stage only: pre-lock directory/ACL preparation
    // must not count against the caller-supplied lock budget.
    const originalLock = lockfile.lock;
    let acquisitionMs = -1;
    let measuring = false;
    lockfile.lock = ((...args: Parameters<typeof originalLock>) => {
      const started = Date.now();
      const shouldRecord = measuring;
      const pending = originalLock(...args).finally(() => {
        if (shouldRecord) acquisitionMs = Date.now() - started;
      });
      return pending;
    }) as typeof lockfile.lock;
    try {
      holder = withFileLock(target, async () => {
        holderEntered();
        await holderRelease;
      });
      await entered;
      measuring = true;
      await expect(
        withFileLock(
          target,
          async () => {
            callbackRan = true;
            return "never";
          },
          { timeoutMs: 200 }
        )
      ).rejects.toMatchObject({ code: "ELOCKED" });
      expect(acquisitionMs).toBeGreaterThanOrEqual(150);
      expect(acquisitionMs).toBeLessThan(2_000);
      expect(callbackRan).toBe(false);
    } finally {
      lockfile.lock = originalLock;
      releaseHolder();
      await holder;
    }
  }, 30_000);

  it("releases the lock when the callback throws so the next writer succeeds", async () => {
    const target = await tempTarget("throwing.json");
    await expect(
      withFileLock(target, async () => {
        throw new Error("callback failed");
      })
    ).rejects.toThrow("callback failed");
    await expect(
      withFileLock(
        target,
        async () => {
          await readFile(target, "utf8");
          return "second";
        },
        { timeoutMs: 1_000 }
      )
    ).resolves.toBe("second");
  }, 15_000);
});
