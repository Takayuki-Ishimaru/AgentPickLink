import { execFile } from "node:child_process";
import { lstat, readlink, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { killProcessTree as defaultKillProcessTree } from "../../broker/process-kill.js";
import {
  ensureProfileBrowsersGone,
  listProfileBrowserProcesses,
  type ProcessExec
} from "../../broker/profile-processes.js";
import { ensureWindowsLocalAppData, isDeadLockTarget, ProfileManager } from "./profile-manager.js";
import { BrowserTransportError, type BrowserContextLike, type PageHandle } from "./types.js";

const execFileAsync = promisify(execFile);

/** Mirrors `src/broker/broker-descriptor.ts`'s own `isPidAlive` (not imported from there: that
 * module lives in the broker layer, this one shouldn't need a dependency on it for a five-line OS
 * primitive). `false` only when the OS confirms the pid is gone. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ContextInvalidationReason = "crash" | "reset";
export interface PersistentContextLauncher {
  launchPersistentContext(profilePath: string, options: Record<string, unknown>): Promise<BrowserContextLike>;
  launchInteractiveContext?(
    profilePath: string,
    options: Record<string, unknown>,
    automation: { headless: boolean; acceptDownloads: boolean }
  ): Promise<BrowserContextLike>;
}
export interface BrowserViewport {
  width: number;
  height: number;
}
export interface BrowserManagerOptions {
  profilePath?: string;
  channel?: string;
  /** The automation context is hidden by default; only the interactive sign-in window is headed. */
  headless?: boolean;
  startupTimeoutMs?: number;
  acceptDownloads?: boolean;
  /** Optional context knobs, passed straight through to the persistent context. `args` is used
   * verbatim: nothing is ever added implicitly (an automation-hiding switch, for example, is only
   * present when the configuration asks for it). */
  userAgent?: string;
  args?: string[];
  viewport?: BrowserViewport;
  locale?: string;
  timezoneId?: string;
  /** Maximum number of transport-owned pages kept open in one persistent context. This includes
   * pages currently being created, so a burst cannot briefly exceed the limit. */
  maxPages?: number;
  launcher?: PersistentContextLauncher;
  /** An unexpected context close (browser crash, user-killed process). */
  onCrash?: () => void;
  /** A deliberate close of the automation context (interactive sign-in handoff). Every page handed
   * out before it is invalid afterwards, so the transport must invalidate its conversations. */
  onContextReset?: () => void;
  /** Bounded wait for `context.close()`/the headed sign-in window's `close()` before this manager
   * force-kills the browser process tree it launched instead of hanging the caller (broker
   * shutdown, `resetProfile()`, a relaunch after a reset, ...) forever on a half-dead browser --
   * see docs/validation-log-2026-09-14-windows-round3.md S2. Defaults to 5s. A close() that
   * settles (resolves or rejects) within this window keeps its existing behavior unchanged; only a
   * close() that never settles at all is affected. */
  closeTimeoutMs?: number;
  /** Injectable OS-level force kill, defaulting to src/broker/process-kill.js's `killProcessTree`.
   * Tests inject a spy so none of this ever has to touch a real process. */
  killProcessTree?: (pid: number) => Promise<void>;
  /** Metadata-only log sink for the force-kill/recovery paths below (never page content, never a
   * profile path). Defaults to a best-effort `process.stderr` write. */
  onLog?: (line: string) => void;
  /** Injectable ownership check used only by the exit-code-21 recovery in `launchContext()` (see
   * `tryRecoverFromOwnedProfile`): confirms a pid found alive in the profile's own lock file
   * actually launched against `profilePath` before it is ever force-killed. Defaults to
   * `defaultIsProfileOwnerProcess`; tests inject a fake so this never has to shell out for real. */
  isProfileOwnerProcess?: (pid: number, profilePath: string) => Promise<boolean>;
  /** docs/validation-log-2026-09-14-windows-round4.md U2: once `context.close()` itself settles
   * (i.e. did *not* hit `closeTimeoutMs` above), how long to additionally wait for the browser's own
   * OS process (`context.browser().process().pid`) to actually exit before force-killing it --
   * a settled Playwright `close()` does not itself prove the underlying process is gone. Defaults to
   * 10s. */
  browserExitTimeoutMs?: number;
  /** Bounded wait, after the browser's main process is confirmed exited (or force-killed) above, for
   * every remaining process of this profile (src/broker/profile-processes.js) to disappear too,
   * force-killing whatever is left once this elapses. Defaults to that module's own 20s default. */
  browserTreeTimeoutMs?: number;
  /** Injectable process-listing primitive for the two options above, forwarded to
   * src/broker/profile-processes.js. Tests inject a fake so none of this ever has to shell out for
   * real. */
  processExec?: ProcessExec;
  /** docs/validation-log-2026-09-14-windows-round5.md V2: shorter launch budget used only for the
   * very first hidden-context launch after this manager is constructed (a broker start/restart) --
   * see `launchWithFirstAttemptRetry`. A predecessor's browser tree still mid-shutdown is most
   * likely to be in the way for exactly that first launch; giving it the full `startupTimeoutMs`
   * before ever trying a kill+retry means the caller eats the whole timeout for nothing. Defaults
   * to 20s; effectively capped at `startupTimeoutMs` when that is smaller. */
  firstLaunchTimeoutMs?: number;
  /** Bounded wait, after force-killing the launched tree on a first-launch timeout, for it to
   * actually be gone before the one retry `launchWithFirstAttemptRetry` allows itself. Defaults to
   * 10s. Forwarded to `ensureProfileBrowsersGone`'s own `timeoutMs`. */
  firstLaunchKillWaitTimeoutMs?: number;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_BROWSER_EXIT_TIMEOUT_MS = 10_000;
const BROWSER_EXIT_POLL_MS = 250;
const DEFAULT_FIRST_LAUNCH_TIMEOUT_MS = 20_000;
const DEFAULT_FIRST_LAUNCH_KILL_WAIT_MS = 10_000;
/** Playwright's own launch `timeout` is capped below whatever wraps it (`launchContext`'s
 * `budgetMs`) so a launch failure surfaces Playwright's own `TimeoutError` -- with its call log
 * (`<launched> pid=`, `[pid=N][out|err]` lines) -- before this module's own outer `withTimeout`
 * wins the race and discards it. See docs/validation-log-2026-09-14-windows-round5.md V2: without
 * this, our own wrapper fired first and no call log was ever captured. Never exceeds Playwright's
 * own 30s default. */
const MAX_PLAYWRIGHT_LAUNCH_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_LAUNCH_TIMEOUT_MARGIN_MS = 5_000;

function defaultLog(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* best effort only -- never let a failed write affect anything else */
  }
}

