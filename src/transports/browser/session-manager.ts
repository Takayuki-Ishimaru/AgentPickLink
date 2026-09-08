import { randomBytes } from "node:crypto";
import type { ProgressSink } from "../../domain/progress.js";
import { AgentNavigator, attachHosts } from "./agent-navigator.js";
import { AuthDetector } from "./auth-detector.js";
import { BrowserManager, signInCancelled } from "./browser-manager.js";
import { neutralLandingUrl } from "./landing.js";
import { NavigationPolicy } from "./navigation-policy.js";
import { BrowserTransportError, type AuthState, type BrowserContextLike, type PageLike } from "./types.js";

export interface SessionManagerOptions {
  manager: BrowserManager;
  policy: NavigationPolicy;
  navigator: AgentNavigator;
  appHosts: string[];
  authHosts?: string[];
  /** Overrides the derived `https://<appHosts[0]>/chat` landing target (development/mock app). */
  neutralAppUrl?: string;
  navigationTimeoutMs?: number;
  /** How long a status probe keeps judging the page -- through Microsoft 365's silent-auth bounce
   * and until the application has actually rendered -- before reporting whatever it last saw.
   * Deliberately shorter than the navigation timeout: the probe is a status check, not an
   * operation the user is waiting on. */
  authLandingTimeoutMs?: number;
  /** The same budget for the verification probe that runs right after an interactive sign-in. The
   * user *is* waiting on that one, and the application host answers with its shell long before the
   * chat has rendered, so it defaults to the full navigation timeout instead. */
  verificationTimeoutMs?: number;
  /** Sign-in window poll interval. */
  pollIntervalMs?: number;
  /** Minimum spacing between `login-waiting` progress events. */
  progressIntervalMs?: number;
}

/** Prefix only: every actual probe run uses its own suffixed page key. Routine concurrent status
 * callers are coalesced before a run begins (see `probe`); independently budgeted probes remain
 * isolated and never share or close each other's page. */
export const AUTH_PROBE_PAGE_KEY = "authentication-health";

/** A probe result plus where the page was when it was judged: still on an authentication host at
 * the deadline (authentication could not be confirmed) or on an application host (whatever the
 * detector last saw there). */
interface ProbeOutcome {
  state: AuthState;
  checkedAt: string;
  settledOn: "app" | "auth";
}

/**
 * Owns everything authentication-related for the browser transport.
 *
 * The automation context is hidden, so an interactive sign-in runs in a separate **visible**
 * window on the same dedicated profile directory (see `BrowserManager.runInteractiveLogin`).
 * Navigation inside that window is user-driven — the tenant may bounce through any federated
 * identity provider — so the navigation watcher is deliberately not installed there and an unknown
 * host is never a policy failure. Only the *result* is checked: the window must end up on an
 * application host with a structurally authenticated page. Cookies and tokens are never read,
 * exported or copied. Windows retains the same process and hides its windows; other launchers
 * may hand off by restarting on the dedicated profile directory.
 */
export class SessionManager {
  private readonly manager: BrowserManager;
  private readonly policy: NavigationPolicy;
  private readonly navigator: AgentNavigator;
  private readonly detector: AuthDetector;
  private readonly appHosts: string[];
  private readonly neutralAppUrl?: string;
  private readonly navigationTimeoutMs: number;
  private readonly authLandingTimeoutMs: number;
  private readonly verificationTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly progressIntervalMs: number;
  /** Status reads are often triggered together by the panel, CLI and MCP health checks. They all
   * answer the same question, so share one short-lived page instead of creating one per caller. */
  private probeInFlight?: Promise<{ state: AuthState; checkedAt: string }>;

  constructor(options: SessionManagerOptions) {
    this.manager = options.manager;
    this.policy = options.policy;
    this.navigator = options.navigator;
    this.appHosts = options.appHosts;
    this.neutralAppUrl = options.neutralAppUrl;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 45_000;
    this.authLandingTimeoutMs = options.authLandingTimeoutMs ?? 10_000;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? this.navigationTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.progressIntervalMs = options.progressIntervalMs ?? 2_000;
    this.detector = new AuthDetector({ signInHosts: options.authHosts ?? [] });
  }

  /** True when a landing target is configured at all. */
  get configured(): boolean {
    return !!this.neutralAppUrl || this.appHosts.length > 0;
  }

  /** The chat route of the first application host (see `neutralLandingUrl` for why never the root). */
  landingUrl(): string {
    return neutralLandingUrl(this.appHosts, this.neutralAppUrl);
  }

