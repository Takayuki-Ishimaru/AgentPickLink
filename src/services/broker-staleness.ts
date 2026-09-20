/**
 * The staleness decision behind the extension's post-Save and activation-time broker restart
 * (`restartBrokerIfStale`, formerly in `src/extension/broker.ts:176-220`): a broker keeps running
 * as a detached process across extension updates or archive installs, so its running build (entry
 * file + mtime) or its live browser configuration can differ from what the caller now expects.
 * This module never spawns a broker -- it only decides whether the currently running one should
 * be asked to shut down, so the caller's own next connect-or-start spawns a fresh one. It is
 * host-agnostic (no `vscode` import) so the CLI can reuse it; the extension calls it through a
 * thin adapter in `src/extension/broker.ts` that maps `ExtensionRuntime` onto
 * `BrokerStalenessContext`.
 */
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { readDescriptor } from "../broker/broker-descriptor.js";
import {
  connectExistingBroker,
  isExpectedBrokerProcess,
  waitForDescriptorGone
} from "../broker/broker-lifecycle.js";
import { killProcessTree } from "../broker/process-kill.js";
import { ensureProfileBrowsersGone, type ProcessExec } from "../broker/profile-processes.js";
import type { AppPaths } from "../config/paths.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { readText } from "../config/storage.js";
import type { InstallJson } from "./install-home.js";
import type { IpcClient } from "../ipc/client.js";
import type { BrokerBuild } from "../ipc/protocol.js";

const BROKER_HEALTH_TIMEOUT_MS = 5_000;

/** The slice of `BrokerHealthSnapshot.browser` (src/extension/broker.ts) this decision needs. */
type BrokerBrowserHealth = { channel: string; headless: boolean };

/** What `restartBrokerIfStale` needs from its caller: the paths a broker install shares, the
 * entry file this caller was built from, a place to log metadata-only lines, and (§4.7 C13)
 * optionally the version this caller expects the running broker to be. */
export type BrokerStalenessContext = {
  paths: AppPaths;
  brokerEntry: string;
  log: (line: string) => void;
  /**
   * §4.7 C13: "compares the running broker's `packageVersion` + `build` against `install.json`,
   * never against the caller's own copy." When given, staleness-by-build is judged by comparing
   * the running broker descriptor's `packageVersion` (and, if given, `build`) against these values
   * directly -- no `stat()` of `brokerEntry` at all. This is more than a style choice: `install-
   * home.ts`'s `stageVersion()` copies each `app/<version>` with a plain `fs.copyFile`, which does
   * not preserve the source's mtime, so the same version staged twice (e.g. by two entry points
   * racing to converge on the same `install.json`) can carry two different "time of staging"
   * mtimes for byte-identical code -- a false positive for the mtime-based heuristic below.
   * Comparing `packageVersion` is exact where mtime is only ever a heuristic, and needs no broker
   * entry file to exist locally at all (the caller may not have `<home>/app/<version>` staged on
   * disk to `stat()` in the first place -- see `LazyBrokerPort`, whose `serve` command is spawned
   * directly by `bin/apl.js` and never touches `install-home.ts` itself). When omitted, the
   * previous behaviour is unchanged: `stat(brokerEntry)` is compared against the descriptor's
   * `build` (entry path + mtime) -- this is what every extension call site (`src/extension/
   * broker.ts`) still does, because the extension always has its own `dist/broker/process.js` (or
   * the machine install's) locally resolvable and wants to detect drift from *that specific file*,
   * version metadata or not.
   */
  expected?: { packageVersion: string; build?: BrokerBuild };
  /** ISSUE-06 (docs/validation-log-2026-09-14-windows.md), round 3's S2: overrides for the polite
   * bounded wait `restartBrokerIfStale` performs after asking a stale broker to shut down, before
   * the decisive force-kill phase takes over -- see `waitForBrokerFullyReleased`'s doc comment.
   * Defaults to 8s/5s (`timeoutMs`/`forceKillGraceMs`), polling every 250ms; a test shrinks these so
   * a "lingers then disappears"/timeout/force-kill scenario runs in milliseconds instead of real
   * seconds. */
  releaseWait?: ReleaseWaitOptions;
};

