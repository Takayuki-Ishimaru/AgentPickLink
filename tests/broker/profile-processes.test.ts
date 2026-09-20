/**
 * src/broker/profile-processes.ts: the process-tree check behind
 * docs/validation-log-2026-09-14-windows-round4.md U2's fix -- see that module's own doc comment
 * for what counts as "a browser process of this profile" and why the old release criteria (pid
 * gone, `SingletonLock`/`lockfile` gone) were not enough on Windows. The POSIX path is exercised
 * with real, disposable child processes (this suite runs on macOS: "you can exercise real child
 * processes for liveness"); the Windows path is exercised through a fake `exec` under a
 * `process.platform` spy, since this suite never actually runs on Windows.
 *
 * ISSUE-2026-09-14-13 (docs/validation-log-2026-09-14-windows-round5.md): every test below pins
 * `process.platform` (via this file's own `pinPlatform` helper) for the duration of whichever
 * fixture format it uses -- without it, the code under test reads `process.platform` from the real
 * host running the suite, not from the platform the fixture was written for, so a POSIX `ps`-line
 * fixture running on an actual Windows host (or vice versa) fed the wrong branch entirely.
 */
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureProfileBrowsersGone,
  killProfileBrowsers,
  listProfileBrowserProcesses,
  waitForProfileBrowsersGone
} from "../../src/broker/profile-processes.js";

/** Real, disposable child processes so a "still alive, then gone" transition is genuine -- mirrors
 * tests/services/broker-staleness.test.ts's own `spawnDisposableProcess`. Spawning/killing a real
 * child process (and checking its liveness with `process.kill(pid, 0)`) is a genuine OS operation
 * that never consults the `process.platform` spy below, so these stay valid liveness fixtures
 * regardless of which platform a given test pins for its `exec` fixture's own format. */
const spawnedPids: number[] = [];
function spawnDisposableProcess(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  spawnedPids.push(child.pid!);
  return child.pid!;
}

/** ISSUE-2026-09-14-13 (docs/validation-log-2026-09-14-windows-round5.md): every fixture below
 * represents one specific platform's `exec` output shape (POSIX `ps` lines or Windows'
 * `Get-CimInstance`/`ConvertTo-Json`), so `process.platform` must be pinned for the duration of
 * that test -- otherwise a Windows host takes the JSON branch against POSIX text (a raw parse
 * error) while a POSIX host takes the `ps`-line branch against JSON (garbage pid/ppid/command
 * fields), and either way the fixture no longer means what the test says it means. Restored here,
 * in the shared `afterEach`, rather than per-test `try`/`finally`, so a thrown assertion never
 * leaves a later test running under the wrong platform.
 */
let platformSpy: ReturnType<typeof vi.spyOn> | undefined;
function pinPlatform(platform: NodeJS.Platform): void {
  platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone -- the point of this sweep */
    }
  }
  platformSpy?.mockRestore();
  platformSpy = undefined;
});