/**
 * Chromium's own RESULT_CODE_NORMAL_EXIT_PROCESS_NOTIFIED (21): the just-launched browser process
 * detected another live instance already owning this user-data-dir (its ProcessSingleton) and
 * quit immediately -- Playwright then reports the context/browser as closed mid-launch, often with
 * the exit code embedded in its own error message. Distinguished from `isProfileLockError` (a
 * *file-level* SingletonLock/lockfile conflict observed before ever launching, at `prepare()`
 * time): this is the just-launched process itself reporting, after starting, that someone else
 * already owns the directory -- see docs/validation-log-2026-09-14-windows-round3.md S2.
 */
function isOwnedByAnotherInstance(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /exit\s*code[=:]?\s*21\b|exitcode[=:]?\s*21\b|process\s*singleton/i.test(message);
}

/** Playwright's own launch-level timeout ("browserType.launchPersistentContext: Timeout 30000ms
 * exceeded."), as distinct from this module's own `BrowserStartTimeout` -- both are launch hangs
 * that `launchWithFirstAttemptRetry` should retry once, but only the latter is an `instanceof`
 * check away; this covers the former by message shape. */
function isPlaywrightLaunchTimeoutMessage(message: string): boolean {
  return /timeout\s+\d+\s*ms\s+exceeded/i.test(message);
}

const LAUNCH_DIAGNOSTICS_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const LAUNCH_DIAGNOSTICS_QUERY_PATTERN = /\?[^\s"'<>]+/g;
const MAX_LAUNCH_DIAGNOSTIC_LINES = 40;

/** Redacts anything URL- or query-string-shaped from one Playwright call-log/stderr line before it
 * is ever logged or attached to an error's `details` -- a page URL or a token embedded in a query
 * string must never reach a log file. A bare filesystem path is left alone: it is already routinely
 * logged elsewhere in this codebase (profile paths, executable paths, ...). */
function redactLaunchDiagnosticLine(line: string): string {
  return line
    .replace(LAUNCH_DIAGNOSTICS_URL_PATTERN, "[redacted-url]")
    .replace(LAUNCH_DIAGNOSTICS_QUERY_PATTERN, "?[redacted]");
}

/**
 * Extracts Playwright's own "Call log:" section from a launch failure's message -- the
 * `<launching>`/`<launched> pid=`/`[pid=N][out|err]` lines `formatCallLog` appends to every
 * TimeoutError (see session-preserving-launcher.ts's own doc comment for the mechanism) -- which
 * docs/validation-log-2026-09-14-windows-round5.md V2 could never capture because this module's
 * own outer timeout used to fire first. `undefined` when the message carries no call log (a plain
 * "not found" or profile-lock message never has one): most failures return nothing here.
 */
function extractLaunchDiagnostics(message: string): string[] | undefined {
  const marker = "Call log:";
  const idx = message.indexOf(marker);
  if (idx === -1) return undefined;
  const lines = message
    .slice(idx + marker.length)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(redactLaunchDiagnosticLine);
  return lines.length > 0 ? lines.slice(0, MAX_LAUNCH_DIAGNOSTIC_LINES) : undefined;
}

/** `launchWithFirstAttemptRetry`'s own trigger: true only for a launch failure `launchFailure`
 * (below) tagged `details.timedOut` -- our own `BrowserStartTimeout` or Playwright's own launch
 * timeout, never a profile lock, an owned-profile exit, or a missing executable (retrying those
 * without addressing the actual cause would not help). */
function isLaunchTimeoutFailure(error: unknown): boolean {
  return error instanceof BrowserTransportError && error.details?.timedOut === true;
}

/** Confirms `pid`'s command line references `profilePath` before `tryRecoverFromOwnedProfile`
 * (below) ever force-kills a pid it only learned about from the profile's own lock file, not one
 * it launched itself. POSIX only, matching that method's own platform scope (Windows' mandatory
 * file lock has no such symlink for it to read a pid from in the first place) -- mirrors
 * `isExpectedBrokerProcess` (src/broker/broker-lifecycle.ts)'s own `ps -p <pid> -o command=`
 * approach, but matching the profile directory rather than a broker entry file, since the pid
 * being verified here is a *browser*, not a broker. `false` on any probe failure -- fails closed,
 * exactly like the broker-side check it mirrors. */
async function defaultIsProfileOwnerProcess(pid: number, profilePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      windowsHide: true
    });
    return stdout.toLowerCase().includes(profilePath.toLowerCase());
  } catch {
    return false;
  }
}

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = { width: 1440, height: 900 };

