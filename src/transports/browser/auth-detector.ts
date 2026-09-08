import { COMPOSER_SELECTORS, MAIN_REGION_SELECTOR } from "./selectors/common.js";
import type { AuthState, PageLike } from "./types.js";

export interface AuthDetectorOptions {
  signInHosts?: string[];
  authenticatedMarkers?: Array<string | RegExp>;
  signInMarkers?: Array<string | RegExp>;
}

const DEFAULT_SIGN_IN = [/sign in/i, /サインイン/, /ログイン/, /enter password/i, /パスワードを入力/];
const DEFAULT_AUTHENTICATED = [/copilot/i, /microsoft 365/i, /新しいチャット/, /new chat/i];

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
    const url = safeUrl(page.url());
    if (url && this.signInHosts.has(url.hostname.toLowerCase())) return "interactive-auth";
    // Windows SSO may silently select the personal Copilot account. It is a signed-in chat,
    // but cannot supply the organization's agents. Keep the user-driven sign-in window open
    // until they choose their work/school account; never report a misleading successful setup.
    if (url?.hostname === "m365.cloud.microsoft") {
      try {
        const personal = page.getByRole?.("button", { name: /,\s*(personal account|個人用アカウント)$/i });
        if (personal && (await personal.count?.()) && (await personal.isVisible?.()))
          return "sign-in-required";
      } catch {
        /* A transitioning application shell is judged below. */
      }
    }
    const body = await this.visibleText(page);
    if (/access.?denied|禁止|権限がありません|not authorized/i.test(body)) return "access-denied";
    if (matches(body, this.signInMarkers) || /login|signin|oauth|authorize/i.test(url?.pathname ?? ""))
      return "sign-in-required";
    // Bare marker text ("Copilot", "Microsoft 365") is not enough: a sign-in
    // splash page or marketing shell can say those words too. Require an
    // actual chat structural signal (a main region or a composer) before
    // reporting the page as authenticated.
    if (matches(body, this.authenticatedMarkers) && (await this.hasStructuralSignal(page)))
      return "authenticated";
    return "unknown";
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
