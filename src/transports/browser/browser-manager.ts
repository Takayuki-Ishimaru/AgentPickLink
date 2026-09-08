import { ProfileManager } from "./profile-manager.js";
import { BrowserTransportError, type BrowserContextLike, type PageHandle } from "./types.js";

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
    if (this.contextCloseFailed)
      throw new BrowserTransportError(
        "BROWSER_PROFILE_LOCKED",
        "The dedicated browser profile is still owned by a browser context that did not close.",
        "Retry closing the AgentPickLink browser, then run: m365-agent broker restart"
      );
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
      await headed.close();
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
        await context.close();
        if (this.context === context) this.context = undefined;
        this.contextCloseFailed = undefined;
      } catch (error) {
        // Keep the context reference and fail closed: the browser may still own the profile even
        // when Playwright rejected close(), so a new launch must not race it.
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
    interactive = false
  ): Promise<BrowserContextLike> {
    const profilePath = await this.profile.prepare();
    if (!this.options.launcher)
      throw new BrowserTransportError(
        "BROWSER_START_FAILED",
        "No browser launcher is available to this broker.",
        "Reinstall AgentPickLink and run: m365-agent broker restart"
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
      ...(this.options.userAgent ? { userAgent: this.options.userAgent } : {}),
      ...(this.options.locale ? { locale: this.options.locale } : {}),
      ...(this.options.timezoneId ? { timezoneId: this.options.timezoneId } : {}),
      ...overrides
    };
    // A broker restart can release its IPC descriptor before Chromium/Edge has finished dropping
    // the OS-level profile lock. Retry only that bounded, known transient; never terminate or
    // interfere with an external browser that owns the profile.
    const retryDelays = [0, 100, 250, 500, 1_000] as const;
    const deadline = Date.now() + this.options.startupTimeoutMs;
    let lastError: unknown;
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
        if (!isProfileLockError(error) || attempt === retryDelays.length - 1) throw this.launchFailure(error);
        continue;
      }
      try {
        return await withTimeout(launch, remaining);
      } catch (error) {
        lastError = error;
        void launch.then((late) => late.close()).catch(() => undefined);
        if (!isProfileLockError(error) || attempt === retryDelays.length - 1) throw this.launchFailure(error);
      }
    }
    throw this.launchFailure(lastError ?? new BrowserStartTimeout(this.options.startupTimeoutMs));
  }

  /** Turns a raw launcher failure into the error code the user can act on. */
  private launchFailure(error: unknown): Error {
    if (error instanceof BrowserTransportError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (isProfileLockError(message))
      return new BrowserTransportError(
        "BROWSER_PROFILE_LOCKED",
        "The dedicated browser profile is already in use by another browser process.",
        "Another browser process is using the dedicated profile. Close the sign-in window or run: m365-agent broker restart"
      );
    if (
      /executable doesn't exist|executable.*(not found|does not exist)|browser.*not installed|channel.*not (found|installed)|distribution .*is not found|is not found at|spawn .*enoent/i.test(
        message
      )
    )
      return new BrowserTransportError(
        "BROWSER_START_FAILED",
        `The ${this.options.channel} browser could not be started: its executable was not found.`,
        `Install the ${this.options.channel} browser, or switch browser.channel to an installed browser (msedge, chrome, chromium) in the AgentPickLink panel's Advanced settings or config.yaml, then restart the broker (m365-agent broker restart).`
      );
    return new BrowserTransportError(
      "BROWSER_START_FAILED",
      `The ${this.options.channel} browser did not start: ${message}`,
      "Run: m365-agent broker restart"
    );
  }

  private async launch(): Promise<void> {
    const context = await this.launchContext();
    this.adoptAutomationContext(context);
  }

  private adoptAutomationContext(context: BrowserContextLike): void {
    this.context = context;
    context.on?.("close", () => {
      if (this.closingContextOwner === context) return;
      // Ignore an old or intentionally closed context after ownership has
      // already moved. It must never invalidate pages in a newer context.
      if (this.context !== context) return;
      this.context = undefined;
      this.pagesByKey.clear();
      this.creatingPagesByKey.clear();
      this.closingPagesByKey.clear();
      this.options.onCrash?.();
      this.notifyInvalidated("crash");
    });
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