/** Sole owner of the persistent browser context. No Playwright type is exposed. */
export class BrowserManager {
  private context?: BrowserContextLike;
  /** A persistent context remains the profile owner until its close promise settles. */
  private closingContext?: Promise<void>;
  private closingContextOwner?: BrowserContextLike;
  /** A failed close retains ownership and blocks relaunch until a later close/dispose retries it. */
  private contextCloseFailed?: BrowserContextLike;
  /** Serializes profile deletion with startup so a relaunch cannot recreate the profile mid-reset. */
  private resettingProfile?: Promise<void>;
  /** The visible sign-in window, while one is open or until a failed close can be retried. A
   * shutdown must never leave an orphaned browser window on the user's desktop. */
  private headedContext?: BrowserContextLike;
  /** A concurrent cancellation/shutdown joins the same close operation. On failure the headed
   * context remains retained so a later dispose can retry instead of relaunching against a locked
   * profile while the visible Edge window is still alive. */
  private headedClosing?: Promise<void>;
  private starting?: Promise<void>;
  /** Flips true on the very first call to `launch()`, whatever its outcome -- so only that first
   * hidden-context launch after construction (a broker start/restart) ever gets the shorter
   * `firstLaunchTimeoutMs` budget/kill-and-retry treatment; every later one (a crash relaunch, a
   * reset, ...) goes straight to the normal single-budget path. See `launchWithFirstAttemptRetry`. */
  private firstLaunchAttempted = false;
  private interactiveLoginActive = false;
  /** Aborted by `cancelInteractiveLogin()`; also linked to any caller-supplied signal. */
  private loginAbort?: AbortController;
  /** True only while the visible login context is still being launched. */
  private interactiveLoginContextStarting = false;
  /** Resolves once the active sign-in has fully settled (headed context closed, manager stopped),
   * so a caller that just cancelled knows when `start()` is safe again. */
  private loginSettled?: Promise<void>;
  private readonly profile: ProfileManager;
  private readonly options: Required<
    Pick<BrowserManagerOptions, "channel" | "headless" | "startupTimeoutMs" | "viewport">
  > &
    BrowserManagerOptions;
  private pagesByKey = new Map<string, PageHandle>();
  /** One creation per key prevents a duplicate caller from orphaning the first Playwright page. */
  private readonly creatingPagesByKey = new Map<string, Promise<PageHandle>>();
  /** A page stays budgeted until Playwright has settled its close. */
  private readonly closingPagesByKey = new Map<string, Promise<void>>();
  private readonly invalidationHandlers = new Set<(reason: ContextInvalidationReason) => void>();
  constructor(options: BrowserManagerOptions = {}) {
    this.options = {
      ...options,
      channel: options.channel ?? "msedge",
      headless: options.headless ?? true,
      startupTimeoutMs: options.startupTimeoutMs ?? 45_000,
      viewport: options.viewport ?? DEFAULT_BROWSER_VIEWPORT
    };
    this.profile = new ProfileManager(options.profilePath);
  }
  isRunning(): boolean {
    return !!this.context;
  }
  keepsSignedInProcess(): boolean {
    return !!this.context?.completeInteractiveLogin;
  }
  /** Requested browser settings. On Windows, headless=true also permits native window hiding
   * after sign-in so a nonpersistent session can remain in the same browser process. */
  describe(): { channel: string; headless: boolean; viewport: BrowserViewport; running: boolean } {
    return {
      channel: this.options.channel,
      headless: this.options.headless,
      viewport: this.options.viewport,
      running: this.isRunning()
    };
  }
  /** Notified whenever the automation context goes away — crashed or deliberately reset for an
   * interactive sign-in — so owners can invalidate every page handle they were given. */
  onContextInvalidated(handler: (reason: ContextInvalidationReason) => void): () => void {
    this.invalidationHandlers.add(handler);
    return () => this.invalidationHandlers.delete(handler);
  }
  getContext(): BrowserContextLike {
    if (!this.context)
      throw new BrowserTransportError(
        "BROWSER_START_FAILED",
        "The hidden automation browser context is not running.",
        "Retry the operation, or run: m365-agent broker restart"
      );
    return this.context;
  }
  async start(): Promise<void> {
    if (this.resettingProfile) await this.resettingProfile;
    if (this.closingContext) await this.closingContext.catch(() => undefined);
    if (this.contextCloseFailed && !this.isContextAlive(this.contextCloseFailed)) {
      // The close that failed earlier was against a context whose browser process is now
      // confirmed gone (e.g. killed out from under the broker): there is nothing left to retry
      // closing, so this must not keep blocking every future start() on it forever. Any OS-level
      // profile lock the dead process left behind is handled by ProfileManager.prepare() and the
      // launch retry below, not here.
      this.contextCloseFailed = undefined;
    }
    if (this.contextCloseFailed)
      throw new BrowserTransportError(
        "BROWSER_PROFILE_LOCKED",
        "The dedicated browser profile is still owned by a browser context that did not close.",
        "Retry closing the AgentPickLink browser, then run: m365-agent broker restart"
      );
    if (this.context && !this.isContextAlive(this.context)) {
      // Self-heal: the retained automation context's browser process died without this manager
      // ever observing a "close" event on it (the event can be delayed, or simply never fire when
      // the process is killed outside Playwright's own control). Treat it exactly like the crash
      // handler in adoptAutomationContext() would -- invalidating the pages it handed out --
      // instead of returning early below and leaving every caller to fail against a dead reference
      // until an operator manually restarts the broker.
      this.discardCrashedContext(this.context);
    }
    if (this.context) return;
    // Chromium allows one process per user-data-dir: while the visible sign-in window owns the
    // dedicated profile, launching the hidden context would fail with a confusing profile lock.
    if (this.interactiveLoginActive)
      throw new BrowserTransportError(
        "CONCURRENT_REQUEST",
        "The dedicated browser profile is busy with an interactive sign-in.",
        "Finish or close the AgentPickLink sign-in window, then retry."
      );
    if (this.headedContext)
      throw new BrowserTransportError(
        "BROWSER_PROFILE_LOCKED",
        "The dedicated browser profile is still owned by the AgentPickLink sign-in window.",
        "Close the sign-in window, then run: m365-agent broker restart"
      );
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  async createConversationPage(pageKey: string): Promise<PageHandle> {
    if (!pageKey || !/^[A-Za-z0-9_.:-]{1,160}$/.test(pageKey))
      throw new BrowserTransportError("INVALID_ARGUMENT", "The browser page key is not a valid identifier.");
    await this.start();
    const existing = this.pagesByKey.get(pageKey);
    const closing = this.closingPagesByKey.get(pageKey);
    // A same-key caller must never receive a page another operation is tearing down. Waiting is
    // preferable to minting a second page with the same identity while the first is still live.
    if (closing) {
      await closing.catch(() => undefined);
      return this.createConversationPage(pageKey);
    }
    if (existing && !existing.page.isClosed?.()) return existing;
    if (existing) this.pagesByKey.delete(pageKey);
    const context = this.getContext();
    const creating = this.creatingPagesByKey.get(pageKey);
    if (creating) return creating;
    this.pruneExternallyClosedPages();
    const maxPages = this.options.maxPages ?? 16;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1)
      throw new BrowserTransportError(
        "INVALID_ARGUMENT",
        "browser.maxPages must be a positive whole number."
      );
    if (this.pagesByKey.size + this.creatingPagesByKey.size >= maxPages)
      throw new BrowserTransportError(
        "CONCURRENT_REQUEST",
        `The automation browser is already using its ${maxPages}-page limit.`,
        "Close an inactive conversation or wait for an in-progress browser operation to finish."
      );
    const creation = this.createPageInContext(pageKey, context);
    this.creatingPagesByKey.set(pageKey, creation);
    try {
      return await creation;
    } finally {
      // Do not delete a newer creation should this method ever be re-entered after a context reset.
      if (this.creatingPagesByKey.get(pageKey) === creation) this.creatingPagesByKey.delete(pageKey);
    }
  }

  private async createPageInContext(pageKey: string, context: BrowserContextLike): Promise<PageHandle> {
    // BrowserContext's newPage is intentionally obtained structurally to keep
    // Playwright private to this package. Never reuse another conversation's page.
    const newPage = context.newPage;
    const fresh = newPage
      ? await newPage.call(context)
      : context
          .pages()
          .find(
            (p) => p.isClosed?.() !== true && !Array.from(this.pagesByKey.values()).some((h) => h.page === p)
          );
    if (!fresh)
      throw new BrowserTransportError(
        "AGENT_PAGE_UNAVAILABLE",
        "The automation browser did not provide a usable page for this conversation.",
        "Run: m365-agent broker restart"
      );
    // The context can be closed while newPage() is pending. Never retain a page from that old
    // context: it would be unreachable by closePage() after the next launch.
    if (
      this.context !== context ||
      this.closingContextOwner === context ||
      this.contextCloseFailed === context
    ) {
      await fresh.close?.().catch(() => undefined);
      throw new BrowserTransportError(
        "BROWSER_CRASHED",
        "The automation browser closed while opening a conversation page.",
        "Retry the operation."
      );
    }
    const handle = { key: pageKey, page: fresh };
    this.pagesByKey.set(pageKey, handle);
    return handle;
  }
  async closePage(pageKey: string): Promise<void> {
    // A caller may abandon a conversation while its page is still opening. Awaiting the keyed
    // creation makes that close deterministic and avoids leaving the eventual page orphaned.
    const creating = this.creatingPagesByKey.get(pageKey);
    if (creating) {
      const created = await creating.catch(() => undefined);
      // A context reset can clear this key and let a new context create another page with the
      // same key before the old creation settles. Only close the exact handle this caller was
      // waiting for; otherwise a stale close could tear down the fresh conversation.
      if (created && this.pagesByKey.get(pageKey) === created) await this.closePage(pageKey);
      return;
    }
    const existingClose = this.closingPagesByKey.get(pageKey);
    if (existingClose) return existingClose;
    const handle = this.pagesByKey.get(pageKey);
    if (!handle) return;
    let settleClose: (() => void) | undefined;
    let failClose: ((error: unknown) => void) | undefined;
    const closing = new Promise<void>((resolve, reject) => {
      settleClose = resolve;
      failClose = reject;
    });
    this.closingPagesByKey.set(pageKey, closing);
    void (async () => {
      let closedSuccessfully = false;
      try {
        await handle.page.close?.();
        closedSuccessfully = true;
        settleClose?.();
      } catch (error) {
        failClose?.(error);
      } finally {
        // Keep the handle counted until the close settles. A different context/page that reused
        // this key after a reset must never be removed by this old close completion.
        // A failed close can leave the browser page alive. Retain it in the budget so failures
        // cannot turn into unbounded pages; a later closePage() can retry it. Browser-reported
        // closure still frees the slot even if Playwright surfaced an error while closing.
        if (
          this.pagesByKey.get(pageKey) === handle &&
          (closedSuccessfully || handle.page.isClosed?.() === true)
        )
          this.pagesByKey.delete(pageKey);
        if (this.closingPagesByKey.get(pageKey) === closing) this.closingPagesByKey.delete(pageKey);
      }
    })();
    return closing;
  }

