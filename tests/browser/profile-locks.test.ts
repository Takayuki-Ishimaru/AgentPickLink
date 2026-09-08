import { lstat, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isDeadLockTarget,
  PROFILE_OWNER_MARKER,
  ProfileManager
} from "../../src/transports/browser/profile-manager.js";

const OWNER_MARKER_CONTENT = "AgentPickLink for Microsoft 365 dedicated browser profile v1\n";

async function ownedProfile(): Promise<string> {
  const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-lock-"));
  await writeFile(path.join(profilePath, PROFILE_OWNER_MARKER), OWNER_MARKER_CONTENT);
  return profilePath;
}

/** A process id this machine will not have: high, and immediately probed as absent. */
function deadPid(): number {
  for (let candidate = 999_999; candidate > 100_000; candidate -= 7919) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no dead pid available");
}

describe.skipIf(process.platform === "win32")("ProfileManager stale Chromium locks", () => {
  it("removes a SingletonLock left behind by a dead browser on this host", async () => {
    const profilePath = await ownedProfile();
    const lock = path.join(profilePath, "SingletonLock");
    await symlink(`${os.hostname()}-${deadPid()}`, lock);

    await new ProfileManager(profilePath).prepare();

    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a lock held by a live process", async () => {
    const profilePath = await ownedProfile();
    const lock = path.join(profilePath, "SingletonLock");
    await symlink(`${os.hostname()}-${process.pid}`, lock);

    await new ProfileManager(profilePath).prepare();

    await expect(lstat(lock)).resolves.toBeDefined();
  });

  it("keeps a lock written by another host, and a lock that is not a symlink", async () => {
    const profilePath = await ownedProfile();
    const foreign = path.join(profilePath, "SingletonLock");
    const regular = path.join(profilePath, "lockfile");
    await symlink(`some-other-host-${deadPid()}`, foreign);
    await writeFile(regular, "not a symlink");

    await new ProfileManager(profilePath).prepare();

    await expect(lstat(foreign)).resolves.toBeDefined();
    await expect(lstat(regular)).resolves.toBeDefined();
  });
});

describe("isDeadLockTarget", () => {
  it("only accepts this host plus a process that no longer exists", () => {
    expect(isDeadLockTarget(`host-${deadPid()}`, "host")).toBe(true);
    expect(isDeadLockTarget(`host-${process.pid}`, "host")).toBe(false);
    expect(isDeadLockTarget(`other-${deadPid()}`, "host")).toBe(false);
    expect(isDeadLockTarget("host-not-a-pid", "host")).toBe(false);
    expect(isDeadLockTarget("", "host")).toBe(false);
  });
});
