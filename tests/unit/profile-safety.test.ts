import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeProfilePath } from "../../src/config/profile-safety.js";

describe("browser profile safety", () => {
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
});
