import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "../../src/domain/progress.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { AuthDetector } from "../../src/transports/browser/auth-detector.js";
import { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import { SessionManager } from "../../src/transports/browser/session-manager.js";
import type { BrowserContextLike, PageLike } from "../../src/transports/browser/types.js";

const APP = "https://m365.example.test/chat";
const SIGN_IN_BODY = "サインイン";
const APP_BODY = "Microsoft 365 Copilot 新しいチャット";

describe("SessionManager", () => {
  it("probes the hidden context on a short-lived page and closes it again", async () => {
    const window = fakeWindow({ url: APP, body: APP_BODY, structure: true });
    const { sessions, manager } = await makeSessions(window);

    const result = await sessions.probe();

    expect(result.state).toBe("authenticated");
    expect(typeof result.checkedAt).toBe("string");
    expect(window.state.closed).toBe(true);
    expect(window.state.gotos).toEqual([APP]);
    await manager.close();
  });

  it("lands on the application host's chat route, never on its root", async () => {
    // Signed out, the host root does not redirect to the login host: Microsoft 365 renders a splash
    // with a "サインイン" button on the application host itself, so a session kept alive on the login
    // host would never be picked up by silent SSO there, and the splash would be judged as a page
    // that never rendered rather than as a signed-out profile. /chat does redirect.
    const window = fakeWindow({ url: APP, body: APP_BODY, structure: true });
    const { sessions, manager } = await makeSessions(window);

    expect(sessions.landingUrl()).toBe("https://m365.example.test/chat");
    await sessions.probe();
    expect(window.state.gotos).toEqual(["https://m365.example.test/chat"]);
    await manager.close();
  });

  it("reports a sign-in page as sign-in-required without failing", async () => {
    const window = fakeWindow({ url: APP, body: SIGN_IN_BODY, structure: false });
    const { sessions, manager } = await makeSessions(window);
    await expect(sessions.probe()).resolves.toMatchObject({ state: "sign-in-required" });
    await manager.close();
  });

  it("keeps judging the application-host shell until the application has rendered", async () => {
    // Microsoft 365 answers on the application host with an empty shell and renders the chat
    // client-side afterwards: marker text is there from the start, the structure only later.
    let polls = 0;
    const window = fakeWindow({
      url: APP,
      body: APP_BODY,
      structure: false,
      onPoll: (state) => {
        if (++polls >= 3) state.structure = true;
      }
    });
    const { sessions, manager } = await makeSessions(window, { authLandingTimeoutMs: 5_000 });

    await expect(sessions.probe()).resolves.toMatchObject({ state: "authenticated" });
    expect(polls).toBeGreaterThanOrEqual(3);
    await manager.close();
  });

  it("reports what it last saw when the application never renders before the deadline", async () => {
    const window = fakeWindow({ url: APP, body: APP_BODY, structure: false });
    const { sessions, manager } = await makeSessions(window, { authLandingTimeoutMs: 30 });

    await expect(sessions.probe()).resolves.toMatchObject({ state: "unknown" });
    await manager.close();
  });

  it("follows a client-side hop to the login host and back before judging", async () => {
    // A valid session can still be bounced through the login host after domcontentloaded; the
    // probe must treat that as "keep waiting", not as a result.
    let polls = 0;
    const window = fakeWindow({
      url: APP,
      body: APP_BODY,
      structure: false,
      onPoll: (state) => {
        polls++;
        if (polls === 1) state.url = "https://login.example.test/oauth2/authorize";
        if (polls === 3) {
          state.url = APP;
          state.structure = true;
        }
      }
    });
    const { sessions, manager } = await makeSessions(window, { authLandingTimeoutMs: 5_000 });

    await expect(sessions.probe()).resolves.toMatchObject({ state: "authenticated" });
    await manager.close();
  });

  it("surfaces an unlisted identity provider as an error instead of a plain sign-in state", async () => {
    // "Sign in again" would never fix this: the tenant's identity provider has to be added to
    // navigation.authHosts, so the probe must not flatten it into a state.
    const window = fakeWindow({
      url: APP,
      redirectTo: "https://idp.partner.test/saml2/sso",
      body: SIGN_IN_BODY,
      structure: false
    });
    const { sessions } = await makeSessions(window);

    await expect(sessions.probe()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      remediation: expect.stringContaining("idp.partner.test")
    });
  });

  it("signs in through a headed window, reports progress, and hands the session back hidden", async () => {
    let polls = 0;
    const window = fakeWindow({
      url: APP,
      body: SIGN_IN_BODY,
      structure: false,
      onPoll: (state) => {
        if (++polls < 3) return;
        state.body = APP_BODY;
        state.structure = true;
      }
    });
    const events: ProgressEvent[] = [];
    const { sessions, manager, launched } = await makeSessions(window, { progressIntervalMs: 1 });
    await manager.start();

    // The fake context hands the same page to the headed window and to the verification probe, so
    // the sign-in window's listeners are captured before that probe installs its own.
    let windowListeners: string[] = [];
    await expect(
      sessions.interactiveLogin(5_000, (event) => {
        events.push(event);
        if (event.phase === "login-closing") windowListeners = [...window.state.listeners];
      })
    ).resolves.toEqual({ authenticated: true, state: "authenticated" });

    // A headed window ran, and the hidden context was relaunched afterwards to verify the handoff.
    expect(launched.map((options) => options.headless)).toEqual([true, false, true]);
    expect(manager.isRunning()).toBe(true);
    expect(events[0]?.phase).toBe("login-waiting");
    expect(events[0]?.message).toContain("Waiting for sign-in");
    expect(events.map((event) => event.phase)).toContain("login-closing");
    expect(events.map((event) => event.phase)).toContain("verifying");
    expect(events.at(-1)?.phase).toBe("done");
    expect(events.every((event) => typeof event.elapsedMs === "number")).toBe(true);
    // The sign-in window is user-driven: no navigation watcher and no popup blocker are installed.
    expect(windowListeners).not.toContain("framenavigated");
    expect(windowListeners).not.toContain("popup");
  });

  it("fails when the sign-in did not persist to the dedicated profile", async () => {
    // The window reported success, but the relaunched hidden context sees a sign-in page again:
    // the session lived only in the window (the user declined "Stay signed in").
    let signedInWindow = false;
    const window = fakeWindow({
      url: APP,
      body: SIGN_IN_BODY,
      structure: false,
      onPoll: (state) => {
        // Only the headed window ever looks authenticated; the later hidden probe does not.
        if (signedInWindow) return;
        signedInWindow = true;
        state.body = APP_BODY;
        state.structure = true;
      },
      onGoto: (state) => {
        if (!signedInWindow) return;
        // The relaunched hidden context is bounced to the login host and stays there.
        state.url = "https://login.example.test/oauth2/authorize";
        state.body = SIGN_IN_BODY;
        state.structure = false;
      }
    });
    const { sessions } = await makeSessions(window, { pollIntervalMs: 1, verificationTimeoutMs: 50 });

    await expect(sessions.interactiveLogin(5_000)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: expect.stringContaining("requested sign-in again after the window was closed"),
      remediation: expect.stringContaining("This prompt may be hidden"),
      details: expect.objectContaining({ verification: { state: "sign-in-required", settledOn: "auth" } })
    });
  });

  it("reports a non-persisted session when the hidden context renders a sign-in page on the application host", async () => {
    // The relaunched hidden context is not bounced to the login host but shown Microsoft 365's
    // signed-out splash on the application host itself: still a signed-out profile, but this
    // does not establish whether the user was ever offered a persistence choice.
    let signedInWindow = false;
    const window = fakeWindow({
      url: APP,
      body: SIGN_IN_BODY,
      structure: false,
      onPoll: (state) => {
        if (signedInWindow) return;
        signedInWindow = true;
        state.body = APP_BODY;
        state.structure = true;
      },
      onGoto: (state) => {
        if (!signedInWindow) return;
        state.body = SIGN_IN_BODY;
        state.structure = true;
      }
    });
    const { sessions } = await makeSessions(window, { pollIntervalMs: 1, verificationTimeoutMs: 50 });

    await expect(sessions.interactiveLogin(5_000)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: expect.stringContaining("requested sign-in again after the window was closed"),
      remediation: expect.stringContaining("This prompt may be hidden"),
      details: expect.objectContaining({ verification: { state: "sign-in-required", settledOn: "app" } })
    });
  });

  it("fails with a distinct message when the hidden shell never renders as signed in", async () => {
    // The session most likely persisted (the hidden context was never sent to the login host);
    // the application just did not finish rendering within the verification budget. Telling the
    // user to choose "Stay signed in" would send them in the wrong direction.
    let signedInWindow = false;
    const window = fakeWindow({
      url: APP,
      body: SIGN_IN_BODY,
      structure: false,
      onPoll: (state) => {
        if (signedInWindow) return;
        signedInWindow = true;
        state.body = APP_BODY;
        state.structure = true;
      },
      onGoto: (state) => {
        if (!signedInWindow) return;
        state.body = APP_BODY;
        state.structure = false;
      }
    });
    const { sessions } = await makeSessions(window, { pollIntervalMs: 1, verificationTimeoutMs: 30 });

    await expect(sessions.interactiveLogin(5_000)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: expect.stringContaining("could not confirm the signed-in Microsoft 365 page"),
      remediation: expect.stringContaining("Retry the sign-in"),
      details: expect.objectContaining({ verification: { state: "unknown", settledOn: "app" } })
    });
  });

  it("waits for the hidden shell to render during verification instead of judging on arrival", async () => {
    let signedInWindow = false;
    let probePolls = 0;
    const window = fakeWindow({
      url: APP,
      body: SIGN_IN_BODY,
      structure: false,
      onPoll: (state) => {
        if (!signedInWindow) {
          signedInWindow = true;
          state.body = APP_BODY;
          state.structure = true;
          return;
        }
        // The relaunched hidden context: shell first, chat structure a few polls later.
        if (++probePolls >= 3) state.structure = true;
      },
      onGoto: (state) => {
        if (!signedInWindow) return;
        state.body = APP_BODY;
        state.structure = false;
      }
    });
    const events: ProgressEvent[] = [];
    // The fake never actually waits between polls, so several polls can share one millisecond: a
    // zero interval makes "one progress event per poll" deterministic instead of clock-dependent.
    const { sessions } = await makeSessions(window, { pollIntervalMs: 1, progressIntervalMs: 0 });

    await expect(sessions.interactiveLogin(5_000, (event) => events.push(event))).resolves.toEqual({
      authenticated: true,
      state: "authenticated"
    });
    expect(probePolls).toBeGreaterThanOrEqual(3);
    // Progress keeps flowing while the verification probe waits for the shell to render.
    expect(events.filter((event) => event.phase === "verifying").length).toBeGreaterThan(1);
    expect(events.at(-1)?.phase).toBe("done");
  });

  it("keeps waiting when an authenticated-looking page is not on an application host", async () => {
    const window = fakeWindow({
      url: APP,
      redirectTo: "https://idp.partner.test/landing",
      body: APP_BODY,
      structure: true
    });
    const { sessions } = await makeSessions(window, { pollIntervalMs: 1 });
    await expect(sessions.interactiveLogin(30)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "Interactive Microsoft 365 sign-in timed out."
    });
  });

  it("fails with AUTH_FAILED when the sign-in window is closed by the user", async () => {
    const window = fakeWindow({
      url: APP,
      body: SIGN_IN_BODY,
      structure: false,
      onPoll: (state) => {
        state.closed = true;
      }
    });
    const { sessions } = await makeSessions(window, { pollIntervalMs: 1 });
    await expect(sessions.interactiveLogin(5_000)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "The sign-in window was closed before sign-in completed."
    });
  });

  it("fails with AUTH_FAILED when Microsoft 365 denies access", async () => {
    const window = fakeWindow({ url: APP, body: "Access denied", structure: false });
    const { sessions } = await makeSessions(window, { pollIntervalMs: 1 });
    await expect(sessions.interactiveLogin(5_000)).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("stops polling and fails as cancelled when the sign-in is cancelled", async () => {
    let polls = 0;
    const window = fakeWindow({
      url: APP,
      body: SIGN_IN_BODY,
      structure: false,
      // A real page yields to the event loop between polls; this fixture must too, or the poll
      // loop would starve the timers this test waits on.
      onPoll: async () => {
        polls++;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    });
    const { sessions, manager } = await makeSessions(window, { pollIntervalMs: 1 });

    const login = sessions.interactiveLogin(30_000);
    const deadline = Date.now() + (process.platform === "win32" ? 20_000 : 2_000);
    while (polls === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(polls).toBeGreaterThan(0);

    expect(manager.cancelInteractiveLogin()).toBe(true);
    await expect(login).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "The sign-in was cancelled."
    });

    // The poll loop really stopped instead of running on in the background until the timeout.
    const seen = polls;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(polls).toBe(seen);
    // The sign-in verification probe never ran: a cancelled sign-in is not a sign-in.
    expect(window.state.gotos.filter((target) => target === APP)).toHaveLength(1);
  });

  it("also stops on a caller-supplied abort signal", async () => {
    let polls = 0;
    const window = fakeWindow({
      url: APP,
      body: SIGN_IN_BODY,
      structure: false,
      onPoll: async () => {
        polls++;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    });
    const { sessions, manager } = await makeSessions(window, { pollIntervalMs: 1 });
    const controller = new AbortController();

    const login = sessions.interactiveLogin(30_000, undefined, controller.signal);
    const deadline = Date.now() + (process.platform === "win32" ? 20_000 : 2_000);
    while (polls === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));

    controller.abort();
    await expect(login).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "The sign-in was cancelled."
    });
    // Nothing is left holding the profile, so the hidden context can be started again.
    expect(manager.cancelInteractiveLogin()).toBe(false);
    await manager.start();
    expect(manager.isRunning()).toBe(true);
    await manager.close();
  });

  it("refuses a second interactive sign-in while one is running", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const window = fakeWindow({
      url: APP,
      body: SIGN_IN_BODY,
      structure: false,
      onPoll: async () => {
        await gate;
      }
    });
    const { sessions } = await makeSessions(window, { pollIntervalMs: 1 });
    const first = sessions.interactiveLogin(50);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(sessions.interactiveLogin(50)).rejects.toMatchObject({ code: "CONCURRENT_REQUEST" });
    release?.();
    await expect(first).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});