/** Overrides for `waitForBrokerFullyReleased`'s bounded phases -- see its doc comment.
 * `browserTreeTimeoutMs`/`browserTreePollMs` govern the final phase (docs/validation-log-2026-09-14-
 * windows-round4.md U2): once the old broker's own pid is confirmed gone, this is how long to wait
 * for its browser process tree to disappear too before force-killing whatever remains. `exec`
 * overrides the process-listing primitive that phase uses (src/broker/profile-processes.ts) -- tests
 * inject a fake so none of this ever has to shell out for real; left unset, it shells out to the
 * real `ps`/`Win32_Process`, which is harmless in practice because none of this suite's temporary
 * profile directories or fixture pids ever match a real running browser. */
export type ReleaseWaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
  forceKillGraceMs?: number;
  browserTreeTimeoutMs?: number;
  browserTreePollMs?: number;
  exec?: ProcessExec;
};

/**
 * §4.7 C13: the `expected` every entry point passes when a machine install exists -- the running
 * broker is judged against `install.json`'s version, never against the caller's own copy, so the
 * archive and the VSIX stop restarting each other's broker. Shared (rather than spelled out at
 * each call site) precisely because the two callers disagreeing is the bug this closes: `serve`
 * (`LazyBrokerPort`'s `defaultBrokerStalenessCheck`) and the extension's activation-time check
 * must produce byte-identical expectations. `undefined` when there is no machine install, which
 * leaves `restartBrokerIfStale` on its previous mtime-based heuristic.
 */
export function stalenessExpectationFrom(
  installJson: Pick<InstallJson, "version"> | undefined
): { packageVersion: string; build?: BrokerBuild } | undefined {
  return installJson ? { packageVersion: installJson.version } : undefined;
}

/**
 * A broker keeps running as a detached process across extension updates, so after a VSIX update
 * the descriptor can still point at a broker started from the previous build. The broker records
 * its entry file and that file's mtime; a client whose own broker entry differs (path or mtime)
 * knows the running broker is stale.
 */
export function isStaleBrokerBuild(
  descriptorBuild: { entry: string; mtimeMs: number } | undefined,
  current: { entry: string; mtimeMs: number }
): boolean {
  if (!descriptorBuild) return false;
  return (
    descriptorBuild.entry !== current.entry ||
    Math.round(descriptorBuild.mtimeMs) !== Math.round(current.mtimeMs)
  );
}

/** Returns whether a live broker reports a browser configuration different from this extension's
 * persisted configuration. Older brokers omit `browser` from health, so an absent description is
 * deliberately treated as unknown rather than stale; this avoids repeatedly stopping brokers
 * that predate the metadata. */
export function isStaleBrokerBrowserConfiguration(
  configured: { channel: string; headless: boolean },
  running: { channel: string; headless: boolean } | undefined
): boolean {
  return running !== undefined && (running.channel !== configured.channel || running.headless !== true);
}

// docs/validation-log-2026-09-14-windows-round3.md S2: shortened from 15s -- this is now only the
// *polite* wait before the decisive phase below takes over, not the whole budget for giving up.
const RELEASE_WAIT_TIMEOUT_MS = 8_000;
const RELEASE_WAIT_POLL_MS = 250;
/** Separate, smaller bound for confirming the profile actually let go after a forced kill -- long
 * enough for the OS to tear the process down and drop its lock, short enough that a caller is
 * never blocked anywhere near as long as the old, purely-polite 15s wait used to. */
const FORCE_KILL_GRACE_MS = 5_000;

/** True when `pid` is still alive. `process.kill(pid, 0)` throwing `EPERM` means the process
 * exists but this one is not permitted to signal it (most often on Windows, or across a user/
 * session boundary) -- still alive; `ESRCH` (no such process) is the only case that means gone. */
function isBrokerPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Chromium's own "another instance is running" markers directly under the profile directory:
 * `SingletonLock` (a symlink on POSIX) and, on Windows and older builds, `lockfile` -- see
 * `src/transports/browser/profile-manager.ts`'s own `clearStaleSingletonLocks`, which this
 * deliberately does not reuse: that helper only removes a lock it can *prove* is dead by hostname
 * + pid, since it runs before a *new, unrelated* launch; here the only question is whether
 * *anything* is still there, because the broker this wait is watching is the one this module
 * itself just asked to shut down. `lstat` (not `stat`) so a dangling symlink whose target no
 * longer resolves still counts as present -- this only ever reads whether the path exists.
 */
