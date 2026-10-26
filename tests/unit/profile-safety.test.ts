import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeProfilePath } from "../../src/config/profile-safety.js";

describe("browser profile safety", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("rejects a normal Edge User Data tree", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-profile-safety-"));
    await expect(
      assertSafeProfilePath(path.join(base, "Microsoft", "Edge", "User Data", "Default"))
    ).rejects.toMatchObject({ code: "BROWSER_PROFILE_INVALID" });
  });
  it("rejects UNC locations before touching the filesystem", async () => {
    await expect(assertSafeProfilePath("\\\\server\\share\\profile")).rejects.toMatchObject({
      code: "BROWSER_PROFILE_INVALID"
    });
  });
  it("rejects known cloud-synchronized profile locations", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-profile-safety-"));
    await expect(
      assertSafeProfilePath(path.join(base, "OneDrive - Example", "browser-profile"))
    ).rejects.toMatchObject({ code: "BROWSER_PROFILE_INVALID" });
  });

  it.each(["nested", "..private"])(
    "rejects a %s subdirectory of an environment-declared sync root",
    async (name) => {
      const base = await mkdtemp(path.join(os.tmpdir(), "apl-profile-safety-"));
      vi.stubEnv("OneDrive", path.join(base, "synced"));
      await expect(
        assertSafeProfilePath(path.join(base, "synced", name, "browser-profile"))
      ).rejects.toMatchObject({ code: "BROWSER_PROFILE_INVALID" });
    }
  );

  it("accepts a local sibling that only shares the sync root's name prefix", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-profile-safety-"));
    vi.stubEnv("OneDrive", path.join(base, "synced"));
    await expect(
      assertSafeProfilePath(path.join(base, "synced-backup", "browser-profile"))
    ).resolves.toBeUndefined();
  });
});
