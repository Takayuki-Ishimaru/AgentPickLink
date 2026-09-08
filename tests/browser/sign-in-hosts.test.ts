import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthDetector } from "../../src/transports/browser/auth-detector.js";
import { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import { BrowserTransport } from "../../src/transports/browser/browser-transport.js";
import type { BrowserContextLike, PageLike } from "../../src/transports/browser/types.js";

/** A hidden-context fake whose landing page looks authenticated; `redirectTo` simulates the app
 * bouncing the probe to another host. */
async function transportWith(authHosts: string[], redirectTo?: string): Promise<BrowserTransport> {
  const profilePath = path.join(await mkdtemp(path.join(os.tmpdir(), "apl-signin-hosts-")), "profile");
  let currentUrl = "about:blank";
  const page: PageLike = {
    url: () => currentUrl,
    goto: async (target) => {
      currentUrl = redirectTo ?? target;
    },
    evaluate: async (fn: unknown) =>
      String(fn).includes("document.body") ? "Microsoft 365 Copilot 新しいチャット" : true,
    waitForTimeout: async () => undefined,
    close: async () => undefined,
    on: () => undefined,
    off: () => undefined
  };
  const context: BrowserContextLike = {
    pages: () => [],
    newPage: async () => page,
    close: async () => undefined,
    on: () => undefined
  };
  const manager = new BrowserManager({
    profilePath,
    launcher: { launchPersistentContext: async () => context }
  });
  return new BrowserTransport({
    manager,
    appHosts: ["m365.example.test"],
    authHosts,
    adapters: [],
    // The probe waits for Microsoft 365's silent-auth bounce; this fake never leaves the login
    // host, so keep that wait short instead of spending the production default on it.
    authLandingTimeoutMs: 20
  });
}

describe("sign-in host filtering", () => {
  it("never treats an application host as a sign-in host, even when authHosts also lists it", async () => {
    // A misconfiguration (or a tenant that serves sign-in from the app host) must not make every
    // page look like "interactive-auth" and stall the sign-in flow until it times out.
    const transport = await transportWith(["m365.example.test", "login.example.test"]);
    await expect(transport.authenticationState()).resolves.toMatchObject({ state: "authenticated" });
    await transport.dispose();
  });

  it("classifies a genuine sign-in host as interactive-auth", async () => {
    // The host filter itself is unchanged: a page sitting on an allowlisted sign-in host is
    // interactive-auth, whatever its content says.
    const detector = new AuthDetector({ signInHosts: ["login.example.test"] });
    await expect(detector.detect({ url: () => "https://login.example.test/oauth2" })).resolves.toBe(
      "interactive-auth"
    );
  });

  it("reports sign-in-required when the probe never lands back on an application host", async () => {
    // Microsoft 365 bounces through the login host even with a valid session, so the probe waits
    // for the landing; still being on the sign-in host at the deadline is what "sign in" means.
    const transport = await transportWith(["login.example.test"], "https://login.example.test/oauth2");
    await expect(transport.authenticationState()).resolves.toMatchObject({ state: "sign-in-required" });
    await transport.dispose();
  });
});

describe("Microsoft 365 account selection", () => {
  it.each([true, false])(
    "does not accept personal SSO as organization sign-in (personal: %s)",
    async (personal) => {
      const page = {
        url: () => "https://m365.cloud.microsoft/chat",
        getByRole: (_role: string, options: { name: RegExp }) => ({
          count: async () => (personal && options.name.test("Example, 個人用アカウント") ? 1 : 0),
          isVisible: async () => true
        }),
        evaluate: async (_fn: unknown, args: unknown) =>
          args ? true : "Microsoft 365 Copilot 新しいチャット"
      };
      await expect(new AuthDetector().detect(page as unknown as PageLike)).resolves.toBe(
        personal ? "sign-in-required" : "authenticated"
      );
    }
  );
});
