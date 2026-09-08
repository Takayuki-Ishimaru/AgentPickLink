import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import type { ProgressEvent } from "../../src/domain/progress.js";
import { ConversationService } from "../../src/services/conversation-service.js";
import { InvocationService } from "../../src/services/invocation-service.js";
import type { PolicyService } from "../../src/services/policy-service.js";
import { InvocationLimiter } from "../../src/services/rate-limiter.js";
import { TransportRouter } from "../../src/transports/transport-router.js";
import { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import { createBrowserLauncher } from "../../src/transports/browser/session-preserving-launcher.js";
import { BrowserTransport } from "../../src/transports/browser/browser-transport.js";
import type { BrowserAgentDefinition } from "../../src/transports/browser/types.js";
import { MOCK_STORE_CATALOG, startMockChatApp, type MockChatApp } from "./server.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome"
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

let app: MockChatApp;

beforeAll(async () => {
  if (!executable) return;
  app = await startMockChatApp();
}, 30_000);
afterAll(async () => {
  await app?.close();
}, 30_000);

describe.skipIf(!executable)("hidden automation browser against the mock chat application", () => {
  let transport: BrowserTransport;
  let manager: BrowserManager;

  beforeAll(async () => {
    ({ transport, manager } = await makeTransport());
    // The landing page is session-gated; establish the session without a visible window so these
    // hidden-context tests do not depend on the headed sign-in test below.
    const boot = await manager.createConversationPage("bootstrap");
    await boot.page.goto?.(`${app.origin}/signin/complete?next=/chat`, { waitUntil: "domcontentloaded" });
    await manager.closePage("bootstrap");
  }, 60_000);
  afterAll(async () => {
    await transport?.dispose();
  }, 30_000);

  it("reports the signed-in profile as authenticated from a short-lived probe page", async () => {
    await expect(transport.authenticationState()).resolves.toEqual({ state: "authenticated" });
  });

  it("waits for the silent-auth bounce through the login host instead of reporting sign-in required", async () => {
    // The landing route hands off to the login host (a different hostname to the policy) and only
    // comes back to the application host 700 ms later, after domcontentloaded. Reading the
    // authentication state on arrival would report this signed-in profile as "sign in required".
    const bouncing = new BrowserTransport({
      manager,
      appHosts: ["127.0.0.1"],
      authHosts: ["localhost"],
      allowInsecureLoopback: true,
      neutralAppUrl: `${app.origin}/chat/silentauth`,
      navigationTimeoutMs: 20_000
    });

    await expect(bouncing.authenticationState()).resolves.toEqual({ state: "authenticated" });
  }, 30_000);

  it("keeps judging an application-host shell until the application has rendered", async () => {
    // Microsoft 365 answers on the application host with an empty shell (marker text, no main
    // region, no composer) and renders the chat client-side afterwards. Judging the shell on
    // arrival would report this signed-in profile as "unknown".
    const shell = new BrowserTransport({
      manager,
      appHosts: ["127.0.0.1"],
      authHosts: ["localhost"],
      allowInsecureLoopback: true,
      neutralAppUrl: `${app.origin}/chat/spa?delayMs=1500`,
      navigationTimeoutMs: 20_000,
      authLandingTimeoutMs: 10_000
    });

    await expect(shell.authenticationState()).resolves.toEqual({ state: "authenticated" });
  }, 30_000);

  it("reports sign-in required when the login host never hands back", async () => {
    const stuck = new BrowserTransport({
      manager,
      appHosts: ["127.0.0.1"],
      authHosts: ["localhost"],
      allowInsecureLoopback: true,
      // A login page that stays put: the bounce never completes.
      neutralAppUrl: `${app.origin}/chat/silentauth?stuck=1`,
      navigationTimeoutMs: 20_000,
      authLandingTimeoutMs: 1_000
    });

    await expect(stuck.authenticationState()).resolves.toEqual({ state: "sign-in-required" });
  }, 30_000);

  it("discovers the sidebar agents, the lazily rendered row, and the agents behind the all-agents control", async () => {
    const events: ProgressEvent[] = [];
    const result = await transport.discoverAgents(20_000, (event) => events.push(event));

    // "Lazy Agent" exists only after the rail has actually been scrolled (virtualized list).
    expect(result.agents.map((agent) => agent.displayName).sort()).toEqual([
      "Architecture Agent",
      "Lazy Agent",
      "Requirements Agent",
      "Store Only Agent"
    ]);
    expect(result.agents.find((agent) => agent.stableAgentId === "agent-requirements")).toMatchObject({
      url: `${app.origin}/chat/agent/agent-requirements`,
      surface: "m365-copilot",
      source: "sidebar",
      description: "Requirements analysis"
    });
    expect(result.agents.find((agent) => agent.stableAgentId === "agent-store-only")?.source).toBe("store");
    expect(result.warnings).not.toContain("no-sidebar");
    // The metadata-only summary names how far the rail was hydrated and which role the store
    // control carried.
    const summary = result.warnings.find((warning) => warning.startsWith("sidebar:"));
    expect(summary).toContain("store:button");
    expect(summary).toMatch(/scroll:[1-9]\d*/);
    // File-hosting links on the landing page are offered as downloadHosts candidates: hostnames
    // only, deduplicated and sorted, never a URL or a path.
    expect(result.suggestedDownloadHosts).toEqual(["contoso-my.sharepoint.com", "contoso.sharepoint.com"]);
    expect(events.some((event) => event.phase === "discovering")).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: "done", total: 4 });
  }, 30_000);

  it("discovers the agents behind an application-host shell that renders after load", async () => {
    // The same rail, but served the way the real application serves it: shell first, chat and
    // rail rendered client-side later. Reading on arrival would report "no-sidebar".
    const shell = new BrowserTransport({
      manager,
      appHosts: ["127.0.0.1"],
      authHosts: ["localhost"],
      allowInsecureLoopback: true,
      neutralAppUrl: `${app.origin}/chat/spa?delayMs=1500`,
      navigationTimeoutMs: 20_000
    });

    const result = await shell.discoverAgents(20_000);

    expect(result.agents.map((agent) => agent.displayName).sort()).toEqual([
      "Architecture Agent",
      "Lazy Agent",
      "Requirements Agent",
      "Store Only Agent"
    ]);
    expect(result.warnings).not.toContain("no-sidebar");
    expect(result.warnings.some((warning) => warning.startsWith("landing"))).toBe(false);
    // The outer harness covers navigation, delayed hydration, discovery's own 20s budget and
    // page cleanup. It must not interrupt that cleanup and leak work into the next shared test.
  }, 60_000);

  it("resolves the agent store's cards one by one without pressing anything that adds an agent", async () => {
    // The landing page only links to the store (like Microsoft 365); the store lists cards with
    // no link and no id. Each card resolves differently -- see MOCK_STORE_CATALOG.
    const storeLanding = new BrowserTransport({
      manager,
      appHosts: ["127.0.0.1"],
      authHosts: ["localhost"],
      allowInsecureLoopback: true,
      neutralAppUrl: `${app.origin}/chat?store=page`,
      navigationTimeoutMs: 20_000,
      storeWaitMs: 1_000
    });

    const result = await storeLanding.discoverAgents(60_000);

    const fromStore = result.agents.filter((agent) => agent.source === "store");
    expect(fromStore.map((agent) => agent.stableAgentId).sort()).toEqual(
      MOCK_STORE_CATALOG.map((agent) => agent.id).sort()
    );
    expect(fromStore.find((agent) => agent.stableAgentId === "agent-store-open")).toMatchObject({
      url: `${app.origin}/chat/agent/agent-store-open`,
      displayName: "Open Agent",
      description: "Details dialog with an open control"
    });
    expect(result.warnings).toContain("sidebar:3/3 link:6/3 scroll:1 store:route:/chat/agentstore");
    expect(result.warnings.find((warning) => warning.startsWith("store-catalog:"))).toBe(
      "store-catalog:items=6 attr=1 nav=3 dialog=1 open=1 forbidden-only=0 skipped=0 none=0 errors=0 off-host=0 more=1"
    );
    // The metadata-only shapes: per list, how its cards resolved; per outcome, what the first such
    // card's subtree looked like (attribute names, test ids, tag tallies -- never a name).
    const shapes = result.warnings.find((warning) => warning.startsWith("store-shapes:"));
    expect(shapes).toContain(
      "filter=all lists=#0:おすすめ:3(nav=2 forbidden=0 skipped=0 other=1)|#1:組織:3(nav=1 forbidden=0 skipped=0 other=2)"
    );
    expect(shapes).toMatch(/cards=attr=\{attrs=[a-z,-]+ testid=agent-icon,agent-item-more-options tags=/);
    expect(shapes).toContain("|nav={");
    expect(shapes).toContain("|dialog={");
    expect(shapes).toContain("|open={");
    for (const agent of MOCK_STORE_CATALOG) expect(shapes).not.toContain(agent.name);
    // "追加" and the per-card overflow menus were never pressed.
    expect(app.storeViolations()).toEqual([]);
  }, 90_000);

  it("clicks only the cards the store marks as opening an agent, and skips the catalogue", async () => {
    // Microsoft 365 puts an accessible "…開く" hint on the cards of the account's added/created
    // agents (their click opens the chat) and none on the catalogue's cards (a details dialog
    // with "追加"). With such a hint on the page, only the hinted cards are clicked.
    const hinted = new BrowserTransport({
      manager,
      appHosts: ["127.0.0.1"],
      authHosts: ["localhost"],
      allowInsecureLoopback: true,
      neutralAppUrl: `${app.origin}/chat?store=page&storeHint=1`,
      navigationTimeoutMs: 20_000,
      storeWaitMs: 1_000
    });

    const result = await hinted.discoverAgents(60_000);

    const fromStore = result.agents.filter((agent) => agent.source === "store");
    expect(fromStore.map((agent) => agent.stableAgentId).sort()).toEqual([
      "agent-store-attr",
      "agent-store-more",
      "agent-store-nav",
      "agent-store-spa"
    ]);
    expect(result.warnings.find((warning) => warning.startsWith("store-catalog:"))).toBe(
      "store-catalog:items=6 attr=1 nav=3 dialog=0 open=0 forbidden-only=0 skipped=2 none=0 errors=0 off-host=0 more=1"
    );
    const shapes = result.warnings.find((warning) => warning.startsWith("store-shapes:"));
    expect(shapes).toContain(
      "filter=opens lists=#0:おすすめ:3(nav=2 forbidden=0 skipped=0 other=1)|#1:組織:3(nav=1 forbidden=0 skipped=2 other=0)"
    );
    expect(shapes).toContain("self=card.aria-description:open(");
    expect(app.storeViolations()).toEqual([]);
  }, 90_000);

  it("clicks the all-agents control when the tenant renders it as a menu item", async () => {
    // Same landing page, with the disclosure shipped as <a role="menuitem"> instead of a button.
    const menuItemVariant = new BrowserTransport({
      manager,
      appHosts: ["127.0.0.1"],
      authHosts: [],
      allowInsecureLoopback: true,
      neutralAppUrl: `${app.origin}/chat?storeRole=menuitem`,
      navigationTimeoutMs: 20_000
    });

    const result = await menuItemVariant.discoverAgents(20_000);

    expect(result.agents.find((agent) => agent.stableAgentId === "agent-store-only")?.source).toBe("store");
    expect(result.warnings.find((warning) => warning.startsWith("sidebar:"))).toContain("store:menuitem");
  }, 30_000);

  it("verifies a discovered direct agent URL", async () => {
    await expect(
      transport.inspectAgentUrl(`${app.origin}/chat/agent/agent-requirements`)
    ).resolves.toMatchObject({
      url: `${app.origin}/chat/agent/agent-requirements`,
      surface: "m365-copilot",
      adapterId: "m365-copilot-chat@1",
      displayName: "Requirements Agent",
      stableAgentId: "agent-requirements",
      validatedUrlPattern: "^/chat/agent/agent-requirements$"
    });
  }, 30_000);

  it("creates a conversation and invokes the agent, reporting metadata-only progress", async () => {
    const conversation = await transport.createConversation(mockAgent(app.origin), {
      workspaceKey: "mock-workspace",
      conversationHandle: "conv_mock"
    });
    const events: ProgressEvent[] = [];
    try {
      const response = await transport.invoke(conversation, {
        message: "hello",
        onProgress: (event) => events.push(event)
      });
      expect(response.text).toBe("answer");
      expect(response.submissionState).toBe("sent");
    } finally {
      await transport.closeConversation(conversation);
    }
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining([
        "asserting-identity",
        "filling",
        "submitting",
        "submitted",
        "waiting-response",
        "extracting",
        "done"
      ])
    );
    expect(events.some((event) => (event.message ?? "").includes("hello"))).toBe(false);
  }, 45_000);
});