describe("listProfileBrowserProcesses (POSIX)", () => {
  it("shells out to `ps -axo pid=,ppid=,command=` and matches a process by --user-data-dir= in its own command line", async () => {
    pinPlatform("linux");
    const pid = spawnDisposableProcess();
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args });
      return {
        stdout: `${pid} 1 /usr/bin/fake-msedge --user-data-dir=/tmp/agentpicklink-profile --headless\n`
      };
    };
    const matches = await listProfileBrowserProcesses("/tmp/agentpicklink-profile", { exec });
    expect(matches.map((match) => match.pid)).toEqual([pid]);
    expect(calls).toEqual([{ file: "ps", args: ["-axo", "pid=,ppid=,command="] }]);
  });

  it("matches a process only by being a descendant of browserPid, even without --user-data-dir in its own command line", async () => {
    pinPlatform("linux");
    const rootPid = 50_101;
    const childPid = 50_102;
    const grandchildPid = 50_103;
    const unrelatedPid = 50_104;
    const exec = async () => ({
      stdout:
        `${rootPid} 1 /usr/bin/fake-msedge --user-data-dir=/tmp/whatever\n` +
        `${childPid} ${rootPid} /usr/bin/fake-msedge-renderer\n` +
        `${grandchildPid} ${childPid} /usr/bin/fake-msedge-gpu\n` +
        `${unrelatedPid} 1 /usr/bin/unrelated-process\n`
    });
    const matches = await listProfileBrowserProcesses("/tmp/whatever", { exec, browserPid: rootPid });
    expect(new Set(matches.map((match) => match.pid))).toEqual(new Set([rootPid, childPid, grandchildPid]));
  });

  it("never matches a foreign browser process that neither names this profile nor descends from browserPid", async () => {
    pinPlatform("linux");
    const exec = async () => ({
      stdout: "77777 1 /usr/bin/fake-msedge --user-data-dir=/tmp/someone-elses-profile\n"
    });
    const matches = await listProfileBrowserProcesses("/tmp/agentpicklink-profile", { exec });
    expect(matches).toEqual([]);
  });

  it("shells out to Get-CimInstance Win32_Process, filtering by name and selecting ProcessId/ParentProcessId/CommandLine, on Windows", async () => {
    pinPlatform("win32");
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args });
      return {
        stdout: JSON.stringify([
          { ProcessId: 111, ParentProcessId: 1, CommandLine: "msedge.exe --user-data-dir=C:\\profile" },
          { ProcessId: 222, ParentProcessId: 111, CommandLine: "msedge.exe --type=renderer" }
        ])
      };
    };
    const matches = await listProfileBrowserProcesses("C:\\profile", { exec, browserPid: 111 });
    expect(new Set(matches.map((match) => match.pid))).toEqual(new Set([111, 222]));
    expect(calls).toHaveLength(1);
    const [{ file, args }] = calls;
    expect(file).toBe("powershell.exe");
    // Argument-array form throughout -- no untrusted value (the profile path, a pid) is ever
    // interpolated into the PowerShell script text itself; only the fixed filter/selection is.
    expect(args[0]).toBe("-NoProfile");
    expect(args[1]).toBe("-NonInteractive");
    expect(args[2]).toBe("-Command");
    expect(args).toHaveLength(4);
    expect(args[3]).toContain("Get-CimInstance Win32_Process");
    expect(args[3]).toContain("Name='msedge.exe' OR Name='chrome.exe'");
    expect(args[3]).toContain("ProcessId,ParentProcessId,CommandLine");
    expect(args[3]).not.toContain("C:\\profile");
  });
});

