import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProgressSink } from "../../src/domain/progress.js";
import { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import { BrowserTransport } from "../../src/transports/browser/browser-transport.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import { diagnosticsOf } from "../../src/observability/incidents.js";
import type { ChatUiAdapter } from "../../src/transports/browser/ui-adapter.js";
import {
  BrowserTransportError,
  type BrowserAgentDefinition,
  type BrowserContextLike,
  type PageLike
} from "../../src/transports/browser/types.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const agent: BrowserAgentDefinition = {
  alias: "requirements",
  displayName: "Requirements",
  kind: "m365-agent-builder",
  transport: "browser",
  entryPoint: { mode: "direct-chat", url: "https://m365.example.test/chat", surface: "m365-copilot" },
  enabled: true,
  capabilityClass: "knowledge-only",
  uiActionPolicy: "never-click",
  verification: {
    status: "verified",
    adapterId: "fixture@1",
    expectedDisplayName: "Requirements",
    expectedSurface: "m365-copilot",
    validatedUrlPattern: "^/chat$",
    bindingFingerprint: fingerprint,
    validatedAt: "2026-09-01T00:00:00.000Z"
  }
};
const directAgent: BrowserAgentDefinition = {
  ...agent,
  entryPoint: {
    mode: "direct-chat",
    url: "https://m365.example.test/chat/agent/T_agent.gpt.instance",
    surface: "m365-copilot"
  },
  verification: {
    ...agent.verification,
    expectedStableAgentId: "T_agent.gpt.instance",
    validatedUrlPattern: "^/chat/agent/T_agent\\.gpt\\.instance$"
  }
};

