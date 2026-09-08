import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { AuthDetector } from "../../src/transports/browser/auth-detector.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import type { BrowserAgentDefinition, PageLike } from "../../src/transports/browser/types.js";
import type { ChatUiAdapter } from "../../src/transports/browser/ui-adapter.js";

const APP_HOST = "m365.example.test";
const AUTH_HOST = "login.example.test";
const SIGN_IN_BODY = "サインイン";
const APP_BODY = "Microsoft 365 Copilot 新しいチャット";

function makeNavigator() {
  const policy = new NavigationPolicy({ appHosts: [APP_HOST], authHosts: [AUTH_HOST] });
  return new AgentNavigator(policy, new AuthDetector({ signInHosts: [AUTH_HOST] }));
}

/** A page whose URL and body change on a scripted schedule, one step per poll. */
function scriptedPage(steps: Array<{ url: string; body: string }>): PageLike {
  let index = 0;
  const at = () => steps[Math.min(index, steps.length - 1)]!;
  return {
    url: () => at().url,
    goto: async () => undefined,
    evaluate: async (fn: unknown) => (String(fn).includes("document.body") ? at().body : true) as never,
    waitForTimeout: async () => {
      index++;
    },
    on: () => undefined,
    off: () => undefined
  };
}

describe("AgentNavigator.awaitAppLanding", () => {
  it("waits for the silent-auth bounce to land back on the application host", async () => {
    const page = scriptedPage([
      { url: `https://${AUTH_HOST}/common/oauth2/authorize`, body: SIGN_IN_BODY },
      { url: `https://${AUTH_HOST}/kmsi`, body: SIGN_IN_BODY },
      { url: `https://${APP_HOST}/chat`, body: APP_BODY }
    ]);

    await expect(makeNavigator().awaitAppLanding(page, Date.now() + 5_000)).resolves.toBeUndefined();
    await expect(makeNavigator().authState(page)).resolves.toBe("authenticated");
  });

  it("reports sign-in required when the authentication host still owns the page at the deadline", async () => {
    const page = scriptedPage([{ url: `https://${AUTH_HOST}/common/login`, body: SIGN_IN_BODY }]);

    await expect(makeNavigator().awaitAppLanding(page, Date.now() - 1)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      remediation: expect.stringContaining("AgentPickLink panel")
    });
  });

  it("hands control back on an authentication host when the caller drives the sign-in itself", async () => {
    const page = scriptedPage([{ url: `https://${AUTH_HOST}/common/login`, body: SIGN_IN_BODY }]);

    await expect(makeNavigator().awaitAppLanding(page, Date.now() - 1, true)).resolves.toBeUndefined();
  });

  it("reports an unlisted identity provider as AUTH_REQUIRED naming only that host", async () => {
    const page = scriptedPage([{ url: `https://idp.partner.test/saml2/login?RelayState=secret`, body: "" }]);

    const error = await makeNavigator()
      .awaitAppLanding(page, Date.now() + 5_000)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "AUTH_REQUIRED" });
    const { message, remediation } = error as { message: string; remediation: string };
    expect(remediation).toContain("idp.partner.test");
    expect(remediation).toContain("navigation.authHosts");
    // Hostname only: no path, no query, nothing request-scoped.
    expect(`${message} ${remediation}`).not.toContain("saml2");
    expect(`${message} ${remediation}`).not.toContain("secret");
  });

  it("attaches the ordered hostnames visited while waiting to a sign-in-required failure", async () => {
    const page = scriptedPage([{ url: `https://${AUTH_HOST}/common/login`, body: SIGN_IN_BODY }]);

    const error = await makeNavigator()
      .awaitAppLanding(page, Date.now() - 1)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "AUTH_REQUIRED", details: { hosts: [AUTH_HOST] } });
  });

  it("attaches the offending host to an unlisted-identity-provider failure's hosts list too", async () => {
    const page = scriptedPage([{ url: `https://idp.partner.test/saml2/login?RelayState=secret`, body: "" }]);

    const error = await makeNavigator()
      .awaitAppLanding(page, Date.now() + 5_000)
      .catch((caught: unknown) => caught);

    // Hosts only -- never the path or query the offending redirect carried.
    expect(error).toMatchObject({ code: "AUTH_REQUIRED", details: { hosts: ["idp.partner.test"] } });
  });

  it("never attaches an (empty) hosts list to a policy refusal that never saw a usable host", async () => {
    const page = scriptedPage([{ url: "about:blank", body: "" }]);

    const error = await makeNavigator()
      .awaitAppLanding(page, Date.now() + 5_000)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "POLICY_BLOCKED" });
    expect((error as { details?: { hosts?: string[] } }).details?.hosts).toBeUndefined();
  });

  it("keeps a policy refusal for a URL with no usable host", async () => {
    const page = scriptedPage([{ url: "about:blank", body: "" }]);

    await expect(makeNavigator().awaitAppLanding(page, Date.now() + 5_000)).rejects.toMatchObject({
      code: "POLICY_BLOCKED"
    });
  });
});

