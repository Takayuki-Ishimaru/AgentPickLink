/**
 * docs/validation-log-2026-09-14-windows-round4.md U2: after a stale broker is "fully released" by
 * every signal this codebase previously checked (descriptor gone, its own OS pid gone, the profile's
 * `SingletonLock`/`lockfile` symlink gone -- see broker-staleness.ts's `waitForBrokerFullyReleased`),
 * the browser process tree that broker launched can still be mid-shutdown. On Windows this is
 * decisive: Chromium's `lockfile` there is a mandatory file lock whose *handle* is released on exit
 * but whose *path* is never removed, so `isBrowserProfileLockPresent`'s existence check says nothing
 * either way, and the still-shutting-down old Edge process makes a brand new Edge launch against the
 * same `--user-data-dir` block on Chromium's own ProcessSingleton (headless: no dialog, so it just
 * waits) until Playwright's own `startupTimeoutMs` gives up.
 *
 * This module is the one place that answers "is any browser process of this specific profile still
 * alive right now": a process counts as belonging to a profile directory when it is either (a) the
 * broker's own recorded `browserPid` (BrokerDescriptor.browserPid, src/ipc/protocol.ts) or one of its
 * descendants -- a renderer/GPU/utility child does not always repeat every switch its parent was
 * launched with, so command-line matching alone would miss it -- or (b) any process anywhere whose
 * command line names this exact profile directory via `--user-data-dir=<profileDir>`, independent of
 * parentage, since a process this host can no longer place in a known tree (e.g. re-parented to init
 * after its own parent already exited) still holds the same OS-level lock. Every helper here matches
 * by full command line, never by executable name alone -- a `ps`/`Win32_Process` listing is every
 * process on the host, and only the profile path (or the descendant relation) proves a given
 * msedge/chrome pid is *this* AgentPickLink profile's browser rather than some unrelated window.
 *
 * Reused from three call sites that all need exactly this "wait, then force through, logging counts
 * only" sequence: `broker-staleness.ts`'s decisive restart phase, `browser-manager.ts`'s bounded
 * close path (a settled `close()` does not itself prove the OS process tree is gone), and
 * `install.ts`'s one-shot retry-after-restart recovery.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { killProcessTree as defaultKillProcessTree } from "./process-kill.js";

const execFileAsync = promisify(execFile);

/** Injectable process listing primitive. Tests replace this with a fake so none of this ever has to
 * shell out for real, except where the codebase's own convention (docs/validation-log-2026-09-14-
 * windows-round4.md: "on macOS you can exercise real child processes for liveness") exercises real,
 * disposable child processes against the real default instead. */
export type ProcessExec = (file: string, args: string[]) => Promise<{ stdout: string }>;

async function defaultExec(file: string, args: string[]): Promise<{ stdout: string }> {
  return execFileAsync(file, args, { windowsHide: true });
}

export interface ProfileProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

/** Every live msedge/chrome-family process this platform can enumerate, unfiltered by profile --
 * callers below narrow it. Windows: `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR
 * Name='chrome.exe'"` via `execFile("powershell.exe", […])` with the filter/selection baked into the
 * fixed `-Command` argument -- no untrusted value (a profile path, a pid) is ever interpolated into
 * the PowerShell script text itself. POSIX: `ps -axo pid=,ppid=,command=` (every process on the
 * host, matching `findChildBrowserPid`/`defaultIsProfileOwnerProcess`'s own approach elsewhere in
 * this codebase), since a POSIX child's own executable name is not guaranteed to still read
 * "chrome"/"msedge" the way Windows' same-binary child processes do. */
async function listCandidateProcesses(exec: ProcessExec): Promise<ProfileProcessInfo[]> {
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | " +
        "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"
    ]);
    const parsed: unknown = JSON.parse(stdout || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const result: ProfileProcessInfo[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const { ProcessId, ParentProcessId, CommandLine } = row as {
        ProcessId?: number;
        ParentProcessId?: number;
        CommandLine?: string;
      };
      if (typeof ProcessId === "number")
        result.push({
          pid: ProcessId,
          ppid: typeof ParentProcessId === "number" ? ParentProcessId : -1,
          command: CommandLine ?? ""
        });
    }
    return result;
  }
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,command="]);
  const result: ProfileProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pidText, ppidText, command] = match;
    result.push({ pid: Number(pidText), ppid: Number(ppidText), command });
  }
  return result;
}

export interface ListProfileBrowserProcessesOptions {
  /** BrokerDescriptor.browserPid, captured before the owning broker's shutdown was requested --
   * see this module's own doc comment for why its descendant tree counts even when a given child's
   * own command line does not repeat `--user-data-dir`. */
  browserPid?: number;
  exec?: ProcessExec;
  /** Windows only: resolves the profile path's 8.3 short form (a `%TEMP%` directory in particular)
   * to its long form before matching, via `fs.realpathSync.native` by default -- see this module's
   * own doc comment (ISSUE-2026-09-14, round5 V2) for why a miss here matters. Injectable so tests
   * never need a real Windows filesystem to exercise it. A resolution failure (the path is already
   * gone, or this host cannot resolve it at all) is caught by the caller and simply keeps the
   * pre-resolution form -- this is a best-effort improvement, never required for a match to work. */
  resolveProfilePath?: (profilePath: string) => string;
}