async function isBrowserProfileLockPresent(profileDir: string): Promise<boolean> {
  for (const name of ["SingletonLock", "lockfile"]) {
    try {
      await lstat(path.join(profileDir, name));
      return true;
    } catch {
      /* absent (or unreadable, treated the same as absent) -- check the other name */
    }
  }
  return false;
}

/**
 * ISSUE-06 (docs/validation-log-2026-09-14-windows.md), made decisive in round 3's S2: after
 * asking a stale broker to shut down, wait for it to actually finish releasing what a freshly
 * spawned broker needs -- its descriptor, its own OS process, and the dedicated browser profile's
 * lock -- before returning. Without this, a caller whose next connect-or-start spawns a new broker
 * immediately can lose the race: the new broker launches its own browser on the same profile
 * directory while the old one (still exiting) holds the lock, and browser-manager.ts's own launch
 * retry only covers roughly 1.85s total (delays 0/100/250/500/1000ms) -- not enough for a slow
 * process exit, especially a loaded Windows machine fresh off a broker-staleness restart.
 *
 * Round 3's S2 went further: a broker whose own shutdown hangs (its `BrowserManager.dispose()`
 * stuck in a Playwright `close()` that never settles against a half-dead browser -- see
 * `src/transports/browser/browser-manager.ts`) never exits on its own, so the old, purely-polite
 * wait-then-give-up here left a wedged broker (and the browser process tree it owned) holding the
 * profile forever; the *next* launch then fails with Chromium exit code 21 (another live instance
 * already owns the user-data-dir), which the stale-lock cleanup in profile-manager.ts/
 * browser-manager.ts can never help with because that lock target genuinely is alive.
 *
 * This is now three bounded phases, each logged with exactly one metadata-only line: elapsed time,
 * a process count, or which conditions were unmet -- never any browser or profile content.
 *
 *  1. A polite wait (`releaseWait`, default 8s, polling every 250ms) for the three conditions to
 *     clear on their own -- the common case, where the old broker's own shutdown (now also bounded,
 *     see `BrowserManager`) finishes well inside this window.
 *  2. If that is not enough: force through instead of leaving the caller to fail against a wedged
 *     owner. The old broker's own pid is force-killed, but *only* after `isExpectedBrokerProcess`
 *     independently reconfirms its command line is actually `broker/process.js` -- never a pid this
 *     module merely assumes is still the same process (pids are reused). The descriptor's
 *     `browserPid` (src/ipc/protocol.ts), captured before this broker's shutdown was even
 *     requested, is force-killed the same way if it is still alive -- no re-verification beyond
 *     liveness, since a stale/reused pid there is caught by the caller's own next launch attempt
 *     simply finding nothing to kill. A short separate grace period then confirms the profile
 *     actually let go before this function returns.
 *  3. docs/validation-log-2026-09-14-windows-round4.md U2: none of the above actually proves the
 *     browser process tree is gone -- the descriptor disappearing, the broker's own pid exiting, and
 *     even the profile's `SingletonLock`/`lockfile` symlink disappearing are all signals the *broker*
 *     controls; on Windows that lock is a mandatory file lock whose path is never removed on exit
 *     (only its handle is released), so `lockGone` above can be true while Edge is still mid-
 *     shutdown. Once phase 1 or 2 confirms the old broker's own pid is gone, wait (bounded, default
 *     20s, polling every 250ms) for `src/broker/profile-processes.js`'s process-tree check to confirm
 *     no browser process of this profile remains either, force-killing whatever is left once that
 *     bound elapses too (never a foreign browser -- see that module's own doc comment).
 */