describe("BrowserTransport conversation creation", () => {
  it("allows actions-possible agents only when the transport policy opts in", async () => {
    const actionAgent: BrowserAgentDefinition = { ...agent, capabilityClass: "actions-possible" };
    const adapter = fixtureAdapter({ started: 0, verified: 0, filled: 0, submitted: 0 }, true);
    const restricted = new BrowserTransport({
      appHosts: ["m365.example.test"],
      adapters: [adapter]
    });
    const enabled = new BrowserTransport({
      appHosts: ["m365.example.test"],
      adapters: [adapter],
      allowedCapabilityClasses: ["knowledge-only", "actions-possible"]
    });

    await expect(restricted.validateAgent(actionAgent)).resolves.toEqual({
      valid: false,
      reason: "AGENT_CAPABILITY_BLOCKED"
    });
    await expect(enabled.validateAgent(actionAgent)).resolves.toEqual({ valid: true });
    await restricted.dispose();
    await enabled.dispose();
  });

  it("waits through an approved authentication redirect during interactive capture", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true);
    const transport = await makeTransport(
      adapter,
      "https://m365.example.test/chat",
      () => "https://login.example.test/oauth2/authorize",
      undefined,
      "https://m365.example.test/chat/agent/T_agent.gpt.instance"
    );

    await expect(transport.captureAgent(1_000)).resolves.toMatchObject({
      displayName: "Requirements",
      surface: "m365-copilot"
    });
    await transport.dispose();
  });

  it("waits for a direct-agent landing to render before capturing its identity", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true);
    let attempts = 0;
    adapter.canHandle = async () => ({
      matched: true,
      confidence: ++attempts === 1 ? "weak" : "strong"
    });
    adapter.detectAgentIdentity = async () => ({
      displayName: "Requirements",
      stableAgentId: "T_agent.gpt.instance",
      surface: "m365-copilot",
      digest: "identity",
      evidence: ["visible-name", "stable-id"]
    });
    const transport = await makeTransport(
      adapter,
      "https://m365.example.test/chat/agent/T_agent.gpt.instance"
    );

    await expect(
      transport.inspectAgentUrl("https://m365.example.test/chat/agent/T_agent.gpt.instance")
    ).resolves.toMatchObject({
      displayName: "Requirements",
      stableAgentId: "T_agent.gpt.instance"
    });
    expect(attempts).toBe(2);
    await transport.dispose();
  });

  it("waits through an approved authentication redirect while inspecting a direct agent URL", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true);
    const transport = await makeTransport(
      adapter,
      "https://m365.example.test/chat/agent/T_agent.gpt.instance",
      () => "https://login.example.test/oauth2/authorize",
      undefined,
      "https://m365.example.test/chat/agent/T_agent.gpt.instance"
    );

    await expect(
      transport.inspectAgentUrl("https://m365.example.test/chat/agent/T_agent.gpt.instance")
    ).resolves.toMatchObject({ displayName: "Requirements" });
    await transport.dispose();
  });

  it("selects the requested agent after authentication lands on the ordinary chat", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true);
    adapter.canHandle = async (page) => ({
      matched: true,
      confidence: page.url().includes("/chat/agent/") ? "strong" : "weak"
    });
    adapter.detectAuthState = async () => "authenticated";
    adapter.detectAgentIdentity = async () => ({
      displayName: "Requirements",
      stableAgentId: "T_agent.gpt.instance",
      surface: "m365-copilot",
      digest: "identity",
      evidence: ["visible-name", "stable-id"]
    });
    let navigations = 0;
    let selections = 0;
    const transport = await makeTransport(
      adapter,
      "https://m365.example.test/chat/agent/T_agent.gpt.instance",
      () => (++navigations === 1 ? "https://m365.example.test/chat?es=SSR" : "unexpected"),
      (agentId) => {
        selections++;
        expect(agentId).toBe("T_agent.gpt.instance");
        return "https://m365.example.test/chat/agent/T_agent.gpt.instance";
      }
    );

    await expect(
      transport.inspectAgentUrl("https://m365.example.test/chat/agent/T_agent.gpt.instance")
    ).resolves.toMatchObject({ stableAgentId: "T_agent.gpt.instance" });
    expect(navigations).toBe(1);
    expect(selections).toBe(1);
    await transport.dispose();
  });

  it("replays an unpinned direct-agent URL after authentication lands on ordinary chat", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    let navigations = 0;
    const transport = await makeTransport(
      fixtureAdapter(events, true, true),
      "https://m365.example.test/chat/agent/T_agent.gpt.instance",
      () =>
        ++navigations === 1
          ? "https://m365.example.test/chat?fromcode=auth"
          : "https://m365.example.test/chat/agent/T_agent.gpt.instance"
    );

    await expect(
      transport.createConversation(directAgent, {
        workspaceKey: "workspace",
        conversationHandle: "conv_replayed"
      })
    ).resolves.toMatchObject({ transportId: "browser" });
    expect(navigations).toBe(2);
    await transport.dispose();
  });

  it("verifies a genuinely fresh chat before returning an empty conversation", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true);
    const transport = await makeTransport(adapter);
    const conversation = await transport.createConversation(agent, {
      workspaceKey: "workspace",
      conversationHandle: "conv_test"
    });
    expect(conversation.transportId).toBe("browser");
    expect(typeof conversation.opaque).toBe("string");
    expect(events).toEqual({ started: 1, verified: 1, filled: 0, submitted: 0 });
    await transport.dispose();
  });

  it("retains a conversation handle while page close fails so maintenance can retry", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const transport = await makeTransport(fixtureAdapter(events, true));
    const conversation = await transport.createConversation(agent, {
      workspaceKey: "workspace",
      conversationHandle: "conv_close_retry"
    });
    const manager = (transport as unknown as { manager: BrowserManager }).manager;
    const closePage = manager.closePage.bind(manager);
    let attempts = 0;
    manager.closePage = async (pageKey: string) => {
      attempts++;
      if (attempts < 3) throw new Error("page close is still settling");
      return closePage(pageKey);
    };

    await expect(transport.closeConversation(conversation)).rejects.toThrow("still settling");
    await expect(transport.closeConversation(conversation)).rejects.toThrow("still settling");
    await expect(transport.closeConversation(conversation)).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    await transport.dispose();
  });

  it("reports safe observed identity details when verification fails", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true, true);
    adapter.assertAgentIdentity = async () => ({
      valid: false,
      code: "AGENT_IDENTITY_MISMATCH",
      identity: {
        displayName: "Ordinary Copilot",
        stableAgentId: "T_observed.gpt.instance",
        surface: "m365-copilot",
        digest: "observed-identity",
        evidence: ["visible-name", "stable-id"]
      }
    });
    const transport = await makeTransport(
      adapter,
      "https://m365.example.test/chat/agent/T_agent.gpt.instance"
    );

    await expect(
      transport.createConversation(directAgent, {
        workspaceKey: "workspace",
        conversationHandle: "conv_mismatch"
      })
    ).rejects.toMatchObject({
      code: "AGENT_IDENTITY_MISMATCH",
      message: expect.stringContaining(
        'Expected name="Requirements", stableId="T_agent.gpt.instance"; observed name="Ordinary Copilot", stableId="T_observed.gpt.instance"'
      )
    });
    await transport.dispose();
  });

  it("waits for a matching direct-agent name while the M365 composer is settling", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true, true);
    let attempts = 0;
    adapter.assertAgentIdentity = async () => {
      attempts++;
      return attempts === 1
        ? {
            valid: false,
            code: "AGENT_IDENTITY_UNVERIFIED",
            identity: {
              stableAgentId: "T_agent.gpt.instance",
              surface: "m365-copilot",
              digest: "provisional",
              evidence: ["stable-id"]
            }
          }
        : {
            valid: true,
            identity: {
              displayName: "Requirements",
              stableAgentId: "T_agent.gpt.instance",
              surface: "m365-copilot",
              digest: "settled",
              evidence: ["visible-name", "stable-id"]
            }
          };
    };
    const transport = await makeTransport(
      adapter,
      "https://m365.example.test/chat/agent/T_agent.gpt.instance"
    );

    await expect(
      transport.createConversation(directAgent, {
        workspaceKey: "workspace",
        conversationHandle: "conv_settled"
      })
    ).resolves.toMatchObject({ transportId: "browser" });
    expect(attempts).toBe(3);
    await transport.dispose();
  });

  it("fails closed before prompt entry when freshness is not observable", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const transport = await makeTransport(fixtureAdapter(events, false));
    await expect(
      transport.createConversation(agent, { workspaceKey: "workspace", conversationHandle: "conv_test" })
    ).rejects.toMatchObject({ code: "NEW_CONVERSATION_UNVERIFIED" });
    expect(events.filled).toBe(0);
    expect(events.submitted).toBe(0);
    await transport.dispose();
  });

  it.each([
    { displayName: "Other Agent" },
    { stableAgentId: "T_other.gpt.instance" },
    { surface: "teams-web" }
  ])("rejects a partial conflicting identity without waiting: %j", async (conflict) => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true, true);
    const ready = adapter.assertAgentIdentity;
    let attempts = 0;
    adapter.assertAgentIdentity = async (...args) =>
      ++attempts === 1
        ? {
            valid: false,
            code: "AGENT_IDENTITY_MISMATCH",
            identity: { ...conflict, digest: "partial", evidence: [] }
          }
        : ready(...args);
    const transport = await makeTransport(adapter, directAgent.entryPoint.url);
    try {
      await expect(
        transport.createConversation(directAgent, {
          workspaceKey: "workspace",
          conversationHandle: "conv_partial_conflict"
        })
      ).rejects.toMatchObject({ code: "AGENT_IDENTITY_MISMATCH" });
      expect(attempts).toBe(1);
      expect(events).toEqual({ started: 0, verified: 0, filled: 0, submitted: 0 });
    } finally {
      await transport.dispose();
    }
  });

  it("rejects a navigation boundary change while waiting for the initial identity", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true, true);
    const ready = adapter.assertAgentIdentity;
    let attempts = 0;
    adapter.assertAgentIdentity = async (...args) =>
      ++attempts === 1 ? { valid: false, code: "AGENT_IDENTITY_UNVERIFIED" } : ready(...args);
    const transport = await makeTransport(
      adapter,
      directAgent.entryPoint.url,
      undefined,
      undefined,
      "https://outside.example.test/chat"
    );
    try {
      await expect(
        transport.createConversation(directAgent, {
          workspaceKey: "workspace",
          conversationHandle: "conv_identity_redirect"
        })
      ).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
      expect(attempts).toBe(1);
      expect(events).toEqual({ started: 0, verified: 0, filled: 0, submitted: 0 });
    } finally {
      await transport.dispose();
    }
  });

  it("closes an unidentifiable page when the remaining navigation budget expires", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true, true);
    let now = 1000;
    const elapsed: number[] = [];
    let observedPage: PageLike | undefined;
    adapter.assertAgentIdentity = async (page) => {
      observedPage = page;
      page.waitForTimeout = async (ms) => {
        elapsed.push(ms);
        now += ms;
      };
      return { valid: false, code: "AGENT_IDENTITY_UNVERIFIED" };
    };
    const transport = await makeTransport(
      adapter,
      directAgent.entryPoint.url,
      undefined,
      undefined,
      undefined,
      100
    );
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await expect(
        transport.createConversation(directAgent, {
          workspaceKey: "workspace",
          conversationHandle: "conv_identity_timeout"
        })
      ).rejects.toMatchObject({ code: "AGENT_IDENTITY_UNVERIFIED" });
      expect(elapsed.reduce((sum, ms) => sum + ms, 0)).toBe(100);
      expect(observedPage?.isClosed?.()).toBe(true);
      expect(events).toEqual({ started: 0, verified: 0, filled: 0, submitted: 0 });
    } finally {
      clock.mockRestore();
      await transport.dispose();
    }
  });

  it("enriches a UI-drift failure with the adapter's structural fingerprint of the page", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, false);
    const structuralFingerprint = {
      adapterId: "fixture@1",
      hasMainRegion: true,
      hasComposer: true,
      hasSendButton: false,
      hasConversationRegion: true,
      identitySignalCount: 1
    };
    let observedPage: PageLike | undefined;
    adapter.captureUiFingerprint = async (page) => {
      observedPage = page;
      if (page.isClosed?.()) throw new Error("The page is already closed");
      return structuralFingerprint;
    };
    const transport = await makeTransport(adapter);

    const error = await transport
      .createConversation(agent, { workspaceKey: "workspace", conversationHandle: "conv_fingerprint" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "NEW_CONVERSATION_UNVERIFIED" });
    // Read back through the same WeakMap InvocationService/BrokerServer consult when recording an
    // incident (src/observability/incidents.ts) -- never a field on the wire error itself.
    expect(diagnosticsOf(error)).toEqual({ fingerprint: structuralFingerprint });
    expect(observedPage?.isClosed?.()).toBe(true);
    await transport.dispose();
  });

  it("never captures a fingerprint for an invoke() failure that is not UI drift", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, true, true);
    let fingerprintCalls = 0;
    adapter.captureUiFingerprint = async () => {
      fingerprintCalls++;
      return {
        adapterId: "fixture@1",
        hasMainRegion: true,
        hasComposer: true,
        hasSendButton: true,
        hasConversationRegion: true,
        identitySignalCount: 2
      };
    };
    // RATE_LIMITED is not a UI_DRIFT_CODE, so attachFingerprint's code check must skip it even
    // though both a page and an adapter with captureUiFingerprint are available.
    adapter.fillComposer = async () => {
      throw new BrowserTransportError("RATE_LIMITED", "Too many requests.");
    };
    const transport = await makeTransport(adapter);
    const conversation = await transport.createConversation(agent, {
      workspaceKey: "workspace",
      conversationHandle: "conv_rate_limited"
    });

    const error = await transport.invoke(conversation, { message: "hi" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "RATE_LIMITED" });
    expect(fingerprintCalls).toBe(0);
    await transport.dispose();
  });

  it("keeps an already-empty direct-agent landing instead of clicking the global new-chat control", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const transport = await makeTransport(
      fixtureAdapter(events, false, true),
      "https://m365.example.test/chat/agent/T_agent.gpt.instance"
    );
    const conversation = await transport.createConversation(directAgent, {
      workspaceKey: "workspace",
      conversationHandle: "conv_direct"
    });
    expect(conversation.transportId).toBe("browser");
    expect(events).toEqual({ started: 0, verified: 0, filled: 0, submitted: 0 });
    await transport.dispose();
  });

  it("invalidates open conversations when an interactive sign-in resets the hidden context", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const transport = await makeTransport(fixtureAdapter(events, true));
    let crashes = 0;
    transport.onBrowserCrash(() => {
      crashes++;
    });
    const conversation = await transport.createConversation(agent, {
      workspaceKey: "workspace",
      conversationHandle: "conv_reset"
    });

    await expect(transport.login(5_000)).resolves.toMatchObject({ authenticated: true });

    expect(crashes).toBe(1);
    await expect(transport.invoke(conversation, { message: "hello" })).rejects.toMatchObject({
      code: "BROWSER_CRASHED"
    });
    await transport.dispose();
  });

  it("can cancel immediately after starting a shared login and start again afterwards", async () => {
    const transport = await makeTransport(
      fixtureAdapter({ started: 0, verified: 0, filled: 0, submitted: 0 }, true)
    );
    const pending = transport.login(5_000);
    const rejected = expect(pending).rejects.toMatchObject({ code: "AUTH_FAILED" });
    try {
      await expect(transport.cancelLogin()).resolves.toEqual({ cancelled: true });
      await rejected;
      await expect(transport.login(5_000)).resolves.toMatchObject({ authenticated: true });
    } finally {
      await transport.dispose();
    }
  });

  it("shares the panel's visible sign-in and verification with another caller", async () => {
    const transport = await makeTransport(
      fixtureAdapter({ started: 0, verified: 0, filled: 0, submitted: 0 }, true)
    );
    await transport.createConversation(agent, {
      workspaceKey: "workspace",
      conversationHandle: "conv_shared_login"
    });
    let resets = 0;
    transport.onBrowserCrash(() => {
      resets++;
    });
    const first: string[] = [];
    const second: string[] = [];
    try {
      const results = await Promise.all([
        transport.login(5_000, (event) => {
          first.push(event.phase);
          throw new Error("disconnected");
        }),
        transport.login(30_000, (event) => second.push(event.phase))
      ]);
      expect(results).toEqual([
        { authenticated: true, state: "authenticated" },
        { authenticated: true, state: "authenticated" }
      ]);
      expect(resets).toBe(1);
      expect(first).toContain("login-waiting");
      expect(second).toEqual(first);
      expect(second.at(-1)).toBe("done");
    } finally {
      await transport.dispose();
    }
  });

  it("keeps a direct-agent welcome state with no user messages as a fresh conversation", async () => {
    const events = { started: 0, verified: 0, filled: 0, submitted: 0 };
    const adapter = fixtureAdapter(events, false);
    adapter.captureConversationMarker = async () => ({ userCount: 0, assistantCount: 1 });
    const transport = await makeTransport(
      adapter,
      "https://m365.example.test/chat/agent/T_agent.gpt.instance"
    );

    await expect(
      transport.createConversation(directAgent, {
        workspaceKey: "workspace",
        conversationHandle: "conv_welcome"
      })
    ).resolves.toMatchObject({ transportId: "browser" });
    expect(events.started).toBe(0);
    await transport.dispose();
  });
});