function defaultResolveProfilePath(profilePath: string): string {
  return realpathSync.native(profilePath);
}

/**
 * Normalizes a profile directory path for matching against process command lines: resolves it to
 * an absolute, normalized form using the *target* platform's own path rules (`path.win32`/
 * `path.posix`, never the ambient `path` export, which follows whatever OS actually runs this
 * process -- this stays correct when a test pins `process.platform` to exercise the other
 * platform's fixtures on this host), strips a trailing separator, and case-folds on Windows only
 * (POSIX filesystems are case-sensitive, so folding there would be a false-match risk, not a fix).
 * On Windows this also resolves an 8.3 short form (`%TEMP%\ABCDEF~1`) to its long form so a command
 * line recorded with either form still matches. Never throws.
 */
function normalizeProfilePathForMatch(
  profileDir: string,
  resolveProfilePath: (profilePath: string) => string = defaultResolveProfilePath
): string {
  const isWindows = process.platform === "win32";
  const p = isWindows ? path.win32 : path.posix;
  let resolved = p.resolve(profileDir);
  if (isWindows) {
    try {
      resolved = resolveProfilePath(resolved);
    } catch {
      // Not on disk right now (already cleaned up), or this host cannot resolve it (a fixture in a
      // test never runs on a real Windows filesystem) -- the pre-resolution form is still a valid,
      // if less robust, match target.
    }
  }
  return normalizeForMatch(resolved, isWindows);
}

/** Keep the path passed to the browser as well as its resolved Windows long form.
 * Resolving only the match target otherwise loses processes launched with an 8.3 argument. */
function profilePathMatchTargets(
  profileDir: string,
  resolveProfilePath?: (profilePath: string) => string
): string[] {
  return [
    ...new Set([
      normalizeProfilePathForMatch(profileDir, resolveProfilePath),
      normalizeProfilePathForMatch(profileDir, (value) => value)
    ])
  ];
}

/** Trims a single layer of surrounding quotes, unifies slash direction on Windows only (backslash
 * is a legal POSIX filename character, never a separator, so POSIX values are left alone), strips
 * a trailing separator, and case-folds on Windows only. Shared by the profile path itself
 * (`normalizeProfilePathForMatch` above) and every command-line argument it is compared against
 * (`commandNamesProfile` below), so both sides of every match go through exactly the same
 * transform. */
function normalizeForMatch(value: string, isWindows: boolean): string {
  let v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  if (isWindows) return v.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return v.replace(/\/+$/, "");
}

/** Quote-aware tokenizer for the two command-line shapes this module ever sees: a Windows
 * `CommandLine` (one string where a value containing a space -- a profile directory, most often --
 * is wrapped in double quotes) and a POSIX `ps` command string (already space-joined with no
 * quoting this host can recover). Never throws. */