type FakeState = {
  url: string;
  body: string;
  structure: boolean;
  closed: boolean;
  gotos: string[];
  listeners: string[];
};

function fakeWindow(options: {
  url: string;
  body: string;
  structure: boolean;
  /** Where the window actually ends up after the initial navigation (a federated IdP, say). */
  redirectTo?: string;
  onPoll?: (state: FakeState) => void | Promise<void>;
  /** Runs on every navigation, so a test can make the reloaded page look different. */
  onGoto?: (state: FakeState) => void;
}) {
  const state: FakeState = {
    url: options.url,
    body: options.body,
    structure: options.structure,
    closed: false,
    gotos: [],
    listeners: []
  };
  const page: PageLike = {
    url: () => state.url,
    goto: async (target: string) => {
      state.gotos.push(target);
      state.url = options.redirectTo ?? target;
      options.onGoto?.(state);
    },
    evaluate: async (fn: unknown) =>
      (String(fn).includes("document.body") ? state.body : state.structure) as never,
    waitForTimeout: async () => {
      await options.onPoll?.(state);
    },
    isClosed: () => state.closed,
    close: async () => {
      state.closed = true;
    },
    on: (event: string) => {
      state.listeners.push(event);
    },
    off: () => undefined
  };
  return { page, state };
}