describe("BrowserTransport reporting", () => {
  it("cancels only the discovery with the supplied operation ID", async () => {
    const transport = new BrowserTransport({ appHosts: ["m365.example.test"], adapters: [] });
    const pending: Array<{ signal: AbortSignal; finish: () => void }> = [];
    Object.defineProperty(transport, "discovery", {
      value: {
        clearDescriptionCache: () => undefined,
        discover: (_timeout: number, _progress: ProgressSink, signal: AbortSignal) =>
          new Promise((resolve) => {
            const finish = () =>
              resolve({
                agents: [],
                warnings: signal.aborted ? ["discovery-cancelled"] : [],
                landingUrl: "https://m365.example.test/chat"
              });
            pending.push({ signal, finish });
            signal.addEventListener("abort", finish, { once: true });
          })
      }
    });
    const first = transport.discoverAgents(1000, undefined, "first-operation");
    const second = transport.discoverAgents(1000, undefined, "second-operation");
    expect(pending).toHaveLength(2);
    await expect(transport.cancelDiscovery("unknown-operation")).resolves.toEqual({ cancelled: false });
    await expect(transport.cancelDiscovery("first-operation")).resolves.toEqual({ cancelled: true });
    await expect(first).resolves.toMatchObject({ warnings: ["discovery-cancelled"] });
    expect(pending[1].signal.aborted).toBe(false);
    pending[1].finish();
    await expect(second).resolves.toMatchObject({ warnings: [] });
    await expect(transport.cancelDiscovery("first-operation")).resolves.toEqual({ cancelled: false });
    await transport.dispose();
  });

  it("coalesces matching in-flight discovery runs, fans out progress, and retries after settlement", async () => {
    const transport = new BrowserTransport({ appHosts: ["m365.example.test"], adapters: [] });
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    Object.defineProperty(transport, "discovery", {
      value: {
        clearDescriptionCache: () => undefined,
        discover: async (_timeoutMs: number, onProgress?: ProgressSink) => {
          calls++;
          onProgress?.({ phase: "discovering", elapsedMs: 0, message: `run-${calls}-opening` });
          if (calls === 1) {
            markFirstStarted?.();
            await firstGate;
          }
          if (calls === 2) throw new BrowserTransportError("AUTH_FAILED", "Session expired.");
          onProgress?.({ phase: "done", elapsedMs: 1, message: `run-${calls}-done`, total: 0 });
          return { agents: [], warnings: [], landingUrl: "https://m365.example.test/chat" };
        }
      }
    });
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const first = transport.discoverAgents(12_345, (event) => firstEvents.push(event.message));
    await firstStarted;
    const second = transport.discoverAgents(12_345, (event) => secondEvents.push(event.message));
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(calls).toBe(1);
    expect(firstEvents).toEqual(["run-1-opening", "run-1-done"]);
    expect(secondEvents).toEqual(["run-1-done"]);

    await expect(transport.discoverAgents(12_345)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(calls).toBe(2);
    await expect(transport.discoverAgents(12_345)).resolves.toMatchObject({ agents: [] });
    expect(calls).toBe(3);
    await transport.dispose();
  });

  it("reports the effective browser configuration as metadata in its health check", async () => {
    const transport = new BrowserTransport({
      appHosts: ["m365.example.test"],
      channel: "chrome",
      headless: true,
      viewport: { width: 1280, height: 1024 },
      profilePath: path.join(await mkdtemp(path.join(os.tmpdir(), "apl-health-")), "profile")
    });

    const health = await transport.healthCheck();

    expect(health.healthy).toBe(true);
    expect(health.details).toContain("channel=chrome");
    expect(health.details).toContain("headless=true");
    expect(health.details).toContain("viewport=1280x1024");
    expect(health.details).toContain("executable=");
    // Metadata only: never a profile path or a tenant hostname.
    expect(health.details).not.toContain("m365.example.test");
    expect(health.details).not.toContain("profile");
    await transport.dispose();
  });

  it("reports the development relaxations and the browser description as health metadata", async () => {
    const transport = new BrowserTransport({
      appHosts: ["m365.example.test"],
      channel: "chrome",
      headless: true,
      viewport: { width: 1280, height: 1024 },
      devMode: { insecureLoopback: true, devAppUrl: true },
      profilePath: path.join(await mkdtemp(path.join(os.tmpdir(), "apl-devmode-")), "profile")
    });

    await expect(transport.healthCheck()).resolves.toMatchObject({
      devMode: { insecureLoopback: true, devAppUrl: true },
      browser: { channel: "chrome", headless: true, viewport: { width: 1280, height: 1024 } }
    });
    await transport.dispose();

    // A production broker passes neither development switch.
    const production = new BrowserTransport({
      appHosts: ["m365.example.test"],
      profilePath: path.join(await mkdtemp(path.join(os.tmpdir(), "apl-prod-")), "profile")
    });
    await expect(production.healthCheck()).resolves.toMatchObject({
      devMode: { insecureLoopback: false, devAppUrl: false }
    });
    await production.dispose();
  });

  it("cancels a sign-in in progress and reports that nothing was cancelled otherwise", async () => {
    const profilePath = path.join(await mkdtemp(path.join(os.tmpdir(), "apl-cancel-")), "profile");
    const launched: Array<Record<string, unknown>> = [];
    let markRunning: (() => void) | undefined;
    const running = new Promise<void>((resolve) => (markRunning = resolve));
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async (_dir, options) => {
          launched.push(options);
          return {
            pages: () => [],
            newPage: async () => ({ url: () => "https://m365.example.test/chat" }),
            close: async () => undefined,
            on: () => undefined
          };
        }
      }
    });
    const transport = new BrowserTransport({ manager, appHosts: ["m365.example.test"], adapters: [] });

    // Nothing is running yet: cancelling is a no-op, not an error.
    await expect(transport.cancelLogin()).resolves.toEqual({ cancelled: false });

    const login = manager.runInteractiveLogin(async (_context, signal) => {
      markRunning?.();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    await running;

    await expect(transport.cancelLogin()).resolves.toEqual({ cancelled: true });
    await expect(login).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "The sign-in was cancelled."
    });
    // cancelLogin() waits for the sign-in to finish unwinding, so the hidden context can start.
    expect(manager.isRunning()).toBe(false);
    await manager.start();
    expect(launched.at(-1)?.headless).toBe(true);
    await transport.dispose();
  });

  it("marks a busy profile as retryable, with a wait and a remediation naming the sign-in window", async () => {
    const profilePath = path.join(await mkdtemp(path.join(os.tmpdir(), "apl-busy-")), "profile");
    let release: (() => void) | undefined;
    let markRunning: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => (release = resolve));
    const running = new Promise<void>((resolve) => (markRunning = resolve));
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => ({ url: () => "https://m365.example.test/chat" }),
          close: async () => undefined,
          on: () => undefined
        })
      }
    });
    const transport = new BrowserTransport({ manager, appHosts: ["m365.example.test"], adapters: [] });
    const login = manager.runInteractiveLogin(async () => {
      markRunning?.();
      await finished;
    });
    await running;

    const error = await transport
      .authenticationState()
      .catch((caught: unknown) => caught as { code: string; retryable: boolean; options: unknown });

    expect(error).toMatchObject({ code: "CONCURRENT_REQUEST", retryable: true });
    expect(error.options).toMatchObject({
      retryAfterMs: 5_000,
      remediation: expect.stringContaining("sign-in window")
    });
    release?.();
    await login;
  });

  it("coalesces concurrent routine probes onto one short-lived page", async () => {
    const profilePath = path.join(await mkdtemp(path.join(os.tmpdir(), "apl-keys-")), "profile");
    const openKeys: string[] = [];
    let live = 0;
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => {
            live++;
            return {
              url: () => "https://m365.example.test/chat",
              goto: async () => undefined,
              evaluate: async (fn: unknown) =>
                (String(fn).includes("document.body")
                  ? "Microsoft 365 Copilot 新しいチャット"
                  : true) as never,
              waitForTimeout: async () => undefined,
              isClosed: () => false,
              close: async () => {
                live--;
              },
              on: () => undefined,
              off: () => undefined
            };
          },
          close: async () => undefined,
          on: () => undefined
        })
      }
    });
    const createPage = manager.createConversationPage.bind(manager);
    manager.createConversationPage = async (key: string) => {
      openKeys.push(key);
      return createPage(key);
    };
    const transport = new BrowserTransport({ manager, appHosts: ["m365.example.test"], adapters: [] });

    const states = await Promise.all([transport.authenticationState(), transport.authenticationState()]);

    expect(states).toEqual([{ state: "authenticated" }, { state: "authenticated" }]);
    expect(new Set(openKeys).size).toBe(1);
    expect(openKeys.every((key) => key.startsWith("authentication-health-"))).toBe(true);
    // The shared probe still closes its page once all callers have its result.
    expect(live).toBe(0);
    await transport.dispose();
  });
});