function splitCommandLineArguments(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

/** True when `needle` (already normalized) appears in `haystack` at a real path boundary -- end of
 * string, or immediately followed by a separator -- so `/tmp/agentpicklink-profile` matches
 * `--user-data-dir=/tmp/agentpicklink-profile` and its crashpad handler's
 * `--database=/tmp/agentpicklink-profile/Crashpad`, but never an unrelated
 * `/tmp/agentpicklink-profile-backup` (a bare substring match would wrongly hit that too). */
function includesAtPathBoundary(haystack: string, needle: string, isWindows: boolean): boolean {
  if (!needle) return false;
  const idx = haystack.indexOf(needle);
  if (idx === -1) return false;
  const next = haystack[idx + needle.length];
  if (next === undefined) return true;
  return isWindows ? next === "\\" : next === "/";
}

/**
 * True when `command` names `profileNeedle` (already normalized by `normalizeProfilePathForMatch`)
 * in any argument -- the profile's own `--user-data-dir=<dir>`, its crashpad handler's
 * `--database=<dir>\Crashpad`, or any other flag this or a future Chromium build records it under --
 * or, failing that, anywhere in the whole command string (a POSIX `ps` command string cannot be
 * split into arguments this host can recover when a path contains an unquoted space, so the per-
 * argument check alone would miss it; the pre-existing behavior checked the whole string for
 * exactly this reason, so this keeps doing that as a fallback rather than a regression).
 */
function commandNamesProfile(command: string, profileNeedle: string): boolean {
  const isWindows = process.platform === "win32";
  for (const rawArg of splitCommandLineArguments(command)) {
    if (includesAtPathBoundary(normalizeForMatch(rawArg, isWindows), profileNeedle, isWindows)) return true;
  }
  return includesAtPathBoundary(normalizeForMatch(command, isWindows), profileNeedle, isWindows);
}

/**
 * Every currently-running process this host considers part of `profileDir`'s browser right now: see
 * this module's doc comment for the two ways a process qualifies. Never throws its own errors past a
 * failed `exec` -- see callers, which already treat a listing failure as "nothing confirmed" rather
 * than let it wedge a bounded wait.
 */
export async function listProfileBrowserProcesses(
  profileDir: string,
  options: ListProfileBrowserProcessesOptions = {}
): Promise<ProfileProcessInfo[]> {
  const exec = options.exec ?? defaultExec;
  const all = await listCandidateProcesses(exec);
  const byPpid = new Map<number, ProfileProcessInfo[]>();
  for (const proc of all) {
    const siblings = byPpid.get(proc.ppid);
    if (siblings) siblings.push(proc);
    else byPpid.set(proc.ppid, [proc]);
  }
  const matched = new Map<number, ProfileProcessInfo>();
  const queue: number[] = [];
  if (options.browserPid !== undefined) {
    const root = all.find((proc) => proc.pid === options.browserPid);
    if (root) {
      matched.set(root.pid, root);
      queue.push(root.pid);
    }
  }
  while (queue.length > 0) {
    const parentPid = queue.shift()!;
    for (const child of byPpid.get(parentPid) ?? []) {
      if (matched.has(child.pid)) continue;
      matched.set(child.pid, child);
      queue.push(child.pid);
    }
  }
  const needles = profilePathMatchTargets(profileDir, options.resolveProfilePath);
  for (const proc of all) {
    if (matched.has(proc.pid)) continue;
    if (needles.some((needle) => commandNamesProfile(proc.command, needle))) matched.set(proc.pid, proc);
  }
  return [...matched.values()];
}

export interface WaitForProfileBrowsersGoneOptions extends ListProfileBrowserProcessesOptions {
  timeoutMs?: number;
  pollMs?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
const DEFAULT_WAIT_POLL_MS = 250;

/** Bounded wait for `listProfileBrowserProcesses` to report nothing left. Returns whatever is still
 * alive once the bound elapses (empty when everything cleared on its own) so the caller can decide
 * whether to force through -- this function itself never kills anything. A listing failure is
 * treated as "still there" (fails closed) rather than a false all-clear. */
export async function waitForProfileBrowsersGone(
  profileDir: string,
  options: WaitForProfileBrowsersGoneOptions = {}
): Promise<ProfileProcessInfo[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_WAIT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let remaining: ProfileProcessInfo[] = await listProfileBrowserProcesses(profileDir, options).catch(() => [
    { pid: -1, ppid: -1, command: "" }
  ]);
  for (;;) {
    if (remaining.length === 0) return remaining;
    if (Date.now() >= deadline) return remaining;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    remaining = await listProfileBrowserProcesses(profileDir, options).catch(() => remaining);
  }
}

/**
 * Force-kills only the processes in `processes` whose own command line actually names `profileDir`
 * (via `--user-data-dir=`, a crashpad handler's `--database=`, or any other argument naming the
 * profile directory -- see `commandNamesProfile`) -- never one that matched
 * `listProfileBrowserProcesses` only by being a descendant of a known `browserPid`, and never a
 * foreign browser: this is the one place in this module that actually terminates something, so it
 * re-checks the stricter of the two match rules before doing so. Each match is killed with
 * `killProcessTree` (src/broker/process-kill.js), which already takes its own child tree down
 * (process-group signal on POSIX, `taskkill /T` on Windows), so a matched child process needs no
 * separate kill of its own. Returns the number actually targeted. Never throws.
 */
export async function killProfileBrowsers(
  profileDir: string,
  processes: readonly ProfileProcessInfo[],
  options: {
    killProcessTree?: (pid: number) => Promise<void>;
    resolveProfilePath?: (profilePath: string) => string;
  } = {}
): Promise<number> {
  const kill = options.killProcessTree ?? defaultKillProcessTree;
  const needles = profilePathMatchTargets(profileDir, options.resolveProfilePath);
  const targets = processes.filter((proc) =>
    needles.some((needle) => commandNamesProfile(proc.command, needle))
  );
  await Promise.all(targets.map((proc) => kill(proc.pid).catch(() => undefined)));
  return targets.length;
}

export interface EnsureProfileBrowsersGoneOptions extends WaitForProfileBrowsersGoneOptions {
  killProcessTree?: (pid: number) => Promise<void>;
  /** Metadata-only log sink: elapsed time or a kill count, never a profile path or command line. */
  log?: (line: string) => void;
}

/**
 * The full "wait, then force through, log exactly one metadata-only line either way" sequence shared
 * by `broker-staleness.ts` (the decisive restart phase), `browser-manager.ts` (its bounded close
 * path), and `install.ts` (the one-shot retry-after-restart recovery) -- see this module's own doc
 * comment. Never throws.
 */
export async function ensureProfileBrowsersGone(
  profileDir: string,
  options: EnsureProfileBrowsersGoneOptions = {}
): Promise<void> {
  const log = options.log ?? ((): void => undefined);
  const start = Date.now();
  const remaining = await waitForProfileBrowsersGone(profileDir, options);
  if (remaining.length === 0) {
    log(`broker: browser tree for profile gone after ${Date.now() - start}ms`);
    return;
  }
  const killed = await killProfileBrowsers(profileDir, remaining, options);
  log(`broker: force-killed ${killed} browser processes of the profile`);
}
