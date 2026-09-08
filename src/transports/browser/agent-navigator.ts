import { AuthDetector } from "./auth-detector.js";
import { NavigationPolicy } from "./navigation-policy.js";
import {
  BrowserTransportError,
  type AuthState,
  type BrowserAgentDefinition,
  type PageLike
} from "./types.js";
import type { ChatUiAdapter } from "./ui-adapter.js";

/** The single "the dedicated automation profile is not signed in" failure. Every browser-layer
 * sign-in path raises exactly this error so the VS Code panel (and the CLI) always shows one
 * consistent remediation. */
export function signInRequired(): BrowserTransportError {
  return new BrowserTransportError(
    "AUTH_REQUIRED",
    "Microsoft 365 sign-in is required for the dedicated automation profile.",
    "Sign in from the AgentPickLink panel in VS Code (or run: m365-agent login)."
  );
}

/** Sign-in left the approved boundary: the tenant redirected to an identity provider that is not
 * in `navigation.authHosts`. This is an authentication-configuration problem, not an attempted
 * policy violation, so it is reported as AUTH_REQUIRED with the offending host only (never a
 * path or query, which can carry request-scoped identifiers). */
export function unknownAuthHost(hostname: string): BrowserTransportError {
  return new BrowserTransportError(
    "AUTH_REQUIRED",
    `Microsoft 365 sign-in was redirected to ${hostname}, which is not an approved authentication host.`,
    `Sign-in was redirected to ${hostname}, which is not in navigation.authHosts. Add the exact host to authHosts (config.yaml) and restart the broker, or sign in from the AgentPickLink panel.`,
    // Marks this as a configuration gap rather than "the user simply has to sign in", so callers
    // that normally translate AUTH_REQUIRED into a state can still surface it as an error.
    { unlistedAuthHost: hostname }
  );
}

/**
 * Attaches an ordered, deduplicated (consecutive-run) list of hostnames -- never a path or query
 * -- to whatever error is escaping a navigation/sign-in wait, so an AUTH_REQUIRED/AUTH_FAILED/
 * POLICY_BLOCKED incident can show which hosts the page actually visited while waiting. Handles
 * both a BrowserTransportError (mutated in place; a fingerprint or hosts list already attached by
 * an inner layer is never overwritten) and the plain, `.code`-tagged Error NavigationPolicy raises
 * (see navigation-policy.ts's `policyError`), which carries no `details` field of its own. A caller
 * with an empty hosts list is a no-op. Never throws.
 */
export function attachHosts(error: unknown, hosts: readonly string[]): void {
  if (!hosts.length || !error || typeof error !== "object") return;
  if (error instanceof BrowserTransportError) {
    if (!error.details?.hosts) error.details = { ...error.details, hosts: [...hosts] };
    return;
  }
  const tagged = error as { code?: unknown; details?: unknown };
  if (typeof tagged.code === "string" && tagged.details === undefined)
    (tagged as { details?: unknown }).details = { hosts: [...hosts] };
}