describe("waitForProfileBrowsersGone", () => {
  it("returns immediately, with nothing remaining, once nothing matches", async () => {
    const exec = async () => ({ stdout: "" });
    const start = Date.now();
    const remaining = await waitForProfileBrowsersGone("/tmp/nope", { exec, timeoutMs: 2_000, pollMs: 50 });
    expect(remaining).toEqual([]);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("polls until a matched process disappears within the bound", async () => {
    pinPlatform("linux");
    const pid = spawnDisposableProcess();
    let stillThere = true;
    setTimeout(() => {
      stillThere = false;
    }, 60);
    const exec = async () => ({
      stdout: stillThere ? `${pid} 1 /usr/bin/fake --user-data-dir=/tmp/x\n` : ""
    });
    const remaining = await waitForProfileBrowsersGone("/tmp/x", { exec, timeoutMs: 2_000, pollMs: 20 });
    expect(remaining).toEqual([]);
  });

  it("returns whatever is still alive once the bound elapses, without killing anything itself", async () => {
    pinPlatform("linux");
    const pid = spawnDisposableProcess();
    const exec = async () => ({ stdout: `${pid} 1 /usr/bin/fake --user-data-dir=/tmp/x\n` });
    const remaining = await waitForProfileBrowsersGone("/tmp/x", { exec, timeoutMs: 60, pollMs: 20 });
    expect(remaining.map((match) => match.pid)).toEqual([pid]);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  // Windows-format counterparts of the two POSIX-fixture tests above, so the win32 `exec` branch
  // gets the same real-liveness coverage on every host -- spawning/killing a real child process and
  // checking it with `process.kill(pid, 0)` are genuine OS operations, unaffected by the
  // `process.platform` spy (see spawnDisposableProcess's own doc comment above).
  it("polls until a matched process disappears within the bound, on Windows (CIM JSON fixture)", async () => {
    pinPlatform("win32");
    const pid = spawnDisposableProcess();
    let stillThere = true;
    setTimeout(() => {
      stillThere = false;
    }, 60);
    const exec = async () => ({
      stdout: JSON.stringify(
        stillThere
          ? [{ ProcessId: pid, ParentProcessId: 1, CommandLine: "msedge.exe --user-data-dir=C:\\x" }]
          : []
      )
    });
    const remaining = await waitForProfileBrowsersGone("C:\\x", { exec, timeoutMs: 2_000, pollMs: 20 });
    expect(remaining).toEqual([]);
  });

  it("returns whatever is still alive once the bound elapses, without killing anything itself, on Windows (CIM JSON fixture)", async () => {
    pinPlatform("win32");
    const pid = spawnDisposableProcess();
    const exec = async () => ({
      stdout: JSON.stringify([
        { ProcessId: pid, ParentProcessId: 1, CommandLine: "msedge.exe --user-data-dir=C:\\x" }
      ])
    });
    const remaining = await waitForProfileBrowsersGone("C:\\x", { exec, timeoutMs: 60, pollMs: 20 });
    expect(remaining.map((match) => match.pid)).toEqual([pid]);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });
});

describe("killProfileBrowsers", () => {
  it("kills only the process whose own command line names the profile directory, never one that only matched by descending from browserPid", async () => {
    pinPlatform("linux");
    const killed: number[] = [];
    const processes = [
      { pid: 1, ppid: 0, command: "/usr/bin/fake --user-data-dir=/tmp/mine" },
      { pid: 2, ppid: 1, command: "/usr/bin/fake-renderer" }
    ];
    const count = await killProfileBrowsers("/tmp/mine", processes, {
      killProcessTree: async (pid) => {
        killed.push(pid);
      }
    });
    expect(count).toBe(1);
    expect(killed).toEqual([1]);
  });

  it("never kills a foreign browser process, even when it is a msedge/chrome process", async () => {
    pinPlatform("linux");
    const killed: number[] = [];
    const processes = [{ pid: 1, ppid: 0, command: "/usr/bin/fake --user-data-dir=/tmp/someone-elses" }];
    const count = await killProfileBrowsers("/tmp/mine", processes, {
      killProcessTree: async (pid) => {
        killed.push(pid);
      }
    });
    expect(count).toBe(0);
    expect(killed).toEqual([]);
  });
});

describe("ensureProfileBrowsersGone", () => {
  it("logs the elapsed-time line and kills nothing when the tree is already gone", async () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const exec = async () => ({ stdout: "" });
    await ensureProfileBrowsersGone("/tmp/gone", {
      exec,
      killProcessTree: async (pid) => {
        killed.push(pid);
      },
      log: (line) => logs.push(line)
    });
    expect(killed).toEqual([]);
    expect(logs).toEqual([expect.stringMatching(/^broker: browser tree for profile gone after \d+ms$/)]);
  });

  it("force-kills and logs a count when the bound elapses with a process still matching", async () => {
    pinPlatform("linux");
    const pid = 314_159;
    const logs: string[] = [];
    const killed: number[] = [];
    const exec = async () => ({ stdout: `${pid} 1 /usr/bin/fake-msedge --user-data-dir=/tmp/stuck\n` });
    await ensureProfileBrowsersGone("/tmp/stuck", {
      exec,
      timeoutMs: 40,
      pollMs: 10,
      killProcessTree: async (p) => {
        killed.push(p);
      },
      log: (line) => logs.push(line)
    });
    expect(killed).toEqual([pid]);
    expect(logs).toEqual(["broker: force-killed 1 browser processes of the profile"]);
  });

  // Windows-format counterpart, matching this file's own convention (the "shells out to
  // Get-CimInstance..." test above) of a fake numeric pid for the win32 branch -- Windows liveness
  // is never exercised with a real spawned process in this suite (this suite never actually runs on
  // Windows), only the CIM JSON parsing/matching path.
  it("force-kills and logs a count when the bound elapses with a process still matching, on Windows (CIM JSON fixture)", async () => {
    pinPlatform("win32");
    const pid = 314_159;
    const logs: string[] = [];
    const killed: number[] = [];
    const exec = async () => ({
      stdout: JSON.stringify([
        { ProcessId: pid, ParentProcessId: 1, CommandLine: "msedge.exe --user-data-dir=C:\\stuck" }
      ])
    });
    await ensureProfileBrowsersGone("C:\\stuck", {
      exec,
      timeoutMs: 40,
      pollMs: 10,
      killProcessTree: async (p) => {
        killed.push(p);
      },
      log: (line) => logs.push(line)
    });
    expect(killed).toEqual([pid]);
    expect(logs).toEqual(["broker: force-killed 1 browser processes of the profile"]);
  });
});
