import { lstat, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeLocalState } from "../../src/config/init.js";
import { appPaths } from "../../src/config/paths.js";
import { withFileLock } from "../../src/config/storage.js";

const noopLocalStatePreparer = {
  async prepareLocalState() {
    /* no browser profile to prepare in this test */
  }
};

describe("local initialization locks", () => {
  it("waits for another cold initializer while its profile preparation is in progress", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-init-concurrent-"));
    const paths = appPaths(path.join(base, "appdata"));
    let active = 0;
    let peak = 0;
    const preparer = {
      async prepareLocalState() {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 5_000 : 1_500));
        active--;
      }
    };
    const results = await Promise.allSettled([
      initializeLocalState(paths, preparer),
      initializeLocalState(paths, preparer)
    ]);
    expect(results).toEqual([
      { status: "fulfilled", value: paths },
      { status: "fulfilled", value: paths }
    ]);
    expect(peak).toBe(1);
  });

  it("can initialize inside broker election without reacquiring startup.lock", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-init-"));
    const paths = appPaths(path.join(base, "appdata"));
    await withFileLock(paths.startupLock, async () => {
      await expect(initializeLocalState(paths, noopLocalStatePreparer)).resolves.toBe(paths);
    });
  });

  it("validates existing stores without rewriting their contents on repeat init", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-init-repeat-"));
    const paths = appPaths(path.join(base, "appdata"));
    await initializeLocalState(paths, noopLocalStatePreparer);
    const before = await Promise.all(
      [paths.config, paths.registry, paths.approvals].map(async (file) => ({
        file,
        stat: await lstat(file),
        bytes: await readFile(file)
      }))
    );

    await initializeLocalState(paths, noopLocalStatePreparer);

    for (const item of before) {
      const after = await lstat(item.file);
      expect(after.ino).toBe(item.stat.ino);
      expect(await readFile(item.file)).toEqual(item.bytes);
    }
  });
});
