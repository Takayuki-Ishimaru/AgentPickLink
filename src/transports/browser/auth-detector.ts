import { COMPOSER_SELECTORS, MAIN_REGION_SELECTOR } from "./selectors/common.js";
import type { AuthState, PageLike } from "./types.js";

export interface AuthDetectorOptions {
  signInHosts?: string[];
  authenticatedMarkers?: Array<string | RegExp>;
  signInMarkers?: Array<string | RegExp>;
}

const DEFAULT_SIGN_IN = [/sign in/i, /サインイン/, /ログイン/, /enter password/i, /パスワードを入力/];
const DEFAULT_AUTHENTICATED = [/copilot/i, /microsoft 365/i, /新しいチャット/, /new chat/i];

/** Which structural check inside `detect()`/`detectVerdict()` produced a given verdict --
 * metadata only (a fixed tag, never DOM text or a URL), attached to a verdict so a diagnostic can
 * show *why* a sign-in state was reported (see ISSUE-2026-09-14-05,
 * `src/transports/browser/session-manager.ts`'s `runProbe()`). */
export type AuthDetectionRule =
  | "sign-in-host"
  | "personal-account-selected"
  | "access-denied-marker"
  | "sign-in-marker-or-path"
  | "authenticated-structural"
  | "no-match"
  | "detect-error";

export type AuthVerdict = { state: AuthState; rule: AuthDetectionRule };

/** Detects visible authentication state only; it never reads cookies/tokens. */
export class AuthDetector {
  private readonly signInHosts: Set<string>;
  private readonly authenticatedMarkers: Array<string | RegExp>;
  private readonly signInMarkers: Array<string | RegExp>;
  constructor(options: AuthDetectorOptions = {}) {
    this.signInHosts = new Set((options.signInHosts ?? []).map((h) => h.toLowerCase()));
    this.authenticatedMarkers = options.authenticatedMarkers ?? DEFAULT_AUTHENTICATED;
    this.signInMarkers = options.signInMarkers ?? DEFAULT_SIGN_IN;
  }
  async detect(page: PageLike): Promise<AuthState> {
    return (await this.detectVerdict(page)).state;
  }
  /** Same checks and order as `detect()`, but also reports which one fired -- see
   * `AuthDetectionRule`. Kept as the single implementation (`detect()` is a thin wrapper) so the
   * two can never drift apart. */
  async detectVerdict(page: PageLike): Promise<AuthVerdict> {
    const url = safeUrl(page.url());
    if (url && this.signInHosts.has(url.hostname.toLowerCase()))
      return { state: "interactive-auth", rule: "sign-in-host" };
    // Windows SSO may silently select the personal Copilot account. It is a signed-in chat,
    // but cannot supply the organization's agents. Keep the user-driven sign-in window open
    // until they choose their work/school account; never report a misleading successful setup.
    if (url?.hostname === "m365.cloud.microsoft") {
      try {
        const personal = page.getByRole?.("button", { name: /,\s*(personal account|個人用アカウント)$/i });
        if (personal && (await personal.count?.()) && (await personal.isVisible?.()))
          return { state: "sign-in-required", rule: "personal-account-selected" };
      } catch {
        /* A transitioning application shell is judged below. */
      }
    }
    const body = await this.visibleText(page);
    if (/access.?denied|禁止|権限がありません|not authorized/i.test(body))
      return { state: "access-denied", rule: "access-denied-marker" };
    if (matches(body, this.signInMarkers) || /login|signin|oauth|authorize/i.test(url?.pathname ?? ""))
      return { state: "sign-in-required", rule: "sign-in-marker-or-path" };
    // Bare marker text ("Copilot", "Microsoft 365") is not enough: a sign-in
    // splash page or marketing shell can say those words too. Require an
    // actual chat structural signal (a main region or a composer) before
    // reporting the page as authenticated.
    if (matches(body, this.authenticatedMarkers) && (await this.hasStructuralSignal(page)))
      return { state: "authenticated", rule: "authenticated-structural" };
    return { state: "unknown", rule: "no-match" };
  }
  private async visibleText(page: PageLike): Promise<string> {
    try {
      if (page.evaluate) return await page.evaluate(() => document.body?.innerText || "");
    } catch {
      /* fall through to semantic locators */
    }
    try {
      return (await page.locator?.("body")?.textContent?.()) ?? "";
    } catch {
      return "";
    }
  }
  private async hasStructuralSignal(page: PageLike): Promise<boolean> {
    try {
      if (page.evaluate)
        return await page.evaluate(
          (sel: { main: string; composer: string }) =>
            !!document.querySelector(sel.main) || !!document.querySelector(sel.composer),
          { main: MAIN_REGION_SELECTOR, composer: COMPOSER_SELECTORS[0] }
        );
    } catch {
      /* fall through to locator probe */
    }
    try {
      const count = await page.locator?.(MAIN_REGION_SELECTOR)?.count?.();
      if (count !== undefined) return count > 0;
    } catch {
      /* no locator support */
    }
    return false;
  }
}
export async function detectAuthState(page: PageLike, options?: AuthDetectorOptions): Promise<AuthState> {
  return new AuthDetector(options).detect(page);
}
function matches(value: string, markers: Array<string | RegExp>): boolean {
  return markers.some((m) => (typeof m === "string" ? value.includes(m) : m.test(value)));
}
function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