// The one test that opens a visible window. Skipped on CI; on a developer machine the mock sign-in
// page completes by itself, so no human interaction is needed.
describe.skipIf(!executable || !!process.env.CI)("interactive sign-in handoff", () => {
  let transport: BrowserTransport;

  beforeAll(async () => {
    ({ transport } = await makeTransport());
  }, 60_000);
  afterAll(async () => {
    app?.setAutoSignIn(false);
    await transport?.dispose();
  }, 30_000);

  it("detects session loss when sign-in has no persistence prompt and uses a session-only cookie", async () => {
    const sessionOnlyApp = await startMockChatApp({ autoSignIn: true, persistentSession: false });
    const { transport: sessionOnly } = await makeTransport({
      neutralAppUrl: `${sessionOnlyApp.origin}/chat`,
      navigationTimeoutMs: 3_000
    });
    const events: ProgressEvent[] = [];
    try {
      await expect(
        sessionOnly.login(30_000, (event) => {
          events.push(event);
          if (event.phase === "login-closing") sessionOnlyApp.setAutoSignIn(false);
        })
      ).rejects.toMatchObject({
        code: "AUTH_FAILED",
        message: expect.stringContaining("requested sign-in again after the window was closed")
      });
      expect(events.map((event) => event.phase)).toContain("login-closing");
      expect(events.map((event) => event.phase)).not.toContain("done");
    } finally {
      await sessionOnly.dispose();
      await sessionOnlyApp.close();
    }
  }, 60_000);

  it("keeps a session-only sign-in alive while handing the browser to background automation", async () => {
    const sessionOnlyApp = await startMockChatApp({ autoSignIn: true, persistentSession: false });
    const hiddenPids: number[] = [];
    const { transport: retained, manager: retainedManager } = await makeTransport(
      {
        neutralAppUrl: `${sessionOnlyApp.origin}/chat`,
        navigationTimeoutMs: 5_000
      },
      async (pid) => {
        hiddenPids.push(pid);
      }
    );
    try {
      await expect(
        retained.login(30_000, (event) => {
          if (event.phase === "login-closing") sessionOnlyApp.setAutoSignIn(false);
        })
      ).resolves.toMatchObject({ authenticated: true });
      expect(hiddenPids.length).toBeGreaterThan(0);
      expect(new Set(hiddenPids).size).toBe(1);
      expect(hiddenPids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
      await expect(retained.authenticationState()).resolves.toEqual({ state: "authenticated" });
      // The only retained tab is the empty anchor; unpoliced login tabs have all been retired.
      expect(
        retainedManager
          .getContext()
          .pages()
          .map((page) => page.url())
      ).toEqual([expect.stringMatching(/^about:blank#apl-/)]);
      // Broker/browser shutdown still ends a nonpersistent session. It is never copied to disk
      // or re-created by replaying sign-in in the next process.
      await retainedManager.close();
      await expect(retained.authenticationState()).resolves.toEqual({ state: "sign-in-required" });
    } finally {
      await retained.dispose();
      await sessionOnlyApp.close();
    }
  }, 60_000);

  it("pauses a fresh AI ask at an expired session, opens sign-in, and resumes in the hidden browser", async () => {
    // A separate disposable profile starts signed out; mock sign-in is enabled only AFTER
    // the agent navigation has failed and the service is explicitly waiting for the human.
    const { transport: fresh } = await makeTransport({ navigationTimeoutMs: 3_000 });
    const conversations = new ConversationService("broker_auto_login", {
      maxPerWorkspace: 4,
      maxTotal: 4,
      idleExpirationMinutes: 30,
      perConversationQueueLimit: 2
    });
    fresh.onBrowserCrash(() => conversations.failAll());
    const protectedAgent = mockAgent(app.origin);
    protectedAgent.entryPoint.url += "?requireSession=1";
    const service = new InvocationService({
      policy: {
        authorize: async () => ({
          workspace: { workspaceKey: "mock-workspace" },
          agent: protectedAgent
        })
      } as unknown as PolicyService,
      conversations,
      limiter: new InvocationLimiter(1, 30),
      router: new TransportRouter().register("browser", fresh),
      diagnosticsPath: await mkdtemp(path.join(os.tmpdir(), "apl-auto-login-diagnostics-"))
    });
    const events: ProgressEvent[] = [];
    try {
      const response = await service.invoke(
        "mock-workspace",
        "requirements",
        "hello",
        undefined,
        "req-auto-login",
        (event) => {
          events.push(event);
          if (event.phase === "login-waiting") app.setAutoSignIn(true);
        }
      );
      expect(response.text).toBe("answer");
      expect(response.submissionState).toBe("sent");
      const phases = events.map((event) => event.phase);
      expect(phases).toContain("login-waiting");
      expect(phases).toContain("login-closing");
      expect(phases).toContain("verifying");
      expect(phases.filter((phase) => phase === "submitting")).toHaveLength(1);
      expect(phases.indexOf("submitting")).toBeGreaterThan(phases.indexOf("verifying"));
      expect(response.conversationClosed).toBe(true);
      expect(conversations.activeCount()).toBe(0);
      expect(() => conversations.get(response.conversationHandle)).toThrow(/expired/i);
    } finally {
      app.setAutoSignIn(false);
      await fresh.dispose();
    }
  }, 60_000);

  it("cancels a sign-in that is waiting in the visible window and leaves the browser usable", async () => {
    // Auto sign-in is off, so the window sits on the mock sign-in page waiting for a click that
    // never comes: exactly the state a user cancels out of.
    const events: ProgressEvent[] = [];
    const login = transport.login(30_000, (event) => events.push(event));
    login.catch(() => undefined);
    const deadline = Date.now() + 20_000;
    while (!events.some((event) => event.phase === "login-waiting") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events[0]?.phase).toBe("login-waiting");

    await expect(transport.cancelLogin()).resolves.toEqual({ cancelled: true });
    await expect(login).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "The sign-in was cancelled."
    });
    // The visible window is closed and the hidden context starts again on the same profile.
    await expect(transport.authenticationState()).resolves.toEqual({ state: "sign-in-required" });
    // Nothing is still in progress, so cancelling again is simply answered.
    await expect(transport.cancelLogin()).resolves.toEqual({ cancelled: false });
  }, 60_000);

  it("signs in in the visible window and hands the session to the hidden automation context", async () => {
    await expect(transport.authenticationState()).resolves.toEqual({ state: "sign-in-required" });

    app.setAutoSignIn(true);
    const events: ProgressEvent[] = [];
    await expect(transport.login(30_000, (event) => events.push(event))).resolves.toEqual({
      authenticated: true,
      state: "authenticated"
    });
    app.setAutoSignIn(false);

    expect(events[0]?.phase).toBe("login-waiting");
    // The handoff is verified in the relaunched hidden context before login() resolves, so a
    // session that lived only in the window can never be reported as a successful sign-in.
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(["login-closing", "verifying"])
    );
    expect(events.find((event) => event.phase === "verifying")?.message).toContain("hidden browser");
    expect(events.at(-1)?.phase).toBe("done");
    // The hidden automation context now sees the same signed-in profile.
    await expect(transport.authenticationState()).resolves.toEqual({ state: "authenticated" });
  }, 90_000);
});

// The real-tenant sequence: the application host serves its shell first, decides client-side
// whether to render or to hand off to sign-in, and the relaunched hidden context sees the same
// shell before the chat has rendered. Skipped on CI like the handoff above (visible window).
describe.skipIf(!executable || !!process.env.CI)(
  "interactive sign-in handoff through an application-host shell",
  () => {
    let transport: BrowserTransport;
    let manager: BrowserManager;

    beforeAll(async () => {
      ({ transport, manager } = await makeTransport({
        neutralAppUrl: `${app.origin}/chat/spa`,
        authHosts: ["localhost"],
        authLandingTimeoutMs: 2_000
      }));
    }, 60_000);
    afterAll(async () => {
      app?.setAutoSignIn(false);
      await transport?.dispose();
    }, 30_000);

    it("reports sign-in required when the shell hands a signed-out profile to a login page that never returns", async () => {
      const stuck = new BrowserTransport({
        manager,
        appHosts: ["127.0.0.1"],
        authHosts: ["localhost"],
        allowInsecureLoopback: true,
        neutralAppUrl: `${app.origin}/chat/spa?stuck=1`,
        navigationTimeoutMs: 20_000,
        authLandingTimeoutMs: 2_000
      });

      await expect(stuck.authenticationState()).resolves.toEqual({ state: "sign-in-required" });
    }, 30_000);

    it("signs in through the shell and verifies the handoff once the hidden shell has rendered", async () => {
      await expect(transport.authenticationState()).resolves.toEqual({ state: "sign-in-required" });

      app.setAutoSignIn(true);
      const events: ProgressEvent[] = [];
      await expect(transport.login(60_000, (event) => events.push(event))).resolves.toEqual({
        authenticated: true,
        state: "authenticated"
      });
      app.setAutoSignIn(false);

      expect(events.map((event) => event.phase)).toEqual(
        expect.arrayContaining(["login-waiting", "login-closing", "verifying", "done"])
      );
      expect(events.at(-1)?.phase).toBe("done");
      await expect(transport.authenticationState()).resolves.toEqual({ state: "authenticated" });
    }, 90_000);
  }
);

async function makeTransport(
  overrides: Partial<ConstructorParameters<typeof BrowserTransport>[0]> = {},
  hideWindows?: (pid: number) => Promise<void>
) {
  const profilePath = path.join(await mkdtemp(path.join(os.tmpdir(), "apl-handoff-")), "profile");
  const launcher = {
    launchPersistentContext: async (directory: string, options: Record<string, unknown>) => {
      // The dedicated profile is launched exactly as production does, except that the test binds
      // an installed browser by path instead of by channel.
      const { channel: _channel, args, ...rest } = options as Record<string, unknown>;
      return (await chromium.launchPersistentContext(directory, {
        ...rest,
        executablePath: executable,
        args: [...((args as string[]) ?? []), "--no-first-run", "--no-default-browser-check"]
      })) as never;
    }
  };
  const manager = new BrowserManager({
    profilePath,
    startupTimeoutMs: 60_000,
    launcher: hideWindows ? createBrowserLauncher(launcher as typeof chromium, hideWindows) : launcher
  });
  const transport = new BrowserTransport({
    manager,
    appHosts: ["127.0.0.1"],
    authHosts: [],
    allowInsecureLoopback: true,
    neutralAppUrl: `${app.origin}/chat`,
    navigationTimeoutMs: 20_000,
    responseTimeoutMs: 20_000,
    stabilityWindowMs: 100,
    pollIntervalMs: 25,
    ...overrides
  });
  return { transport, manager };
}

function mockAgent(origin: string): BrowserAgentDefinition {
  return {
    alias: "requirements",
    displayName: "Requirements Agent",
    kind: "m365-agent-builder",
    transport: "browser",
    entryPoint: {
      mode: "direct-chat",
      url: `${origin}/chat/agent/agent-requirements`,
      surface: "m365-copilot"
    },
    enabled: true,
    capabilityClass: "knowledge-only",
    uiActionPolicy: "never-click",
    verification: {
      status: "verified",
      adapterId: "m365-copilot-chat@1",
      expectedDisplayName: "Requirements Agent",
      expectedStableAgentId: "agent-requirements",
      expectedSurface: "m365-copilot",
      validatedUrlPattern: "^/chat/agent/agent-requirements$",
      bindingFingerprint: `sha256:${"a".repeat(64)}`,
      validatedAt: new Date().toISOString()
    }
  };
}