async function waitForBrokerFullyReleased(
  paths: AppPaths,
  pid: number,
  log: (line: string) => void,
  releaseWait: ReleaseWaitOptions = {},
  browserPid?: number
): Promise<void> {
  const timeoutMs = releaseWait.timeoutMs ?? RELEASE_WAIT_TIMEOUT_MS;
  const pollMs = releaseWait.pollMs ?? RELEASE_WAIT_POLL_MS;
  const forceKillGraceMs = releaseWait.forceKillGraceMs ?? FORCE_KILL_GRACE_MS;
  const start = Date.now();
  const deadline = start + timeoutMs;

  const stillReleased = async (): Promise<{ pidGone: boolean; lockGone: boolean }> => ({
    pidGone: !isBrokerPidAlive(pid),
    lockGone: !(await isBrowserProfileLockPresent(paths.profile))
  });

  // Phase 3 (see doc comment above): only ever run once the old broker's own pid is confirmed gone --
  // otherwise the browser tree it still owns is expected to still be there too, and this would just
  // burn its own 20s bound for nothing.
  const ensureBrowserTreeGone = (): Promise<void> =>
    ensureProfileBrowsersGone(paths.profile, {
      browserPid,
      timeoutMs: releaseWait.browserTreeTimeoutMs,
      pollMs: releaseWait.browserTreePollMs,
      exec: releaseWait.exec,
      log
    });

  // (a) the descriptor: `waitForDescriptorGone` already implements exactly this wait (and, as a
  // bonus, cleans up a lingering descriptor whose own pid it can already tell is dead).
  const descriptorGone = await waitForDescriptorGone(paths, undefined, Math.max(0, deadline - Date.now()));
  for (;;) {
    // (b) the old broker's own process, (c) the browser profile's OS-level lock.
    const { pidGone, lockGone } = await stillReleased();
    if (descriptorGone && pidGone && lockGone) {
      log(`broker: old broker fully released after ${Date.now() - start}ms`);
      await ensureBrowserTreeGone();
      return;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  // Decisive phase: the polite wait ran out. Force through rather than leaving a wedged old broker
  // (and/or the browser process tree it launched) blocking every future launch against this
  // profile.
  let forced = false;
  if (isBrokerPidAlive(pid) && (await isExpectedBrokerProcess(pid))) {
    log(`broker: old broker (pid ${pid}) outlived the release wait; force-killing it`);
    await killProcessTree(pid);
    forced = true;
  }
  if (browserPid !== undefined && isBrokerPidAlive(browserPid)) {
    log(`broker: old broker's browser process (pid ${browserPid}) is still alive; force-killing it`);
    await killProcessTree(browserPid);
    forced = true;
  }
  if (forced) {
    const forceDeadline = Date.now() + forceKillGraceMs;
    for (;;) {
      const { pidGone, lockGone } = await stillReleased();
      if (pidGone && lockGone) {
        log(`broker: old broker released after a forced stop, ${Date.now() - start}ms total`);
        await ensureBrowserTreeGone();
        return;
      }
      if (Date.now() >= forceDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  const { pidGone, lockGone } = await stillReleased();
  log(
    `broker: gave up waiting for the old broker to fully release after ${Date.now() - start}ms ` +
      `(descriptor ${descriptorGone ? "gone" : "present"}, pid ${pidGone ? "gone" : "alive"}, ` +
      `profile lock ${lockGone ? "released" : "held"})`
  );
  if (pidGone) await ensureBrowserTreeGone();
}

/**
 * Asks a connected broker to shut down and waits for it to fully release the profile it owned
 * (`waitForBrokerFullyReleased`, above), so the caller's own next connect-or-start can safely spawn
 * a replacement. Exported (beyond `restartBrokerIfStale`'s own internal use above) for `install`'s
 * own recovery (docs/validation-log-2026-09-14-windows-round2.md R4): a broker that was already
 * running *before* this `install` connected to it can hold a retained browser context whose
 * process died out from under it, so the first browser-needing step fails with
 * `BROWSER_START_FAILED` even though the broker itself never looked stale by build or
 * configuration -- `restartBrokerIfStale`'s own staleness checks would never catch this case, so
 * `install` calls this directly, once, instead.
 *
 * `browserPid` should be the descriptor's `browserPid` field, read by the caller *before* this
 * shutdown request -- see `waitForBrokerFullyReleased`'s doc comment for why the decisive phase
 * needs it captured up front rather than re-read here (a graceful shutdown removes the descriptor
 * before this function would otherwise get a chance to look).
 */
export async function stopBroker(
  client: IpcClient,
  paths: AppPaths,
  pid: number,
  log: (line: string) => void,
  releaseWait?: ReleaseWaitOptions,
  browserPid?: number
): Promise<boolean> {
  try {
    await client.call("broker.shutdown", {});
  } catch {
    /* it may already be going away */
  } finally {
    client.close();
  }
  await waitForBrokerFullyReleased(paths, pid, log, releaseWait, browserPid);
  return true;
}

async function readBrokerHealthBounded(
  client: IpcClient
): Promise<{ browser?: BrokerBrowserHealth } | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BROKER_HEALTH_TIMEOUT_MS);
  try {
    return (await client.call("broker.health", {}, undefined, controller.signal)) as {
      browser?: BrokerBrowserHealth;
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Detects the legacy visible-browser config before loadGlobalConfig persists its one-time
 * migration marker. This is only used when an old broker cannot report browser metadata. */
async function hasPendingHeadlessMigration(paths: AppPaths): Promise<boolean> {
  const text = await readText(paths.config).catch(() => undefined);
  if (text === undefined) return false;
  try {
    const raw = YAML.parse(text) as unknown;
    if (!isRecord(raw)) return false;
    const browser = raw.browser;
    return isRecord(browser) && browser.headless === false;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stops a broker started from an older build so the next connect-or-start spawns this build.
 * Returns true when a stale broker was found and asked to shut down. Never starts anything. The
 * browser metadata check also catches a legacy broker without build metadata after the one-time
 * headless migration has changed the persisted configuration.
 *
 * Staleness-by-build rule (§4.7 C13, see `BrokerStalenessContext.expected`'s doc comment for why
 * there are two): `context.expected` given -> compare the descriptor's `packageVersion` (and, if
 * given, `expected.build`) directly, no filesystem probe; `context.expected` omitted -> `stat()`
 * `context.brokerEntry` and compare its path + mtime against the descriptor's `build`, exactly as
 * before this field existed.
 */
export async function restartBrokerIfStale(context: BrokerStalenessContext): Promise<boolean> {
  const descriptor = await readDescriptor(context.paths).catch(() => undefined);
  if (!descriptor) return false;
  const pendingHeadlessMigration = await hasPendingHeadlessMigration(context.paths);
  const config = await loadGlobalConfig(context.paths).catch(() => undefined);
  if (!config) return false;
  let staleBuild = false;
  if (context.expected) {
    staleBuild =
      descriptor.packageVersion !== context.expected.packageVersion ||
      (context.expected.build !== undefined && isStaleBrokerBuild(descriptor.build, context.expected.build));
  } else if (descriptor.build) {
    const entry = context.brokerEntry;
    const mtimeMs = await stat(entry)
      .then((info) => info.mtimeMs)
      .catch(() => undefined);
    staleBuild = mtimeMs !== undefined && isStaleBrokerBuild(descriptor.build, { entry, mtimeMs });
  }
  let client;
  try {
    client = await connectExistingBroker(context.paths);
  } catch {
    client = undefined;
  }
  if (!client) return false;
  if (staleBuild) {
    context.log("broker: the running broker was started from an older build; restarting it");
    return stopBroker(
      client,
      context.paths,
      descriptor.pid,
      context.log,
      context.releaseWait,
      descriptor.browserPid
    );
  }
  let staleConfiguration: boolean;
  try {
    const health = await readBrokerHealthBounded(client);
    staleConfiguration =
      isStaleBrokerBrowserConfiguration(config.browser, health?.browser) ||
      (pendingHeadlessMigration && health?.browser === undefined);
  } catch {
    // A known one-time migration is enough to replace an old broker that cannot answer health;
    // otherwise build metadata remains authoritative when an older broker is unreachable here.
    staleConfiguration = pendingHeadlessMigration;
  }
  if (!staleBuild && !staleConfiguration) {
    client.close();
    return false;
  }
  context.log(
    staleBuild
      ? "broker: the running broker was started from an older build; restarting it"
      : "broker: the running broker configuration differs from saved settings; restarting it"
  );
  return stopBroker(
    client,
    context.paths,
    descriptor.pid,
    context.log,
    context.releaseWait,
    descriptor.browserPid
  );
}
