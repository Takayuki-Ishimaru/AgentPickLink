/**
 * New coverage for src/broker/profile-processes.ts's normalization work
 * (docs/validation-log-2026-09-14-windows-round5.md V2): the old exact `--user-data-dir=<profileDir>`
 * needle missed a crashpad handler's `--database=<profile>\Crashpad`, a path recorded with the
 * other slash direction, a trailing-separator mismatch, an argument wrapped in quotes, and an 8.3
 * short `%TEMP%` form. It also lowercased both sides unconditionally, which is wrong on a
 * case-sensitive POSIX filesystem.
 *
 * Kept in a separate file from tests/broker/profile-processes.test.ts (owned by a different task
 * running in parallel this round) rather than edited into it, per this task's own instructions.
 * Every test below pins `process.platform` explicitly -- never relies on the host this suite
 * happens to run on -- since the round5 failure this whole task exists to avoid was exactly a
 * platform/fixture mismatch (ISSUE-2026-09-14-13).
 */
import { describe, expect, it, vi } from "vitest";
import {
  ensureProfileBrowsersGone,
  killProfileBrowsers,
  listProfileBrowserProcesses
} from "../../src/broker/profile-processes.js";

async function withPlatform<T>(value: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(process, "platform", "get").mockReturnValue(value);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

describe("listProfileBrowserProcesses normalization (POSIX)", () => {
  it("matches a crashpad handler's --database=<profile>/Crashpad, not just --user-data-dir=", async () => {
    await withPlatform("darwin", async () => {
      const pid = 40_001;
      const exec = async () => ({
        stdout: `${pid} 1 /usr/bin/fake-msedge-crashpad --database=/tmp/agentpicklink-profile/Crashpad --monitor-self\n`
      });
      const matches = await listProfileBrowserProcesses("/tmp/agentpicklink-profile", { exec });
      expect(matches.map((match) => match.pid)).toEqual([pid]);
    });
  });

  it("never matches a directory whose name merely starts with the profile directory's name", async () => {
    await withPlatform("darwin", async () => {
      const exec = async () => ({
        stdout: "40002 1 /usr/bin/fake-msedge --user-data-dir=/tmp/agentpicklink-profile-backup\n"
      });
      const matches = await listProfileBrowserProcesses("/tmp/agentpicklink-profile", { exec });
      expect(matches).toEqual([]);
    });
  });

  it("matches even when the recorded argument carries a trailing separator the profile path lacks", async () => {
    await withPlatform("darwin", async () => {
      const pid = 40_003;
      const exec = async () => ({
        stdout: `${pid} 1 /usr/bin/fake-msedge --user-data-dir=/tmp/agentpicklink-profile/\n`
      });
      const matches = await listProfileBrowserProcesses("/tmp/agentpicklink-profile", { exec });
      expect(matches.map((match) => match.pid)).toEqual([pid]);
    });
  });

  it("matches even when the profile path passed in carries a trailing separator the recorded argument lacks", async () => {
    await withPlatform("darwin", async () => {
      const pid = 40_004;
      const exec = async () => ({
        stdout: `${pid} 1 /usr/bin/fake-msedge --user-data-dir=/tmp/agentpicklink-profile\n`
      });
      const matches = await listProfileBrowserProcesses("/tmp/agentpicklink-profile/", { exec });
      expect(matches.map((match) => match.pid)).toEqual([pid]);
    });
  });
});

describe("listProfileBrowserProcesses normalization (Windows)", () => {
  it("matches a crashpad handler's --database=<profile>\\Crashpad in a Windows CommandLine", async () => {
    await withPlatform("win32", async () => {
      const pid = 50_001;
      const exec = async () => ({
        stdout: JSON.stringify([
          {
            ProcessId: pid,
            ParentProcessId: 1,
            CommandLine:
              "msedge_crashpad_handler.exe --database=C:\\Users\\me\\AppData\\Local\\Temp\\apl-profile\\Crashpad --monitor-self-annotation=ptype=crashpad-handler"
          }
        ])
      });
      const matches = await listProfileBrowserProcesses("C:\\Users\\me\\AppData\\Local\\Temp\\apl-profile", {
        exec
      });
      expect(matches.map((match) => match.pid)).toEqual([pid]);
    });
  });

  it("matches an argument recorded with forward slashes against a profile path given with backslashes", async () => {
    await withPlatform("win32", async () => {
      const pid = 50_002;
      const exec = async () => ({
        stdout: JSON.stringify([
          {
            ProcessId: pid,
            ParentProcessId: 1,
            CommandLine: "msedge.exe --user-data-dir=C:/Users/me/profile"
          }
        ])
      });
      const matches = await listProfileBrowserProcesses("C:\\Users\\me\\profile", { exec });
      expect(matches.map((match) => match.pid)).toEqual([pid]);
    });
  });

  it("parses a quoted CommandLine argument containing a space and still matches it", async () => {
    await withPlatform("win32", async () => {
      const pid = 50_003;
      const commandLine =
        '"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" --user-data-dir="C:\\Users\\A B\\profile" --flag';
      const exec = async () => ({
        stdout: JSON.stringify([{ ProcessId: pid, ParentProcessId: 1, CommandLine: commandLine }])
      });
      const matches = await listProfileBrowserProcesses("C:\\Users\\A B\\profile", { exec });
      expect(matches.map((match) => match.pid)).toEqual([pid]);
    });
  });

  it("never matches a case-differing directory name collision the way an unconditional lowercase used to risk", async () => {
    await withPlatform("win32", async () => {
      const pid = 50_004;
      const exec = async () => ({
        stdout: JSON.stringify([
          {
            ProcessId: pid,
            ParentProcessId: 1,
            CommandLine: "msedge.exe --user-data-dir=C:\\Users\\me\\PROFILE"
          }
        ])
      });
      // Windows paths are case-insensitive, so this SHOULD still match -- case-folding is correct
      // here specifically because process.platform reports win32, not unconditionally.
      const matches = await listProfileBrowserProcesses("C:\\Users\\me\\profile", { exec });
      expect(matches.map((match) => match.pid)).toEqual([pid]);
    });
  });

  it("resolves an 8.3 short %TEMP% form to the long form via an injected resolver before matching", async () => {
    await withPlatform("win32", async () => {
      const shortProfile = "C:\\Users\\ABCDEF~1\\AppData\\Local\\Temp\\apl-profile";
      const longProfile = "C:\\Users\\someuser\\AppData\\Local\\Temp\\apl-profile";
      const pid = 50_005;
      const exec = async () => ({
        stdout: JSON.stringify([
          { ProcessId: pid, ParentProcessId: 1, CommandLine: `msedge.exe --user-data-dir=${longProfile}` }
        ])
      });
      const resolveProfilePath = (candidate: string) =>
        candidate === shortProfile ? longProfile : candidate;
      const matches = await listProfileBrowserProcesses(shortProfile, { exec, resolveProfilePath });
      expect(matches.map((match) => match.pid)).toEqual([pid]);
    });
  });

  it("without 8.3 resolution, a short-form profile path does not match a long-form command line", async () => {
    await withPlatform("win32", async () => {
      const shortProfile = "C:\\Users\\ABCDEF~1\\AppData\\Local\\Temp\\apl-profile";
      const longProfile = "C:\\Users\\someuser\\AppData\\Local\\Temp\\apl-profile";
      const exec = async () => ({
        stdout: JSON.stringify([
          { ProcessId: 50_006, ParentProcessId: 1, CommandLine: `msedge.exe --user-data-dir=${longProfile}` }
        ])
      });
      // No resolveProfilePath injected: the default realpathSync.native throws for a path that does
      // not exist on this host (this suite never runs on a real Windows filesystem), so the
      // pre-resolution short form is kept -- demonstrating why the injected resolver above matters.
      const matches = await listProfileBrowserProcesses(shortProfile, { exec });
      expect(matches).toEqual([]);
    });
  });
});

describe("killProfileBrowsers normalization", () => {
  it("kills a crashpad handler process, not just one whose command line has --user-data-dir=", async () => {
    await withPlatform("darwin", async () => {
      const killed: number[] = [];
      const processes = [
        { pid: 1, ppid: 0, command: "/usr/bin/fake-msedge-crashpad --database=/tmp/mine/Crashpad" },
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
  });

  it("never kills a process whose command line only shares a directory-name prefix with the profile", async () => {
    await withPlatform("darwin", async () => {
      const killed: number[] = [];
      const processes = [{ pid: 1, ppid: 0, command: "/usr/bin/fake --user-data-dir=/tmp/mine-backup" }];
      const count = await killProfileBrowsers("/tmp/mine", processes, {
        killProcessTree: async (pid) => {
          killed.push(pid);
        }
      });
      expect(count).toBe(0);
      expect(killed).toEqual([]);
    });
  });
});

describe("ensureProfileBrowsersGone normalization end-to-end", () => {
  it("force-kills a crashpad handler process found only via the new --database= matching", async () => {
    await withPlatform("darwin", async () => {
      const pid = 40_010;
      const logs: string[] = [];
      const killed: number[] = [];
      const exec = async () => ({
        stdout: `${pid} 1 /usr/bin/fake-msedge-crashpad --database=/tmp/stuck/Crashpad\n`
      });
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
  });
});
