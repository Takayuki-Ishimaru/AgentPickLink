import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILE_OWNER_MARKER, ProfileManager } from "../../src/transports/browser/profile-manager.js";

describe("dedicated browser profile ownership", () => {
  it("marks a new empty profile and allows only that owned profile to reset", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "apl-owned-profile-"));
    const profile = path.join(parent, "browser-profile");
    const manager = new ProfileManager(profile);
    await expect(manager.prepare()).resolves.toBe(profile);
    await expect(readFile(path.join(profile, PROFILE_OWNER_MARKER), "utf8")).resolves.toContain(
      "AgentPickLink"
    );
    await expect(manager.reset()).resolves.toBeUndefined();
  });

  it("refuses to adopt or delete a non-empty unowned directory", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "apl-unowned-profile-"));
    const sentinel = path.join(profile, "keep.txt");
    await writeFile(sentinel, "do not delete");
    const manager = new ProfileManager(profile);
    await expect(manager.prepare()).rejects.toThrow(/not owned/);
    await expect(manager.reset()).rejects.toThrow(/Refusing to delete/);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("do not delete");
  });
});