  /** Hidden-context authentication probe on a short-lived, dedicated page. */
  async probe(options: { timeoutMs?: number } = {}): Promise<{ state: AuthState; checkedAt: string }> {
    // A caller that supplied a distinct deadline needs that exact budget and therefore does not
    // join the routine status-check flight.
    if (options.timeoutMs !== undefined) {
      const { state, checkedAt } = await this.runProbe(options.timeoutMs);
      return { state, checkedAt };
    }
    if (this.probeInFlight) return this.probeInFlight;
    const flight = this.runProbe(this.authLandingTimeoutMs).then(({ state, checkedAt }) => ({
      state,
      checkedAt
    }));
    this.probeInFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.probeInFlight === flight) this.probeInFlight = undefined;
    }
  }

  private async runProbe(timeoutMs: number, onPoll?: () => void): Promise<ProbeOutcome> {
    const target = this.landingUrl();
    this.policy.validate(target, "app");
    const pageKey = `${AUTH_PROBE_PAGE_KEY}-${randomBytes(6).toString("hex")}`;
    const handle = await this.manager.createConversationPage(pageKey);
    const page = handle.page;
    const stopWatching = this.navigator.watch(page, "app-or-auth");
    try {
      await page.goto?.(target, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
      this.navigator.assertNavigationSafe(page, "app-or-auth");
      const state = await this.settle(page, Date.now() + timeoutMs, onPoll);
      return { state, checkedAt: new Date().toISOString(), settledOn: "app" };
    } catch (error) {
      // "Sign-in is required" is a probe *result*, not a probe failure. An unlisted identity
      // provider is different: nothing the user does in the panel fixes it, so it stays an error.
      if (
        error instanceof BrowserTransportError &&
        error.code === "AUTH_REQUIRED" &&
        !error.details?.unlistedAuthHost
      )
        return { state: "sign-in-required", checkedAt: new Date().toISOString(), settledOn: "auth" };
      throw error;
    } finally {
      stopWatching();
      await this.manager.closePage(pageKey).catch(() => undefined);
    }
  }

  /** The shared "keep judging until the application has rendered" wait (see
   * `AgentNavigator.settleAuthState`): the application host answers with its shell long before the
   * chat structure the detector requires exists, so a single judgement on arrival is wrong. */
  private settle(page: PageLike, deadlineMs: number, onPoll?: () => void): Promise<AuthState> {
    return this.navigator.settleAuthState(page, deadlineMs, { pollMs: this.pollIntervalMs, onPoll });
  }

  /**
   * Signs in interactively in the visible window and hands the session to the hidden automation
   * context. A session-preserving launcher retains the process; other launchers restart on the
   * same profile. Success also requires a fresh automation page to confirm authentication.
   */
  async interactiveLogin(
    timeoutMs = 300_000,
    onProgress?: ProgressSink,
    signal?: AbortSignal
  ): Promise<{ authenticated: true; state: "authenticated" }> {
    const target = this.landingUrl();
    this.policy.validate(target, "app");
    const started = Date.now();
    // Ordered, deduplicated (consecutive-run) hostnames the visible window visited -- never a path
    // or query -- attached to whatever AUTH_FAILED escapes this method, so a sign-in incident can
    // show the landing sequence without ever reading page content.
    const hosts: string[] = [];
    const recordHost = (page: PageLike) => {
      const host = hostnameOfUrl(page.url());
      if (host && hosts[hosts.length - 1] !== host) hosts.push(host);
    };
    try {
      await this.manager.runInteractiveLogin(
        async (context, cancelled) => {
          const page = await signInWindowPage(context);
          let windowClosed = false;
          const markClosed = () => {
            windowClosed = true;
          };
          context.on?.("close", markClosed);
          page.on?.("close", markClosed);
          // The window is user-driven from here on: no navigation watcher, no popup blocker.
          await page.goto?.(target, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
          let lastProgressAt = 0;
          const emitWaiting = () => {
            const now = Date.now();
            if (!onProgress || now - lastProgressAt < this.progressIntervalMs) return;
            lastProgressAt = now;
            onProgress({
              phase: "login-waiting",
              elapsedMs: now - started,
              message: "Waiting for sign-in in the AgentPickLink window"
            });
          };
          emitWaiting();
          const deadline = started + timeoutMs;
          while (Date.now() < deadline) {
            // Checked every iteration so a cancel is observed even while the poll below is awaiting:
            // the window is already closing underneath this loop when that happens.
            if (cancelled.aborted) throw signInCancelled();
            if (windowClosed || page.isClosed?.() === true)
              throw new BrowserTransportError(
                "AUTH_FAILED",
                "The sign-in window was closed before sign-in completed."
              );
            recordHost(page);
            const state = await this.safeDetect(page);
            if (state === "access-denied")
              throw new BrowserTransportError("AUTH_FAILED", "Microsoft 365 access was denied.");
            if (state === "authenticated" && this.onApplicationHost(page.url())) {
              onProgress?.({
                phase: "login-closing",
                elapsedMs: Date.now() - started,
                message: "Sign-in completed; closing the sign-in window"
              });
              return;
            }
            emitWaiting();
            await sleep(this.pollIntervalMs, page);
          }
          throw new BrowserTransportError("AUTH_FAILED", "Interactive Microsoft 365 sign-in timed out.");
        },
        signal ? { signal } : {}
      );
      // The sign-in window and the automation context share only the profile directory. A
      // nonpersistent session can be lost on browser close, including when tenant policy never
      // offers "Stay signed in". Windows keeps the process alive instead. In either case the
      // handoff is not complete until a new automation page can see it for itself. It gets the shell first and the
      // rendered chat only later, so this probe keeps judging for the full verification budget
      // and reports progress while it does.
      let lastVerifyingAt = 0;
      const emitVerifying = () => {
        const now = Date.now();
        if (!onProgress || now - lastVerifyingAt < this.progressIntervalMs) return;
        lastVerifyingAt = now;
        onProgress({
          phase: "verifying",
          elapsedMs: now - started,
          message: "Verifying the session in the hidden browser"
        });
      };
      emitVerifying();
      const verified = await this.runProbe(this.verificationTimeoutMs, emitVerifying);
      if (verified.state !== "authenticated")
        throw handoffFailure(verified, this.verificationTimeoutMs, this.manager.keepsSignedInProcess());
      onProgress?.({
        phase: "done",
        elapsedMs: Date.now() - started,
        message: "The dedicated automation profile is signed in"
      });
      return { authenticated: true, state: "authenticated" };
    } catch (error) {
      attachHosts(error, hosts);
      throw error;
    }
  }

  private onApplicationHost(value: string): boolean {
    let hostname: string;
    try {
      hostname = new URL(value).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (this.policy.appHosts.has(hostname)) return true;
    try {
      return !!this.neutralAppUrl && new URL(this.neutralAppUrl).hostname.toLowerCase() === hostname;
    } catch {
      return false;
    }
  }

  private async safeDetect(page: PageLike): Promise<AuthState> {
    try {
      return await this.detector.detect(page);
    } catch {
      // A navigation in flight (or a just-closed window) is a keep-waiting state, never a result.
      return "unknown";
    }
  }
}

/**
 * The two ways the post-sign-in verification can fail, told apart by what the hidden probe saw.
 * Still on the login host at the deadline, or a sign-in page rendered on the application host
 * itself (Microsoft 365 answers its host root that way when signed out): authentication did not
 * survive the handoff, but this observation cannot identify the reason or the user's choices. On the
 * application host and never rendered as signed in, with no sign-in page in sight: the session is
 * most likely there and the page did not finish loading in the hidden browser within the budget --
 * a retry, not a re-authentication, is the remedy. Telling the user to re-authenticate in that
 * case sends them in the wrong direction.
 */
function handoffFailure(
  outcome: ProbeOutcome,
  timeoutMs: number,
  sameProcess = false
): BrowserTransportError {
  const verification = { state: outcome.state, settledOn: outcome.settledOn };
  if (sameProcess)
    return new BrowserTransportError(
      "AUTH_FAILED",
      "The sign-in appeared complete, but a new automation tab could not confirm the signed-in Microsoft 365 page. The browser process was kept running.",
      "Retry setup. If this persists, copy the diagnostics; choosing 'Stay signed in' is not required for this background handoff.",
      { verification, handoff: "same-process" }
    );
  if (
    outcome.settledOn === "auth" ||
    outcome.state === "sign-in-required" ||
    outcome.state === "interactive-auth"
  )
    return new BrowserTransportError(
      "AUTH_FAILED",
      "The sign-in appeared complete in the window, but the automation browser requested sign-in again after the window was closed. The session could not be confirmed after the browser restart.",
      "If Microsoft offers 'Stay signed in', choose it if permitted by your organization. This prompt may be hidden by your organization's settings; its absence does not mean you missed a step. If it is not offered or the error repeats, copy the diagnostics and report that the session was lost after the sign-in window closed. Repeated sign-in attempts may not resolve a nonpersistent session.",
      { verification }
    );
  return new BrowserTransportError(
    "AUTH_FAILED",
    `The sign-in completed in the window, but the hidden browser could not confirm the signed-in Microsoft 365 page within ${Math.round(timeoutMs / 1000)} s (last state: ${outcome.state}).`,
    "Retry the sign-in. If this keeps happening, set browser.headless to false in the AgentPickLink panel's Advanced settings to check whether the page renders only in a visible browser, then copy the diagnostics and report them.",
    { verification }
  );
}

function hostnameOfUrl(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

async function signInWindowPage(context: BrowserContextLike): Promise<PageLike> {
  const existing = context.pages().find((page) => page.isClosed?.() !== true);
  const page = existing ?? (context.newPage ? await context.newPage() : undefined);
  if (!page)
    throw new BrowserTransportError(
      "BROWSER_START_FAILED",
      "The interactive Microsoft 365 sign-in window could not be opened."
    );
  return page;
}

async function sleep(ms: number, page: PageLike): Promise<void> {
  try {
    if (page.waitForTimeout) {
      await page.waitForTimeout(ms);
      return;
    }
  } catch {
    // A closed window rejects waitForTimeout; the next loop iteration reports the closure.
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}