async function makeTransport(
  adapter: ChatUiAdapter,
  url = "https://m365.example.test/chat",
  navigate?: (target: string) => string,
  selectAgent?: (agentId: string) => string,
  transitionAfterWait?: string,
  navigationTimeoutMs?: number
): Promise<BrowserTransport> {
  const profilePath = path.join(await mkdtemp(path.join(os.tmpdir(), "apl-browser-")), "profile");
  let currentUrl = url;
  let closed = false;
  const page: PageLike = {
    url: () => currentUrl,
    goto: async (target) => {
      currentUrl = navigate?.(target) ?? currentUrl;
    },
    locator: (selector) => {
      const selectedId = /\[data-agent-id="([A-Za-z0-9._-]+)"\]/.exec(selector)?.[1];
      if (!selectedId || !selectAgent) return {};
      return {
        count: async () => 1,
        isVisible: async () => true,
        click: async () => {
          currentUrl = selectAgent(selectedId);
        }
      };
    },
    evaluate: async (fn: unknown, _arg?: unknown) => {
      const source = String(fn);
      if (source.includes("document.body")) return "Microsoft 365 Copilot";
      return true;
    },
    waitForTimeout: async () => {
      if (transitionAfterWait) {
        currentUrl = transitionAfterWait;
        transitionAfterWait = undefined;
      }
    },
    isClosed: () => closed,
    close: async () => {
      closed = true;
    },
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
    navigationTimeoutMs,
    appHosts: ["m365.example.test"],
    authHosts: ["login.example.test"],
    navigationPolicy: new NavigationPolicy({
      appHosts: ["m365.example.test"],
      authHosts: ["login.example.test"]
    }),
    adapters: [adapter]
  });
}

