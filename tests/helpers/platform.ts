import { createHash } from "node:crypto";
import path from "node:path";
import type { ProcessExec } from "../../src/broker/profile-processes.js";

/** Isolated transport address: real named pipes on Windows, Unix sockets elsewhere. */
export function testIpcEndpoint(directory: string, name = "broker.sock"): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\apl-test-${createHash("sha256").update(path.join(directory, name)).digest("hex").slice(0, 24)}`
    : path.join(directory, name);
}

/** One fake OS process for a `listProfileBrowserProcesses`/`ensureProfileBrowsersGone` fixture,
 * before it is formatted into whichever platform's listing shape `listCandidateProcesses`
 * (src/broker/profile-processes.ts) parses. */
export interface FixtureProcess {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * ISSUE-2026-09-14-13 (docs/validation-log-2026-09-14-windows-round5.md): formats `processes` the
 * way `listCandidateProcesses` will actually parse them on `platform` -- POSIX `ps
 * -axo pid=,ppid=,command=` lines, or Windows' `Get-CimInstance`/`ConvertTo-Json` rows. Defaults to
 * the REAL `process.platform` (never a pinned/spied value) so a test that does not itself pin the
 * platform still feeds the code under test whatever shape it will actually read on whichever host
 * runs the suite, instead of a fixture written for one platform silently parsed by the other
 * platform's branch -- either a raw `JSON.parse` failure or garbage pid/ppid/command fields, either
 * way surfacing as "nothing matched" rather than a loud error.
 */
export function formatProcessListing(
  processes: readonly FixtureProcess[],
  platform: NodeJS.Platform = process.platform
): { stdout: string } {
  if (platform === "win32") {
    return {
      stdout: JSON.stringify(
        processes.map((p) => ({ ProcessId: p.pid, ParentProcessId: p.ppid, CommandLine: p.command }))
      )
    };
  }
  return {
    stdout:
      processes.map((p) => `${p.pid} ${p.ppid} ${p.command}`).join("\n") + (processes.length ? "\n" : "")
  };
}

/** `formatProcessListing` wrapped as a `ProcessExec` fixture, for the common case of a fixed
 * process list handed straight to `exec`/`processExec`. Use `formatProcessListing` directly instead
 * when a test needs the listing to change between calls (e.g. a pid that "disappears" once killed). */
export function fakeProcessListing(
  processes: readonly FixtureProcess[],
  platform: NodeJS.Platform = process.platform
): ProcessExec {
  return async () => formatProcessListing(processes, platform);
}