  /** Browser-initiated closes do not call closePage(). Drop those stale handles before applying
   * the page limit, but never drop a handle whose requested close is still settling. */
  private pruneExternallyClosedPages(): void {
    for (const [key, handle] of this.pagesByKey) {
      if (!this.closingPagesByKey.has(key) && handle.page.isClosed?.() === true) this.pagesByKey.delete(key);
    }
  }
  /**
   * Closes the hidden automation context. Refused while a visible sign-in is running: that window
   * owns the shared profile directory, and closing the automation context underneath it would
   * either race the handoff or destroy the sign-in the user is in the middle of.
   */
  async close(): Promise<void> {
    if (this.interactiveLoginActive) throw signInInProgress();
    await this.closeAutomationContext();
  }
  async resetProfile(): Promise<void> {
    if (this.interactiveLoginActive) throw signInInProgress();
    if (this.resettingProfile) return this.resettingProfile;
    const resetting = (async () => {
      await this.closeAutomationContext();
      await this.profile.reset();
    })();
    this.resettingProfile = resetting;
    try {
      await resetting;
    } finally {
      if (this.resettingProfile === resetting) this.resettingProfile = undefined;
    }
  }
  /**
   * Shutdown path. Unlike `close()`, this never refuses: it also closes the visible sign-in window
   * (the process is going away, and an orphaned browser window would keep the profile locked).
   */
  async dispose(): Promise<void> {
    // A headed context is assigned only after launchPersistentContext resolves. If shutdown lands
    // during that launch, closeHeadedContext() cannot see it yet; cancel and await the login's
    // unwind so a late context cannot become an orphan after dispose returns. Once the window is
    // already handed to the login body, preserve the existing contract: closing it is enough and
    // the caller remains responsible for ending that body.
    if (this.interactiveLoginContextStarting) {
      this.cancelInteractiveLogin();
      await this.settleInteractiveLogin();
    }
    await this.closeHeadedContext();
    await this.closeAutomationContext();
  }

  /** Closes the visible sign-in window if one is open. Safe to call twice: the second call is a
   * no-op, so cancelling a sign-in and then unwinding `runInteractiveLogin` closes it exactly once. */
  private async closeHeadedContext(): Promise<void> {
    const existing = this.headedClosing;
    if (existing) return existing;
    const headed = this.headedContext;
    if (!headed) return;
    const closing = (async () => {
      // Do not clear headedContext until close has settled successfully. Playwright can reject
      // while the browser window remains open; dropping this reference would let the next start
      // race the profile lock and make the visible automation window look like a successful login.
      // A close() that never settles at all (a half-dead browser -- see `raceCloseTimeout`'s doc
      // comment) is force-killed instead, and is then treated as closed either way.
      const pid = this.browserPidOf(headed);
      const outcome = await this.raceCloseTimeout(headed.close());
      if (outcome === "timeout") await this.forceKillHungContext(headed);
      else if (pid !== undefined) await this.ensureBrowserProcessGone(pid);
      if (this.headedContext === headed) this.headedContext = undefined;
    })();
    this.headedClosing = closing;
    try {
      await closing;
    } finally {
      if (this.headedClosing === closing) this.headedClosing = undefined;
    }
  }

