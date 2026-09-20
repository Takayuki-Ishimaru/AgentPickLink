/**
 * A tiny, dependency-free OS-level "make sure this pid (and, where the platform allows, its child
 * tree) is actually gone" primitive, shared by the two places that need to force through a hang
 * this codebase would otherwise wait on forever (docs/validation-log-2026-09-14-windows-round3.md
 * S2): `BrowserManager`'s bounded context-close (a half-dead browser whose `close()` never
 * settles) and `broker-staleness.ts`'s decisive restart (an old broker whose own shutdown hung,
 * plus the browser process it had launched). Both callers independently verify a pid is theirs to
 * kill *before* calling this -- this module itself makes no ownership decision, only the kill.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Best-effort, metadata-only force kill. Never throws: an already-gone pid, an insufficient
 * permission, or a missing platform tool are all exactly the outcome a caller wants to treat as
 * "nothing left to do" -- the caller re-checks liveness afterward rather than trusting this call's
 * own success.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    // /T also takes down the child tree (e.g. a browser's renderer/GPU processes under its main
    // process), which is exactly what a wedged browser or broker needs torn down completely.
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(
      () => undefined
    );
    return;
  }
  try {
    // Playwright launches the browser as its own process group leader, so signalling the negative
    // pid (the group) takes its child processes down in one call. A broker's own pid is not
    // necessarily a group leader; the ESRCH/EPERM this throws in that case falls back to a plain
    // per-pid SIGKILL below, which is still enough to stop that single process.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