async function makeSessions(
  window: ReturnType<typeof fakeWindow>,
  options: {
    pollIntervalMs?: number;
    progressIntervalMs?: number;
    authLandingTimeoutMs?: number;
    verificationTimeoutMs?: number;
  } = {}
) {
  const profilePath = path.join(await mkdtemp(path.join(os.tmpdir(), "apl-session-")), "profile");
  const launched: Array<Record<string, unknown>> = [];
  const context: BrowserContextLike = {
    pages: () => [window.page],
    newPage: async () => window.page,
    close: async () => undefined,
    on: () => undefined
  };
  const manager = new BrowserManager({
    profilePath,
    launcher: {
      launchPersistentContext: async (_dir, launchOptions) => {
        launched.push(launchOptions);
        return context;
      }
    }
  });
  const policy = new NavigationPolicy({
    appHosts: ["m365.example.test"],
    authHosts: ["login.example.test"]
  });
  const sessions = new SessionManager({
    manager,
    policy,
    navigator: new AgentNavigator(policy, new AuthDetector({ signInHosts: ["login.example.test"] })),
    appHosts: ["m365.example.test"],
    authHosts: ["login.example.test"],
    pollIntervalMs: options.pollIntervalMs ?? 1,
    progressIntervalMs: options.progressIntervalMs ?? 2_000,
    // The probe keeps judging until its deadline; these fakes never take long to settle, so keep
    // the budgets short instead of spending the production defaults on a page that never renders.
    authLandingTimeoutMs: options.authLandingTimeoutMs ?? 50,
    verificationTimeoutMs: options.verificationTimeoutMs ?? 500
  });
  return { sessions, manager, launched, policy };
}
