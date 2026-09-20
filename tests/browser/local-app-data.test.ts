import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureWindowsLocalAppData } from "../../src/transports/browser/profile-manager.js";

async function freshHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "apl-local-appdata-"));
}

// docs/validation-log-2026-09-17-windows-round6.md: a USERPROFILE without AppData\Local makes
// Edge's first launch refuse remote debugging. `platform` is injected so this runs on every host.
describe("ensureWindowsLocalAppData", () => {
  it("creates <USERPROFILE>/AppData/Local when it is missing and reports the created path", async () => {
    const home = await freshHome();
    const created = await ensureWindowsLocalAppData({ platform: "win32", env: { USERPROFILE: home } });
    expect(created).toBe(path.join(home, "AppData", "Local"));
    expect((await stat(path.join(home, "AppData", "Local"))).isDirectory()).toBe(true);
  });

  it("is a no-op when the folder already exists", async () => {
    const home = await freshHome();
    await mkdir(path.join(home, "AppData", "Local"), { recursive: true });
    await writeFile(path.join(home, "AppData", "Local", "keep.txt"), "x");
    expect(
      await ensureWindowsLocalAppData({ platform: "win32", env: { USERPROFILE: home } })
    ).toBeUndefined();
    expect((await stat(path.join(home, "AppData", "Local", "keep.txt"))).isFile()).toBe(true);
  });

  it("does nothing off Windows, without USERPROFILE, or for a relative USERPROFILE", async () => {
    const home = await freshHome();
    expect(
      await ensureWindowsLocalAppData({ platform: "darwin", env: { USERPROFILE: home } })
    ).toBeUndefined();
    expect(
      await ensureWindowsLocalAppData({ platform: "linux", env: { USERPROFILE: home } })
    ).toBeUndefined();
    expect(await ensureWindowsLocalAppData({ platform: "win32", env: {} })).toBeUndefined();
    expect(
      await ensureWindowsLocalAppData({ platform: "win32", env: { USERPROFILE: "relative" } })
    ).toBeUndefined();
    await expect(stat(path.join(home, "AppData"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never throws when the folder cannot be created", async () => {
    const home = await freshHome();
    await writeFile(path.join(home, "AppData"), "a file where the directory should be");
    expect(
      await ensureWindowsLocalAppData({ platform: "win32", env: { USERPROFILE: home } })
    ).toBeUndefined();
  });
});