describe("AgentNavigator navigation watching during sign-in", () => {
  const watchedPage = () => {
    const listeners: Array<(frame: unknown) => void> = [];
    let currentUrl = `https://${APP_HOST}/chat`;
    const page: PageLike = {
      url: () => currentUrl,
      on: (event, listener) => {
        if (event === "framenavigated") listeners.push(listener as (frame: unknown) => void);
      },
      off: () => undefined
    };
    return {
      page,
      redirect: (url: string) => {
        currentUrl = url;
        for (const listener of listeners) listener({ url: () => url });
      }
    };
  };

  it("reports a redirect to an unlisted identity provider as AUTH_REQUIRED", async () => {
    const navigator = makeNavigator();
    const { page, redirect } = watchedPage();
    const stop = navigator.watch(page, "app-or-auth");

    redirect("https://idp.partner.test/saml2/sso");

    expect(() => navigator.assertNavigationSafe(page, "app-or-auth")).toThrow(
      expect.objectContaining({ code: "AUTH_REQUIRED" })
    );
    stop();
  });

  it("keeps POLICY_BLOCKED for a redirect that is not merely an unlisted host", async () => {
    const navigator = makeNavigator();
    const { page, redirect } = watchedPage();
    const stop = navigator.watch(page, "app-or-auth");

    redirect("http://insecure.partner.test/login");

    expect(() => navigator.assertNavigationSafe(page, "app-or-auth")).toThrow(
      expect.objectContaining({ code: "POLICY_BLOCKED" })
    );
    stop();
  });

  it("keeps POLICY_BLOCKED for an unexpected host during a locked agent operation", async () => {
    const navigator = makeNavigator();
    const { page, redirect } = watchedPage();
    const stop = navigator.watch(page, "app");

    redirect(`https://${AUTH_HOST}/common/login`);

    expect(() => navigator.assertNavigationSafe(page, "app")).toThrow(
      expect.objectContaining({ code: "POLICY_BLOCKED" })
    );
    stop();
  });
});