export class AgentNavigator {
  private readonly auth: AuthDetector;
  private readonly navigationErrors = new WeakMap<object, Error>();
  constructor(
    private readonly policy: NavigationPolicy,
    auth = new AuthDetector()
  ) {
    this.auth = auth;
  }
  async open(
    page: PageLike,
    agent: BrowserAgentDefinition,
    adapter: ChatUiAdapter,
    options: { allowAuth?: boolean; timeoutMs?: number } = {}
  ): Promise<void> {
    const target = this.policy.validateAgentEntryPoint(agent);
    if (!page.goto)
      throw new BrowserTransportError(
        "AGENT_PAGE_UNAVAILABLE",
        "Browser navigation is unavailable for the agent page."
      );
    const timeoutMs = options.timeoutMs ?? 45_000;
    const deadline = Date.now() + timeoutMs;
    const directTarget = !!directAgentId(target);
    let restored = false;
    const stopWatching = this.watch(page, "app-or-auth");
    try {
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
      // domcontentloaded and the application hostname can both precede the chat composer.
      // Keep the same deadline and navigation watcher through rendering and silent auth.
      for (;;) {
        this.assertNavigationSafe(page, "app-or-auth");
        await this.awaitAppLanding(page, deadline, options.allowAuth);
        this.assertNavigationSafe(page, "app-or-auth");
        if (!this.policy.appHosts.has(new URL(page.url()).hostname.toLowerCase())) {
          if (options.allowAuth) return;
          throw signInRequired();
        }
        const authState = await this.auth.detect(page);
        if (authState === "sign-in-required" || authState === "interactive-auth") {
          if (options.allowAuth) return;
          throw signInRequired();
        }
        if (authState === "access-denied")
          throw new BrowserTransportError("AUTH_FAILED", "Microsoft 365 access was denied.");

        const match = await adapter.canHandle(page);
        this.assertNavigationSafe(page, "app-or-auth");
        const current = new URL(page.url());
        const onApp = this.policy.appHosts.has(current.hostname.toLowerCase());
        const onTarget =
          !directTarget || (current.hostname === target.hostname && current.pathname === target.pathname);
        if (onApp && onTarget && match.matched && match.confidence !== "none") return;
        if (Date.now() >= deadline)
          throw new BrowserTransportError(
            onApp && !onTarget ? "AGENT_CONTEXT_CHANGED" : "UI_CHANGED",
            onApp && !onTarget
              ? "Microsoft 365 did not restore the requested direct agent route after authentication."
              : "A supported Microsoft 365 chat structure was not detected before the navigation timeout.",
            undefined,
            { submissionState: "not-sent" }
          );

        // A late silent-auth bounce can leave ordinary Copilot on screen. Restore once only,
        // after the application renders; the next iteration verifies both the route and UI.
        if (onApp && !onTarget && !restored && (authState === "authenticated" || match.matched)) {
          restored = true;
          await this.restoreDirectAgentTarget(page, target, deadline);
          continue;
        }
        await wait(Math.min(500, deadline - Date.now()), page);
      }
    } finally {
      stopWatching();
    }
  }
  private async restoreDirectAgentTarget(page: PageLike, target: URL, deadline: number): Promise<void> {
    const agentId = directAgentId(target);
    if (!agentId) return;
    const row = page.locator?.(`[data-agent-id="${agentId}"]`);
    const count = (await row?.count?.()) ?? 0;
    for (let index = 0; index < count; index++) {
      const candidate = count > 1 ? row?.nth?.(index) : row;
      if (!candidate || !((await candidate.isVisible?.()) ?? true) || !candidate.click) continue;
      if (Date.now() >= deadline) return;
      await candidate.click({ timeout: Math.max(1, deadline - Date.now()) });
      await wait(Math.max(0, Math.min(500, deadline - Date.now())), page);
      this.assertNavigationSafe(page, "app-or-auth");
      const current = new URL(page.url());
      if (current.hostname === target.hostname && current.pathname === target.pathname) return;
      break;
    }
    if (Date.now() >= deadline) return;
    // Unpinned agents have no sidebar row. Replay only the already-validated direct URL.
    this.assertNavigationSafe(page, "app-or-auth");
    await page.goto?.(target.toString(), {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1, deadline - Date.now())
    });
  }
  /**
   * The navigation check for the sign-in-shaped context: an application host or an allowlisted
   * authentication host is fine, and a well-formed destination whose host is on neither list is an
   * unlisted identity provider (AUTH_REQUIRED with the host name), not an attempt to leave the
   * boundary. Anything else -- a non-HTTPS URL, embedded credentials, a private target -- keeps its
   * POLICY_BLOCKED refusal, and so does every navigation in the locked "app" context.
   */
  private assertAppOrAuthUrl(url: string): void {
    try {
      this.policy.assertRedirect(url, "app");
      return;
    } catch {
      /* an authentication host is equally acceptable here */
    }
    try {
      this.policy.assertRedirect(url, "auth");
    } catch (error) {
      const host = hostnameOf(url);
      if (host && this.policy.isHostOnlyRefusal(url)) throw unknownAuthHost(host);
      throw error;
    }
  }
  watch(page: PageLike, state: "app" | "auth" | "app-or-auth" = "app"): () => void {
    this.navigationErrors.delete(page as object);
    const popupCleanups = new Map<PageLike, () => void>();
    const validate = (url: string) => {
      if (state === "app-or-auth") this.assertAppOrAuthUrl(url);
      else this.policy.assertRedirect(url, state);
    };
    const onFrame = (frame: any) => {
      if (!frame || typeof frame.url !== "function") return;
      const main = page.mainFrame?.();
      if (main && frame !== main) return;
      if (!main && typeof frame.parentFrame === "function" && frame.parentFrame() !== null) return;
      try {
        validate(frame.url());
      } catch (error) {
        this.navigationErrors.set(page as object, error as Error);
      }
    };
    const blockPopup = (popup: PageLike, error: unknown) => {
      this.navigationErrors.set(
        page as object,
        error instanceof Error
          ? error
          : new BrowserTransportError(
              "POLICY_BLOCKED",
              "A popup navigated outside the approved authentication boundary."
            )
      );
      void popup.close?.();
    };
    const onPopup = (popup: PageLike) => {
      if (state !== "app-or-auth") {
        blockPopup(
          popup,
          new BrowserTransportError(
            "POLICY_BLOCKED",
            "An unexpected popup opened during a locked agent operation."
          )
        );
        return;
      }
      const onPopupFrame = (frame: any) => {
        if (!frame || typeof frame.url !== "function") return;
        const main = popup.mainFrame?.();
        if (main && frame !== main) return;
        if (!main && typeof frame.parentFrame === "function" && frame.parentFrame() !== null) return;
        try {
          validate(frame.url());
        } catch (error) {
          blockPopup(popup, error);
        }
      };
      popup.on?.("framenavigated", onPopupFrame);
      popupCleanups.set(popup, () => popup.off?.("framenavigated", onPopupFrame));
      const initialUrl = popup.url();
      // Playwright reports about:blank until the popup's first main-frame navigation.
      if (initialUrl && initialUrl !== "about:blank") {
        try {
          validate(initialUrl);
        } catch (error) {
          blockPopup(popup, error);
        }
      }
    };
    page.on?.("framenavigated", onFrame);
    page.on?.("popup", onPopup);
    return () => {
      page.off?.("framenavigated", onFrame);
      page.off?.("popup", onPopup);
      for (const [popup, cleanup] of popupCleanups) {
        cleanup();
        void popup.close?.();
      }
      popupCleanups.clear();
    };
  }
  assertNavigationSafe(page: PageLike, state: "app" | "auth" | "app-or-auth" = "app"): void {
    const failure = this.navigationErrors.get(page as object);
    if (failure) {
      this.navigationErrors.delete(page as object);
      throw failure;
    }
    if (state === "app-or-auth") this.assertAppOrAuthUrl(page.url());
    else this.policy.assertRedirect(page.url(), state);
  }
  async authState(page: PageLike) {
    return this.auth.detect(page);
  }
  /**
   * Keeps judging the page until it is definitively `authenticated` or `access-denied`, or the
   * deadline passes.
   *
   * Microsoft 365 answers on the application host with the application shell first and completes
   * the sign-in handshake client-side afterwards: a perfectly valid session may still hop to the
   * login host and back after `domcontentloaded`, and the chat structure the detector requires
   * appears only once the application has rendered. Judging once on arrival reports that session
   * as "unknown". So an intermediate state on the application host (an empty shell, the OpenID
   * Connect callback path) is a keep-waiting state, an authentication host goes back through the
   * landing wait, and whatever the detector sees at the deadline is the result. Still being on an
   * authentication host at the deadline raises AUTH_REQUIRED from the landing wait.
   */
  async settleAuthState(
    page: PageLike,
    deadlineMs: number,
    options: { pollMs?: number; onPoll?: () => void } = {}
  ): Promise<AuthState> {
    const pollMs = options.pollMs ?? 500;
    for (;;) {
      await this.awaitAppLanding(page, deadlineMs);
      let state: AuthState;
      try {
        state = await this.auth.detect(page);
      } catch {
        // A navigation in flight is a keep-waiting state, never a result.
        state = "unknown";
      }
      if (state === "authenticated" || state === "access-denied") return state;
      if (Date.now() >= deadlineMs) return state;
      options.onPoll?.();
      await wait(pollMs, page);
    }
  }
  /**
   * Waits until the page has landed back on an application host. Microsoft 365 bounces through the
   * login host even with a valid session, so an allowlisted authentication host is a "keep waiting"
   * state, not a failure: still being there at the deadline means sign-in is genuinely required.
   * A host that is neither an application host nor an allowlisted authentication host is reported
   * as AUTH_REQUIRED naming that host (an unlisted federated identity provider is a configuration
   * gap, not an attempted policy violation); a URL with no usable host still fails the policy.
   * This is the single auth-landing wait used by navigation, capture, inspection and discovery.
   *
   * `allowAuth` is for callers that drive the sign-in themselves: they get control back instead of
   * an error when the page is still on the authentication host at the deadline.
   */
  async awaitAppLanding(page: PageLike, deadlineMs: number, allowAuth = false): Promise<void> {
    // Ordered, deduplicated (consecutive-run) hostnames the page visited while this wait ran --
    // never a path or query -- attached to whatever AUTH_REQUIRED/AUTH_FAILED/POLICY_BLOCKED
    // error escapes below, so an incident can show what the landing sequence actually looked like.
    const hosts: string[] = [];
    try {
      for (;;) {
        const currentUrl = page.url();
        const host = hostnameOf(currentUrl);
        if (host && hosts[hosts.length - 1] !== host) hosts.push(host);
        if (!host) {
          // No usable hostname (about:blank, a malformed URL): keep the policy refusal.
          this.policy.validate(currentUrl, "app");
          return;
        }
        if (this.policy.appHosts.has(host)) {
          this.policy.validate(currentUrl, "app");
          return;
        }
        if (!this.policy.authHosts.has(host)) {
          if (this.policy.isHostOnlyRefusal(currentUrl)) throw unknownAuthHost(host);
          // Not host-shaped at all (a non-HTTPS or private target): keep the policy refusal.
          this.policy.validate(currentUrl, "app");
          return;
        }
        this.policy.validate(currentUrl, "auth");
        if (Date.now() >= deadlineMs) {
          if (allowAuth) return;
          throw signInRequired();
        }
        await wait(Math.min(500, deadlineMs - Date.now()), page);
      }
    } catch (error) {
      attachHosts(error, hosts);
      throw error;
    }
  }
}

function hostnameOf(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function directAgentId(url: URL): string | undefined {
  const match = /^\/chat\/agent\/([^/]+)\/?$/i.exec(url.pathname);
  if (!match?.[1]) return undefined;
  const decoded = decodeURIComponent(match[1]);
  return /^[A-Za-z0-9._-]+$/.test(decoded) ? decoded : undefined;
}

async function wait(ms: number, page: PageLike): Promise<void> {
  if (page.waitForTimeout) await page.waitForTimeout(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}