function fixtureAdapter(
  events: { started: number; verified: number; filled: number; submitted: number },
  fresh: boolean,
  alreadyFresh = false
): ChatUiAdapter {
  return {
    id: "fixture@1",
    canSubmit: true,
    canHandle: async () => ({ matched: true, confidence: "strong" }),
    detectAuthState: async () => "authenticated",
    detectAgentIdentity: async () => ({
      displayName: "Requirements",
      surface: "m365-copilot",
      digest: "identity",
      evidence: ["visible-name"]
    }),
    assertAgentIdentity: async () => ({
      valid: true,
      identity: {
        displayName: "Requirements",
        surface: "m365-copilot",
        digest: "identity",
        evidence: ["visible-name"]
      }
    }),
    findComposer: async () => ({}),
    captureConversationMarker: async () =>
      alreadyFresh ? { userCount: 0, assistantCount: 0 } : { id: "old", userCount: 1, assistantCount: 1 },
    startNewConversation: async () => {
      events.started++;
    },
    verifyNewConversation: async () => {
      events.verified++;
      return { verified: fresh };
    },
    captureSubmissionMarker: async () => ({
      userCount: 0,
      assistantCount: 0,
      url: "https://m365.example.test/chat",
      identityDigest: "identity",
      composerValue: "",
      capturedAt: 0
    }),
    fillComposer: async () => {
      events.filled++;
    },
    clearComposer: async () => undefined,
    submitComposer: async () => {
      events.submitted++;
    },
    waitForUserMessageAck: async () => ({ state: "sent" }),
    waitForResponseStart: async () => ({ assistantCount: 1 }),
    waitForResponseComplete: async () => ({ complete: true }),
    extractLatestResponse: async () => ({
      text: "answer",
      citations: [],
      actionRequired: false,
      truncated: false
    })
  };
}