  private async closeAutomationContext(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.closingContext) return this.closingContext;
    const context = this.context;
    if (!context) return;
    this.pagesByKey.clear();
    // Creations tied to the old context will reject/close their late page after observing the
    // changed context identity. Clearing the index lets a newly launched context serve work
    // immediately instead of being charged for those stale operations.
    this.creatingPagesByKey.clear();
    this.closingPagesByKey.clear();
    this.closingContextOwner = context;
    const closing = (async () => {
      try {
        // Broker shutdown must never hang forever on a half-dead browser (S2): race close()
        // against a bounded timeout and force-kill the process tree this manager launched on
        // timeout, rather than leave the caller (broker-server.ts's finishStop(), resetProfile(),
        // ...) waiting indefinitely -- see `raceCloseTimeout`/`forceKillHungContext` below. A
        // close() that itself settles is not the end of the story either (docs/validation-log-2026-
        // 09-14-windows-round4.md U2): `ensureBrowserProcessGone` below confirms the OS process (and
        // its child tree) is actually gone too, so "this manager's close() finished" really does
        // imply "the browser is gone" for whatever calls this manager's own close()/dispose().
        const pid = this.browserPidOf(context);
        const outcome = await this.raceCloseTimeout(context.close());
        if (outcome === "timeout") await this.forceKillHungContext(context);
        else if (pid !== undefined) await this.ensureBrowserProcessGone(pid);
        if (this.context === context) this.context = undefined;
        this.contextCloseFailed = undefined;
      } catch (error) {
        // A close() that itself settled (rejected) within the bound keeps the existing contract:
        // the browser may still own the profile, so a new launch must not race it. Only a close()
        // that never settled at all is force-killed and treated as closed above.
        this.contextCloseFailed = context;
        throw error;
      } finally {
        if (this.closingContextOwner === context) this.closingContextOwner = undefined;
      }
    })();
    this.closingContext = closing;
    try {
      await closing;
    } finally {
      if (this.closingContext === closing) this.closingContext = undefined;
    }
  }

  private log(line: string): void {
    (this.options.onLog ?? defaultLog)(line);
  }

  /** Best-effort extraction of the OS pid behind a context's underlying browser, via Playwright's
   * real `Browser.process()` (see `BrowserContextLike.browser()`'s widened declaration in
   * types.ts). `undefined` whenever the probe is absent, returns nothing, or throws -- this is
   * only ever used for a force-kill decision that already treats "no pid" as "nothing to kill". */
  private browserPidOf(context: BrowserContextLike | undefined): number | undefined {
    try {
      const pid = context?.browser?.()?.process?.()?.pid;
      return typeof pid === "number" ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Races a close() call already in flight against a bounded timeout, resolving `"closed"` the
   * moment it settles (whether it resolves *or* rejects -- a rejection still propagates through
   * this function to preserve the caller's existing failure handling) or `"timeout"` once the
   * bound elapses first. Both branches of `closePromise` are always attached (even after the race
   * result has already been reported) so a close() that eventually rejects long after timing out
   * can never surface as an unhandled rejection.
   */
  private raceCloseTimeout(closePromise: Promise<void>): Promise<"closed" | "timeout"> {
    const timeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    return new Promise<"closed" | "timeout">((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve("timeout");
      }, timeoutMs);
      closePromise.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve("closed");
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error as Error);
        }
      );
    });
  }

  /** Force-kills the browser process tree behind a context whose close() did not finish within the
   * bound above -- logging metadata only (elapsed timeout, pid if known; never page content or a
   * profile path). Never throws: the caller treats the context as closed either way. */
  private async forceKillHungContext(context: BrowserContextLike): Promise<void> {
    const timeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    const pid = this.browserPidOf(context);
    this.log(
      `browser: close() did not finish within ${timeoutMs}ms` +
        (pid !== undefined
          ? `; force-killing the browser process (pid ${pid})`
          : "; no browser pid to force-kill")
    );
    if (pid !== undefined)
      await (this.options.killProcessTree ?? defaultKillProcessTree)(pid).catch(() => undefined);
  }

  /**
   * docs/validation-log-2026-09-14-windows-round4.md U2: called only after a context's `close()`
   * itself settled without hitting `closeTimeoutMs` (the hung case above is handled by
   * `forceKillHungContext` instead) -- a settled Playwright `close()` does not by itself prove the
   * underlying OS process, let alone its child tree, has actually exited. Two bounded phases, so
   * "this manager's close() finished" really does imply "the browser is gone" for whatever called
   * it (broker-server.ts's `finishStop()` in particular, which must not remove the broker's
   * descriptor -- the signal a restarter waits for -- before that is true):
   *
   *  1. Wait (default 10s, polling every 250ms) for the main process to exit on its own; force-kill
   *     it once that bound elapses.
   *  2. Wait for every remaining process of this profile to disappear too, via the same
   *     src/broker/profile-processes.js helper `broker-staleness.ts`'s own decisive phase uses,
   *     force-killing whatever is left once *that* bound elapses (never a foreign browser -- see
   *     that module's own doc comment). A renderer/GPU child can briefly outlive the main process's
   *     own exit, so this is checked independently rather than assumed.
   *
   * Never throws; logs metadata only (elapsed time, pid, or a kill count -- never page content or a
   * profile path).
   */
  private async ensureBrowserProcessGone(pid: number): Promise<void> {
    const exitTimeoutMs = this.options.browserExitTimeoutMs ?? DEFAULT_BROWSER_EXIT_TIMEOUT_MS;
    const exitDeadline = Date.now() + exitTimeoutMs;
    while (isProcessAlive(pid) && Date.now() < exitDeadline)
      await new Promise((resolve) => setTimeout(resolve, BROWSER_EXIT_POLL_MS));
    if (isProcessAlive(pid)) {
      this.log(`browser: main process (pid ${pid}) did not exit within ${exitTimeoutMs}ms; force-killing it`);
      await (this.options.killProcessTree ?? defaultKillProcessTree)(pid).catch(() => undefined);
    }
    await ensureProfileBrowsersGone(this.profile.profilePath, {
      browserPid: pid,
      timeoutMs: this.options.browserTreeTimeoutMs,
      exec: this.options.processExec,
      killProcessTree: this.options.killProcessTree ?? defaultKillProcessTree,
      log: (line) => this.log(line)
    });
  }

  /**
   * Runs `run` against a **headed** persistent context on the same dedicated profile directory.
   *
   * Chromium refuses to open two processes on one user-data-dir, so the hidden automation context
   * is closed first (every page handed out before becomes invalid: `onContextReset` fires so the
   * transport can invalidate its conversations). A launcher with completeInteractiveLogin keeps
   * this process alive and retires its visible login pages. Otherwise the manager closes it and
   * relaunches on the shared profile on the next start(). No cookie or token is ever read.
   *
   * `run` is handed the same abort signal `cancelInteractiveLogin()` trips, so a polling body can
   * stop on its own; the call rejects with AUTH_FAILED ("The sign-in was cancelled.") either way.
   */
  async runInteractiveLogin<T>(
    run: (context: BrowserContextLike, signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal } = {}
  ): Promise<T> {
    if (this.resettingProfile) await this.resettingProfile;
    if (this.interactiveLoginActive)
      throw new BrowserTransportError(
        "CONCURRENT_REQUEST",
        "An interactive sign-in is already in progress.",
        "Finish or close the AgentPickLink sign-in window, then retry."
      );
    this.interactiveLoginActive = true;
    const controller = new AbortController();
    this.loginAbort = controller;
    const abortFromCaller = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    let markSettled = () => undefined as void;
    this.loginSettled = new Promise<void>((resolve) => {
      markSettled = () => resolve();
    });
    try {
      if (controller.signal.aborted) throw signInCancelled();
      // Let an in-flight hidden launch settle first, otherwise it would take the profile lock back
      // right after this close().
      if (this.starting) await this.starting.catch(() => undefined);
      const wasRunning = this.isRunning();
      await this.closeAutomationContext();
      if (wasRunning) {
        this.options.onContextReset?.();
        this.notifyInvalidated("reset");
      }
      const { width, height } = this.options.viewport;
      this.interactiveLoginContextStarting = true;
      let context: BrowserContextLike;
      try {
        context = await this.launchContext(
          {
            headless: false,
            // Let the authentication page fit the actual window, including small remote desktops.
            viewport: null,
            // Forced regardless of the hidden context's own configuration: the visible sign-in window
            // is shown to the user specifically to complete an identity handshake, never to run agent
            // automation, so it must never be able to save a file or hold a granted permission (camera,
            // clipboard, ...) even if browser.acceptDownloads is enabled for the hidden context.
            acceptDownloads: false,
            permissions: [],
            args: [...(this.options.args ?? []), `--window-size=${width},${height}`]
          },
          true
        );
      } finally {
        this.interactiveLoginContextStarting = false;
      }
      this.headedContext = context;
      try {
        const result = await raceCancellation(run(context, controller.signal), controller.signal);
        if (context.completeInteractiveLogin) {
          try {
            await context.completeInteractiveLogin();
          } catch (error) {
            if (controller.signal.aborted) throw signInCancelled();
            throw error;
          }
          if (controller.signal.aborted || this.headedContext !== context) throw signInCancelled();
          this.adoptAutomationContext(context);
          this.headedContext = undefined;
        }
        return result;
      } finally {
        await this.closeHeadedContext();
      }
    } finally {
      options.signal?.removeEventListener("abort", abortFromCaller);
      this.loginAbort = undefined;
      this.loginSettled = undefined;
      this.interactiveLoginActive = false;
      markSettled();
    }
  }

  /**
   * Cancels the interactive sign-in currently in progress: the visible window is closed and the
   * pending `runInteractiveLogin()` rejects with AUTH_FAILED. Returns false when there is nothing
   * to cancel. The manager is left stopped, so `start()` relaunches the hidden context; await
   * `settleInteractiveLogin()` first if the very next thing is another launch.
   */
  cancelInteractiveLogin(): boolean {
    const controller = this.loginAbort;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    // The login body will await the same close in its finally block. Suppress the cancellation
    // path's duplicate rejection there; the login promise remains responsible for reporting a
    // close failure to its caller.
    void this.closeHeadedContext().catch(() => undefined);
    return true;
  }

  /** Resolves once no interactive sign-in is unwinding any more (immediately when none is). */
  async settleInteractiveLogin(): Promise<void> {
    await this.loginSettled;
  }

  private notifyInvalidated(reason: ContextInvalidationReason): void {
    for (const handler of this.invalidationHandlers) handler(reason);
  }

  private async launchContext(
    overrides: Record<string, unknown> = {},
    interactive = false,
    budgetMs: number = this.options.startupTimeoutMs
  ): Promise<BrowserContextLike> {
    const profilePath = await this.profile.prepare();
    if (!this.options.launcher)
      throw new BrowserTransportError(
        "BROWSER_START_FAILED",
        "No browser launcher is available to this broker.",
        "Reinstall AgentPickLink and run: m365-agent broker restart"
      );
    // Round 6 root cause of the first-launch timeout: see `ensureWindowsLocalAppData`.
    if (await ensureWindowsLocalAppData())
      this.log("browser: created the missing per-user AppData\\Local folder before the launch");
    // docs/validation-log-2026-09-14-windows-round5.md V2: a snapshot of whatever this host already
    // considers part of this profile's browser tree, logged once per launch attempt -- metadata
    // only (count + pids, never a command line) -- so the next run shows whether anything was still
    // alive the instant a launch was requested, independent of whatever this attempt itself does.
    const preLaunchProcesses = await listProfileBrowserProcesses(profilePath, {
      exec: this.options.processExec
    }).catch(() => []);
    this.log(
      `browser: ${preLaunchProcesses.length} browser process(es) already present for this profile at launch start` +
        (preLaunchProcesses.length ? ` (pids: ${preLaunchProcesses.map((proc) => proc.pid).join(", ")})` : "")
    );
    // Capped below `budgetMs` so Playwright's own TimeoutError -- carrying its call log -- surfaces
    // before this module's own outer `withTimeout` (below) wins the race and discards it; see the
    // constants' own doc comment. Never negative/zero (which Playwright treats as "no timeout").
    const playwrightTimeoutMs = Math.max(
      1_000,
      Math.min(budgetMs - PLAYWRIGHT_LAUNCH_TIMEOUT_MARGIN_MS, MAX_PLAYWRIGHT_LAUNCH_TIMEOUT_MS)
    );
    const launchOptions = {
      channel: this.options.channel,
      headless: this.options.headless,
      acceptDownloads: this.options.acceptDownloads ?? false,
      permissions: [],
      bypassCSP: false,
      chromiumSandbox: true,
      viewport: this.options.viewport,
      args: this.options.args ?? [],
      timeout: playwrightTimeoutMs,
      ...(this.options.userAgent ? { userAgent: this.options.userAgent } : {}),
      ...(this.options.locale ? { locale: this.options.locale } : {}),
      ...(this.options.timezoneId ? { timezoneId: this.options.timezoneId } : {}),
      ...overrides
    };
    // A broker restart can release its IPC descriptor before Chromium/Edge has finished dropping
    // the OS-level profile lock; a browser killed from outside the broker's own control (e.g. an
    // external process cleanup) can leave the same lock behind for even longer while its process
    // finishes exiting. Retry across a bounded ~10s window -- long enough to cover a slow exit --
    // and, on every profile-lock failure, recheck the lock file itself (see
    // removeDeadProfileLock()): ProfileManager.prepare() already clears a lock it can prove is dead
    // once, above, before this loop starts, but a lock whose owning process was still alive at that
    // instant and dies moments later, mid-retry, is never rechecked without this. Never terminate
    // or interfere with an external browser that still genuinely owns the profile.
    const retryDelays = [0, 250, 500, 1_000, 2_000, 3_000, 3_000] as const;
    const deadline = Date.now() + budgetMs;
    let lastError: unknown;
    // ISSUE-2026-09-14-06 (S2): "another live instance owns this profile" gets exactly one
    // recovery attempt across this whole call, not one per retry slot -- see
    // `tryRecoverFromOwnedProfile`'s doc comment.
    let recoveryAttempted = false;
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      const waitMs = retryDelays[attempt];
      const beforeWait = deadline - Date.now();
      if (beforeWait <= 0) break;
      if (waitMs) await delay(Math.min(waitMs, beforeWait));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let launch: Promise<BrowserContextLike>;
      try {
        launch = Promise.resolve(
          interactive && this.options.launcher.launchInteractiveContext
            ? this.options.launcher.launchInteractiveContext(profilePath, launchOptions, {
                headless: this.options.headless,
                acceptDownloads: this.options.acceptDownloads ?? false
              })
            : this.options.launcher.launchPersistentContext(profilePath, launchOptions)
        );
      } catch (error) {
        lastError = error;
        if (!recoveryAttempted && isOwnedByAnotherInstance(error)) {
          recoveryAttempted = true;
          if (await this.tryRecoverFromOwnedProfile(profilePath)) {
            attempt--;
            continue;
          }
        }
        if (!isProfileLockError(error) || attempt === retryDelays.length - 1) throw this.launchFailure(error);
        await this.removeDeadProfileLock(profilePath);
        continue;
      }
      try {
        return await withTimeout(launch, remaining);
      } catch (error) {
        lastError = error;
        void launch.then((late) => late.close()).catch(() => undefined);
        if (!recoveryAttempted && isOwnedByAnotherInstance(error)) {
          recoveryAttempted = true;
          if (await this.tryRecoverFromOwnedProfile(profilePath)) {
            attempt--;
            continue;
          }
        }
        if (!isProfileLockError(error) || attempt === retryDelays.length - 1)
          throw await this.classifyLaunchFailure(error, profilePath);
        await this.removeDeadProfileLock(profilePath);
      }
    }
    throw await this.classifyLaunchFailure(lastError ?? new BrowserStartTimeout(budgetMs), profilePath);
  }

  /**
   * ISSUE-2026-09-14-06 (S2): one launch failure classified as "another live instance already owns
   * this profile" (see `isOwnedByAnotherInstance`) is allowed exactly one recovery attempt per
   * `launchContext()` call. The profile directory's own `SingletonLock`/`lockfile` symlink already
   * encodes `<hostname>-<pid>` (see `isDeadLockTarget`/`removeDeadProfileLock` above) -- unlike
   * `removeDeadProfileLock`, which only ever touches a lock it can prove is *dead*, this reads that
   * same pid when it is instead *alive* and, only after `isProfileOwnerProcess` independently
   * confirms that pid's command line actually references this profile directory, force-kills it and
   * reports success so the caller retries the same attempt slot. Never kills a pid this cannot
   * confirm: an unreadable/foreign-host lock, a dead pid, or a failed ownership check all return
   * `false` with nothing touched.
   *
   * POSIX only, matching `removeDeadProfileLock`/`clearStaleSingletonLocks`: Windows' mandatory
   * file lock has no such symlink to read a pid from, so this failure is reported there the same
   * way any other `BROWSER_START_FAILED` is, with no automatic recovery attempted -- the
   * restarter's own decisive cleanup (`src/services/broker-staleness.ts`'s
   * `waitForBrokerFullyReleased`, via the descriptor's `browserPid`) is what actually clears a
   * wedged owner on that platform, from the *caller's* process rather than this broker's own.
   */
  private async tryRecoverFromOwnedProfile(profilePath: string): Promise<boolean> {
    if (process.platform === "win32") return false;
    for (const name of ["SingletonLock", "lockfile"]) {
      const lockPath = path.join(profilePath, name);
      let pid: number | undefined;
      try {
        const stats = await lstat(lockPath);
        if (!stats.isSymbolicLink()) continue;
        const target = await readlink(lockPath);
        const match = /^(.+)-(\d+)$/.exec(target.trim());
        if (!match) continue;
        const id = Number(match[2]);
        if (Number.isInteger(id) && id > 0) pid = id;
      } catch {
        continue;
      }
      if (pid === undefined || !isProcessAlive(pid)) continue;
      const isOwner = this.options.isProfileOwnerProcess ?? defaultIsProfileOwnerProcess;
      if (!(await isOwner(pid, profilePath).catch(() => false))) continue;
      this.log(`browser: another live process (pid ${pid}) still owns this profile; force-killing it`);
      await (this.options.killProcessTree ?? defaultKillProcessTree)(pid).catch(() => undefined);
      return true;
    }
    return false;
  }

  /**
   * Mirrors ProfileManager's own stale-lock cleanup (profile-manager.ts's
   * `clearStaleSingletonLocks`/`isDeadLockTarget`), reused here (rather than duplicated) because
   * that one only runs once per `launchContext()` call -- at `profile.prepare()`, before this retry
   * loop even starts. Only ever removes a lock this host can prove is dead (a `SingletonLock`/
   * `lockfile` symlink whose recorded PID no longer exists); a live or foreign one is left
   * untouched, so a genuinely running external browser is never disturbed. POSIX only, matching
   * `clearStaleSingletonLocks` -- Windows' mandatory file lock has no such symlink to inspect.
   */
  private async removeDeadProfileLock(profilePath: string): Promise<void> {
    if (process.platform === "win32") return;
    for (const name of ["SingletonLock", "lockfile"]) {
      const lockPath = path.join(profilePath, name);
      try {
        const stats = await lstat(lockPath);
        if (!stats.isSymbolicLink()) continue;
        const target = await readlink(lockPath);
        if (!isDeadLockTarget(target)) continue;
        await unlink(lockPath);
      } catch {
        // Absent, unreadable, or already removed by the real owner in the meantime -- leave the
        // profile as it is and let the next attempt decide.
      }
    }
  }

  /**
   * ISSUE-2026-09-14-06 continued (docs/validation-log-2026-09-14-windows-round4.md U2): a
   * `BrowserStartTimeout` -- this manager's own launch attempt never got an answer within
   * `startupTimeoutMs` -- gets one extra classification step before `launchFailure` turns it into a
   * message: if `src/broker/profile-processes.js` still finds any browser process of this exact
   * profile, that is strong evidence the real cause is contention, not a plain slow start -- on
   * Windows in particular, Chromium's own ProcessSingleton makes a brand new launch wait silently
   * (no dialog, headless) for an existing instance against the same `--user-data-dir` until this
   * timeout fires (see `isOwnedByAnotherInstance`'s own doc comment for the *early*-failure version
   * of the same underlying problem, which this cannot be confused with: that one is a launcher
   * failure with the exit code embedded in its message, not a bare timeout). This manager never
   * obtains a pid for its own just-launched attempt when that attempt itself never resolves, so it
   * cannot exclude "the one we just launched" by pid; after the full `startupTimeoutMs` has already
   * elapsed, any match found is treated as evidence worth a more actionable message. A launch
   * failure of any other shape is returned unchanged.
   */
  private async classifyLaunchFailure(error: unknown, profilePath: string): Promise<Error> {
    if (!(error instanceof BrowserStartTimeout)) return this.launchFailure(error);
    const others = await listProfileBrowserProcesses(profilePath, { exec: this.options.processExec }).catch(
      () => []
    );
    return this.launchFailure(error, others.length > 0);
  }

  /** Turns a raw launcher failure into the error code the user can act on. `competingProfileProcesses`
   * (see `classifyLaunchFailure` above) is only ever true alongside a `BrowserStartTimeout`.
   *
   * docs/validation-log-2026-09-14-windows-round5.md V2: every branch below is also tagged with
   * `details.timedOut` (consumed only by `isLaunchTimeoutFailure`/`launchWithFirstAttemptRetry`,
   * never surfaced to the user) when the root cause was a launch timeout -- ours or Playwright's own
   * -- and, whenever the raw error carries a Playwright call log, with `details.callLog` (the same
   * redacted, truncated lines this also writes to the broker log below), so the CLI can write it to
   * cli.log per item 1 of that log's "Do" list. */
  private launchFailure(error: unknown, competingProfileProcesses = false): Error {
    if (error instanceof BrowserTransportError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = error instanceof BrowserStartTimeout || isPlaywrightLaunchTimeoutMessage(message);
    const diagnostics = extractLaunchDiagnostics(message);
    if (diagnostics) {
      this.log(`browser: launch failure call log (${diagnostics.length} line(s), redacted):`);
      for (const line of diagnostics) this.log(`browser: ${line}`);
    }
    const details: Record<string, unknown> = {};
    if (timedOut) details.timedOut = true;
    if (diagnostics) details.callLog = diagnostics;
    const withDetails = (transportError: BrowserTransportError): BrowserTransportError => {
      if (Object.keys(details).length > 0) transportError.details = { ...transportError.details, ...details };
      return transportError;
    };
    // ISSUE-2026-09-14-06 (S2): checked before the generic profile-lock branch below, since a
    // ProcessSingleton exit also matches that regex -- this is a more specific diagnosis (a browser
    // process that actually started, then quit because another live instance already owns the
    // directory) with a more actionable remediation than the generic one.
    if (isOwnedByAnotherInstance(error))
      return withDetails(
        new BrowserTransportError(
          "BROWSER_START_FAILED",
          `The ${this.options.channel} browser did not start: another instance already owns the dedicated profile.`,
          `Another AgentPickLink browser instance owns the profile. Run: m365-agent broker restart. If it persists, close the remaining ${this.options.channel} processes started by AgentPickLink.`
        )
      );
    if (isProfileLockError(message))
      return withDetails(
        new BrowserTransportError(
          "BROWSER_PROFILE_LOCKED",
          "The dedicated browser profile is already in use by another browser process.",
          "Another browser process is using the dedicated profile. Close the sign-in window or run: m365-agent broker restart"
        )
      );
    if (competingProfileProcesses && error instanceof BrowserStartTimeout)
      return withDetails(
        new BrowserTransportError(
          "BROWSER_START_FAILED",
          `The ${this.options.channel} browser did not start: ${message}`,
          "Another AgentPickLink browser for this profile is still running/shutting down; wait or run: m365-agent broker restart"
        )
      );
    if (
      /executable doesn't exist|executable.*(not found|does not exist)|browser.*not installed|channel.*not (found|installed)|distribution .*is not found|is not found at|spawn .*enoent/i.test(
        message
      )
    )
      return withDetails(
        new BrowserTransportError(
          "BROWSER_START_FAILED",
          `The ${this.options.channel} browser could not be started: its executable was not found.`,
          `Install the ${this.options.channel} browser, or switch browser.channel to an installed browser (msedge, chrome, chromium) in the AgentPickLink panel's Advanced settings or config.yaml, then restart the broker (m365-agent broker restart).`
        )
      );
    return withDetails(
      new BrowserTransportError(
        "BROWSER_START_FAILED",
        `The ${this.options.channel} browser did not start: ${message}`,
        "Run: m365-agent broker restart"
      )
    );
  }

  private async launch(): Promise<void> {
    const context = await this.launchWithFirstAttemptRetry();
    this.adoptAutomationContext(context);
  }

  /**
   * docs/validation-log-2026-09-14-windows-round5.md V2, "shorter penalty": the very first hidden-
   * context launch after this manager is constructed (a broker start/restart) is the one most
   * likely to race a predecessor's browser tree that is still mid-shutdown -- see
   * `classifyLaunchFailure`'s own doc comment. Rather than make that first caller eat the full
   * `startupTimeoutMs` and fail outright, this gives only that first attempt a shorter budget
   * (`firstLaunchTimeoutMs`, default 20s, capped at `startupTimeoutMs`); on a launch timeout (ours
   * or Playwright's own -- see `isLaunchTimeoutFailure`), it force-kills whatever this profile's
   * browser tree still contains and waits for that to actually finish (`ensureProfileBrowsersGone`,
   * bounded by `firstLaunchKillWaitTimeoutMs`, default 10s), then retries exactly once with the
   * full `startupTimeoutMs` budget. A failure that is not a launch timeout (a profile lock, an
   * owned-profile exit, a missing executable, ...) is never retried here -- killing and relaunching
   * would not address any of those causes. Every later launch (a crash relaunch, a reset, an
   * interactive sign-in's own headed launch, ...) goes straight to the normal single-budget
   * `launchContext()` path.
   */
  private async launchWithFirstAttemptRetry(): Promise<BrowserContextLike> {
    if (this.firstLaunchAttempted) return this.launchContext();
    this.firstLaunchAttempted = true;
    const budgetMs = Math.min(
      this.options.firstLaunchTimeoutMs ?? DEFAULT_FIRST_LAUNCH_TIMEOUT_MS,
      this.options.startupTimeoutMs
    );
    try {
      return await this.launchContext({}, false, budgetMs);
    } catch (error) {
      if (!isLaunchTimeoutFailure(error)) throw error;
      this.log(
        `browser: first launch after broker start timed out after ${budgetMs}ms; killing the launched browser tree and retrying once`
      );
      await ensureProfileBrowsersGone(this.profile.profilePath, {
        timeoutMs: this.options.firstLaunchKillWaitTimeoutMs ?? DEFAULT_FIRST_LAUNCH_KILL_WAIT_MS,
        exec: this.options.processExec,
        killProcessTree: this.options.killProcessTree ?? defaultKillProcessTree,
        log: (line) => this.log(line)
      });
      return this.launchContext();
    }
  }

  private adoptAutomationContext(context: BrowserContextLike): void {
    this.context = context;
    context.on?.("close", () => {
      if (this.closingContextOwner === context) return;
      // Ignore an old or intentionally closed context after ownership has
      // already moved. It must never invalidate pages in a newer context.
      if (this.context !== context) return;
      this.discardCrashedContext(context);
    });
  }

  /** Shared by the real "close" event above and `start()`'s own liveness probe: both observe the
   * same fact (the automation context is gone without this manager having asked for that), so both
   * must invalidate every page it handed out the same way. */
  private discardCrashedContext(context: BrowserContextLike): void {
    if (this.context !== context) return;
    this.context = undefined;
    this.pagesByKey.clear();
    this.creatingPagesByKey.clear();
    this.closingPagesByKey.clear();
    this.options.onCrash?.();
    this.notifyInvalidated("crash");
  }

  /** Best-effort liveness probe for a retained context. `false` only when the context can
   * affirmatively prove its browser process is gone; a missing probe, a `null` browser handle, or
   * one that throws is treated as "still alive" so a flaky probe never forces an unnecessary
   * relaunch against a context that is actually fine. */
  private isContextAlive(context: BrowserContextLike): boolean {
    try {
      return context.browser?.()?.isConnected() ?? true;
    } catch {
      return true;
    }
  }
}

function isProfileLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /singletonlock|user data directory.*(already )?in use|already running|processsingleton/i.test(
    message
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The one error a cancelled sign-in produces, wherever it is observed (the manager's race, or the
 * poll loop that saw the signal first), so the caller never has to tell two cancellations apart. */
export function signInCancelled(): BrowserTransportError {
  return new BrowserTransportError("AUTH_FAILED", "The sign-in was cancelled.", undefined, {
    cancelled: true
  });
}

/** Settles as soon as either the work finishes or the signal is aborted. A losing `work` promise
 * keeps running (the sign-in window is already closing underneath it) but can never surface as an
 * unhandled rejection. */
async function raceCancellation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signInCancelled());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  cancelled.catch(() => undefined);
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    void work.catch(() => undefined);
  }
}

function signInInProgress(): BrowserTransportError {
  return new BrowserTransportError(
    "CONCURRENT_REQUEST",
    "An interactive sign-in is in progress; wait for it to finish or cancel it before resetting the profile.",
    "Finish or close the AgentPickLink sign-in window, then retry."
  );
}

class BrowserStartTimeout extends Error {
  constructor(timeout: number) {
    super(`The browser did not start within ${timeout} ms (browser.startupTimeoutMs).`);
    this.name = "BrowserStartTimeout";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserStartTimeout(timeout)), timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
