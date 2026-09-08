import { lstat, readdir, readlink, rm, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { assertSafeProfilePath } from "../../config/profile-safety.js";
import { atomicWrite, ensurePrivateDirectory, readText } from "../../config/storage.js";
import { DomainError } from "../../domain/errors.js";

export const PROFILE_OWNER_MARKER = ".agentpicklink-profile";
const PROFILE_OWNER_MARKER_CONTENT = "AgentPickLink for Microsoft 365 dedicated browser profile v1\n";

/** Validates and prepares the dedicated Edge profile location. */
export class ProfileManager {
  readonly profilePath: string;
  constructor(
    profilePath = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
      "M365AgentWorkspace",
      "browser-profile"
    )
  ) {
    this.profilePath = path.resolve(profilePath);
  }

  async prepare(): Promise<string> {
    await assertSafeProfilePath(this.profilePath);
    await ensurePrivateDirectory(this.profilePath);
    const markerPath = path.join(this.profilePath, PROFILE_OWNER_MARKER);
    const marker = await readText(markerPath);
    if (marker === undefined) {
      const entries = await readdir(this.profilePath);
      if (entries.length !== 0) {
        throw new DomainError(
          "BROWSER_PROFILE_INVALID",
          "The configured browser profile directory is non-empty and is not owned by AgentPickLink."
        );
      }
      await atomicWrite(markerPath, PROFILE_OWNER_MARKER_CONTENT);
    } else if (marker !== PROFILE_OWNER_MARKER_CONTENT) {
      throw new DomainError(
        "BROWSER_PROFILE_INVALID",
        "The configured browser profile ownership marker is invalid."
      );
    }
    await assertSafeProfilePath(this.profilePath);
    await this.clearStaleSingletonLocks();
    return this.profilePath;
  }

  /**
   * Chromium marks a profile as in use with `SingletonLock` (and, on older builds, `lockfile`):
   * a symlink whose target is `<hostname>-<pid>`. A crashed or killed browser leaves it behind and
   * the next launch fails with "user data directory is already in use", which surfaces to the user
   * as BROWSER_PROFILE_LOCKED even though nothing is running.
   *
   * Only a lock this machine can prove is dead is removed: the recorded host must be this host and
   * the recorded process must no longer exist. A lock from another host, an unreadable one, or one
   * whose process is alive is left untouched, so a genuinely running browser is never disturbed.
   * Windows uses a different (mandatory file-lock) mechanism with no such symlink; there the stale
   * lock is only reported, by mapping the launch failure to BROWSER_PROFILE_LOCKED.
   */
  private async clearStaleSingletonLocks(): Promise<void> {
    if (process.platform === "win32") return;
    for (const name of ["SingletonLock", "lockfile"]) {
      const lockPath = path.join(this.profilePath, name);
      try {
        const stats = await lstat(lockPath);
        if (!stats.isSymbolicLink()) continue;
        const target = await readlink(lockPath);
        if (!isDeadLockTarget(target)) continue;
        await unlink(lockPath);
      } catch {
        // Absent, unreadable, or removed by the real owner in the meantime: leave the profile as
        // it is and let the launch decide.
      }
    }
  }

  async verifyOwnership(): Promise<void> {
    await assertSafeProfilePath(this.profilePath);
    const marker = await readText(path.join(this.profilePath, PROFILE_OWNER_MARKER));
    if (marker !== PROFILE_OWNER_MARKER_CONTENT) {
      throw new DomainError(
        "BROWSER_PROFILE_INVALID",
        "The configured browser profile does not have a valid AgentPickLink ownership marker."
      );
    }
  }

  /** Called only after an explicit logout/reset confirmation. */
  async reset(): Promise<void> {
    try {
      await this.verifyOwnership();
    } catch {
      throw new DomainError(
        "BROWSER_PROFILE_INVALID",
        "Refusing to delete a browser profile without a valid AgentPickLink ownership marker."
      );
    }
    await rm(this.profilePath, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** `<hostname>-<pid>`, as Chromium writes it. Dead means: written by this host, for a process id
 * that no longer exists. Anything else is treated as alive (fail closed). */
export function isDeadLockTarget(target: string, hostname = os.hostname()): boolean {
  const match = /^(.+)-(\d+)$/.exec(target.trim());
  if (!match) return false;
  const [, host, pid] = match;
  if (host !== hostname) return false;
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    process.kill(id, 0);
    return false;
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists but belongs to another user -- keep the lock.
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}