describe("AgentNavigator.open", () => {
  afterEach(() => vi.restoreAllMocks());

  function loadingPage(steps: Array<{ url: string; body: string }>) {
    const page = scriptedPage(steps);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const advance = page.waitForTimeout!;
    page.waitForTimeout = vi.fn(async (ms: number) => {
      now += ms;
      await advance(ms);
    });
    page.goto = vi.fn(async () => undefined);
    const ui = adapter();
    ui.canHandle = vi.fn(async () => ({
      matched: (await page.evaluate!(() => document.body.innerText)) === APP_BODY,
      confidence: "strong" as const
    }));
    return { page, ui, elapsed: () => now };
  }

  function directAgent(): BrowserAgentDefinition {
    const target = agent();
    target.entryPoint.url += "/agent/fixture-agent";
    target.verification.validatedUrlPattern = "^/chat/agent/fixture-agent$";
    return target;
  }

  it.each(["chat", "direct-agent"])("waits for the %s composer to render after the shell", async (route) => {
    const target = route === "chat" ? agent() : directAgent();
    const url = target.entryPoint.url;
    const { page, ui, elapsed } = loadingPage([
      { url, body: "" },
      { url, body: "Loading" },
      { url, body: APP_BODY }
    ]);

    await expect(makeNavigator().open(page, target, ui, { timeoutMs: 2_000 })).resolves.toBeUndefined();
    expect(elapsed()).toBe(1_000);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it("waits through a late auth bounce and restores the direct route once", async () => {
    const target = directAgent();
    const { page, ui } = loadingPage([
      { url: target.entryPoint.url, body: "" },
      { url: `https://${AUTH_HOST}/common/login`, body: SIGN_IN_BODY },
      { url: `https://${APP_HOST}/chat`, body: APP_BODY },
      { url: target.entryPoint.url, body: "" },
      { url: target.entryPoint.url, body: APP_BODY }
    ]);
    const advance = page.waitForTimeout!;
    page.goto = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => advance(0));

    await expect(makeNavigator().open(page, target, ui, { timeoutMs: 2_000 })).resolves.toBeUndefined();
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.url()).toBe(target.entryPoint.url);
  });

  it("reports unsupported UI only after the shared navigation deadline", async () => {
    const target = directAgent();
    const { page, ui, elapsed } = loadingPage([{ url: target.entryPoint.url, body: "Loading" }]);

    await expect(makeNavigator().open(page, target, ui, { timeoutMs: 750 })).rejects.toMatchObject({
      code: "UI_CHANGED"
    });
    expect(elapsed()).toBe(750);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it("bounds route restoration and never accepts ordinary Copilot as the requested agent", async () => {
    const { page, ui, elapsed } = loadingPage([{ url: `https://${APP_HOST}/chat`, body: APP_BODY }]);

    await expect(makeNavigator().open(page, directAgent(), ui, { timeoutMs: 750 })).rejects.toMatchObject({
      code: "AGENT_CONTEXT_CHANGED"
    });
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(elapsed()).toBe(750);
  });

  it.each([
    [SIGN_IN_BODY, "AUTH_REQUIRED"],
    ["Access denied", "AUTH_FAILED"]
  ])("rechecks auth when a loading page becomes %s", async (body, code) => {
    const url = agent().entryPoint.url;
    const { page, ui } = loadingPage([
      { url, body: "" },
      { url, body }
    ]);

    await expect(makeNavigator().open(page, agent(), ui, { timeoutMs: 2_000 })).rejects.toMatchObject({
      code
    });
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it("keeps watching transient forbidden redirects while the composer loads", async () => {
    const url = agent().entryPoint.url;
    const { page, ui } = loadingPage([
      { url, body: "" },
      { url, body: APP_BODY }
    ]);
    const listeners = new Set<(frame: { url: () => string }) => void>();
    page.on = (event, listener) => {
      if (event === "framenavigated") listeners.add(listener);
    };
    page.off = (event, listener) => {
      if (event === "framenavigated") listeners.delete(listener);
    };
    const advance = page.waitForTimeout!;
    page.waitForTimeout = async (ms) => {
      for (const listener of listeners) listener({ url: () => "http://forbidden.example.test/" });
      await advance(ms);
    };

    await expect(makeNavigator().open(page, agent(), ui, { timeoutMs: 2_000 })).rejects.toMatchObject({
      code: "POLICY_BLOCKED"
    });
    expect(listeners.size).toBe(0);
  });

  it("waits for the bounce before reading the authentication state", async () => {
    // Landing on the login host is where Microsoft 365 leaves a valid session at domcontentloaded.
    // Judging there would report this signed-in profile as "sign in required".
    const page = scriptedPage([
      { url: `https://${AUTH_HOST}/common/oauth2/authorize`, body: SIGN_IN_BODY },
      { url: `https://${APP_HOST}/chat`, body: APP_BODY }
    ]);

    await expect(
      makeNavigator().open(page, agent(), adapter(), { timeoutMs: 5_000 })
    ).resolves.toBeUndefined();
  });

  it("still reports a genuine sign-in page served by the application host", async () => {
    const page = scriptedPage([{ url: `https://${APP_HOST}/chat`, body: SIGN_IN_BODY }]);

    await expect(makeNavigator().open(page, agent(), adapter(), { timeoutMs: 50 })).rejects.toMatchObject({
      code: "AUTH_REQUIRED"
    });
  });
});

function agent(): BrowserAgentDefinition {
  return {
    alias: "requirements",
    displayName: "Requirements",
    kind: "m365-agent-builder",
    transport: "browser",
    entryPoint: { mode: "direct-chat", url: `https://${APP_HOST}/chat`, surface: "m365-copilot" },
    enabled: true,
    capabilityClass: "knowledge-only",
    uiActionPolicy: "never-click",
    verification: {
      status: "verified",
      adapterId: "fixture@1",
      expectedDisplayName: "Requirements",
      expectedSurface: "m365-copilot",
      validatedUrlPattern: "^/chat$",
      bindingFingerprint: `sha256:${"a".repeat(64)}`,
      validatedAt: "2026-09-01T00:00:00.000Z"
    }
  };
}

function adapter(): ChatUiAdapter {
  return {
    id: "fixture@1",
    canSubmit: true,
    canHandle: async () => ({ matched: true, confidence: "strong" })
  } as unknown as ChatUiAdapter;
}
