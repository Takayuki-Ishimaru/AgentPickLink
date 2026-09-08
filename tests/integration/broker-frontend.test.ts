import { testIpcEndpoint } from "../helpers/platform.js";
import { normalizeRoot } from "../../src/services/workspace-service.js";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/global-config.js";
import { DomainError } from "../../src/domain/errors.js";
import type { ProgressEvent, ProgressSink } from "../../src/domain/progress.js";
import { BrokerServer } from "../../src/broker/broker-server.js";
import { readDescriptor } from "../../src/broker/broker-descriptor.js";
import { connectExistingBroker } from "../../src/broker/broker-lifecycle.js";
import { initializeLocalState } from "../../src/config/init.js";
import { appPaths } from "../../src/config/paths.js";
import { loadApprovals, saveApprovals } from "../../src/config/approvals.js";
import { saveRegistry } from "../../src/config/registry.js";
import { deriveBindingFingerprint, type BrowserAgentDefinition } from "../../src/domain/agent.js";
import { configDigest, WorkspaceConfigSchema, workspaceKey } from "../../src/domain/workspace.js";
import { ApprovalService } from "../../src/services/approval-service.js";
import { IpcClient } from "../../src/ipc/client.js";
import { IpcBrokerClient } from "../../src/frontend/ipc-client.js";
import type { InteractiveAgentTransport, TransportConversation } from "../../src/transports/transport.js";
import { TransportRouter } from "../../src/transports/transport-router.js";

const noopLocalStatePreparer = {
  async prepareLocalState() {
    /* no browser profile to prepare in this fixture */
  }
};

const readDescriptorForTest = readDescriptor;

const initialFingerprint = `sha256:${"a".repeat(64)}`;
const agent: BrowserAgentDefinition = {
  alias: "requirements",
  displayName: "Requirements Agent",
  kind: "m365-agent-builder",
  transport: "browser",
  entryPoint: {
    mode: "direct-chat",
    url: "https://m365.example.test/chat/requirements",
    surface: "m365-copilot"
  },
  description: "Internal requirements",
  usageHint: "Use for specifications",
  enabled: true,
  capabilityClass: "knowledge-only",
  uiActionPolicy: "never-click",
  verification: {
    status: "verified",
    adapterId: "m365-copilot-chat@1",
    expectedDisplayName: "Requirements Agent",
    expectedStableAgentId: "agent-1",
    expectedSurface: "m365-copilot",
    validatedUrlPattern: "^/chat/requirements$",
    bindingFingerprint: initialFingerprint,
    validatedAt: "2026-09-01T00:00:00.000Z"
  }
};
const fingerprint = deriveBindingFingerprint(agent);
agent.verification.bindingFingerprint = fingerprint;

class FakeTransport implements InteractiveAgentTransport {
  readonly name = "fake";
  creates = 0;
  invokes = 0;
  closes = 0;
  disposed = 0;
  disposeHook?: () => Promise<void>;
  lastLoginTimeout?: number;
  lastInspectedUrl?: string;
  invokeHook?: (call: number) => Promise<void>;
  closeHook?: (call: number) => Promise<void>;
  private crashHandler?: (event: { reason: "crash" | "reset" }) => void;
  healthCheck = async () => ({
    healthy: true,
    browser: { channel: "chrome" as const, headless: true, viewport: { width: 1440, height: 900 } }
  });
  validateAgent = async () => ({ valid: true });
  async createConversation(
    _agent: unknown,
    context: { workspaceKey: string; conversationHandle: string }
  ): Promise<TransportConversation> {
    this.creates++;
    return { transportId: "browser", opaque: `page-${context.conversationHandle}` };
  }
  async invoke(conversation: TransportConversation) {
    this.invokes++;
    await this.invokeHook?.(this.invokes);
    return {
      agent: "requirements",
      conversationHandle: String(conversation.opaque),
      text: "answer",
      citations: [],
      elapsedMs: 1,
      truncated: false,
      actionRequired: false,
      submissionState: "sent" as const,
      sourceType: "m365-agent" as const
    };
  }
  async closeConversation() {
    this.closes++;
    await this.closeHook?.(this.closes);
  }
  async dispose() {
    this.disposed++;
    await this.disposeHook?.();
  }
  loginFailure?: Error;
  signInInProgress = false;
  cancels = 0;
  async login(timeoutMs?: number, _onProgress?: ProgressSink) {
    this.lastLoginTimeout = timeoutMs;
    if (this.loginFailure) throw this.loginFailure;
    return { authenticated: this.name === "fake", state: "authenticated" };
  }
  async cancelLogin() {
    this.cancels++;
    const cancelled = this.signInInProgress;
    this.signInInProgress = false;
    return { cancelled };
  }
  async inspectAgentUrl(url: string) {
    this.lastInspectedUrl = `${this.name}:${url}`;
    return {
      url,
      surface: "m365-copilot" as const,
      adapterId: "m365-copilot-chat@1",
      displayName: "Requirements Agent",
      stableAgentId: "agent-1",
      validatedUrlPattern: "^/chat/requirements$"
    };
  }
  isBrowserRunning = () => false;
  onBrowserCrash = (handler: (event: { reason: "crash" | "reset" }) => void) => {
    this.crashHandler = handler;
    return () => {
      this.crashHandler = undefined;
    };
  };
  emitCrash() {
    this.crashHandler?.({ reason: "crash" });
  }
  emitReset() {
    this.crashHandler?.({ reason: "reset" });
  }
}

describe("frontend → authenticated IPC → broker", () => {
  const servers: BrokerServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it.each(["ask", "session"] as const)(
    "keeps %s pending across sign-in and browser reset over IPC",
    async (operation) => {
      const fixture = await setup(true);
      servers.push(fixture.server);
      const signedIn = Promise.withResolvers<void>();
      const events: ProgressEvent[] = [];
      vi.spyOn(fixture.transport, "createConversation").mockRejectedValueOnce(
        new DomainError("AUTH_REQUIRED", "Session expired")
      );
      const login = vi.spyOn(fixture.transport, "login").mockImplementation(async (_timeout, onProgress) => {
        fixture.transport.emitReset();
        onProgress?.({ phase: "login-waiting" });
        await signedIn.promise;
        onProgress?.({ phase: "done" });
        return { authenticated: true, state: "authenticated" };
      });
      const progress: ProgressSink = (event) => events.push(event);
      const pending =
        operation === "ask"
          ? fixture.frontend.ask(
              fixture.workspaceRoot,
              { agent: "requirements", message: "hello" },
              "req-auto-login",
              undefined,
              progress
            )
          : fixture.frontend.session(
              fixture.workspaceRoot,
              { action: "new", agent: "requirements" },
              "req-auto-login",
              undefined,
              progress
            );
      try {
        await vi.waitFor(() => expect(events.some((event) => event.phase === "login-waiting")).toBe(true));
        expect(fixture.transport.invokes).toBe(0);
        signedIn.resolve();
        expect(await pending).toMatchObject({ ok: true });
        expect(login).toHaveBeenCalledTimes(1);
        expect(events.some((event) => event.phase === "connecting")).toBe(true);
        expect(fixture.transport.invokes).toBe(operation === "ask" ? 1 : 0);
        await expect(fixture.client.call("broker.health", {})).resolves.toMatchObject({
          authState: { state: "authenticated" }
        });
      } finally {
        signedIn.resolve();
        fixture.client.close();
      }
    }
  );

  it("keeps an unapproved repository request private and blocks before transport", async () => {
    const fixture = await setup(false);
    servers.push(fixture.server);
    const list = await fixture.frontend.list(fixture.workspaceRoot, "req-list");
    expect(list).toMatchObject({
      ok: true,
      agents: [{ alias: "requirements", status: "approval-required" }]
    });
    expect((list as { agents: Record<string, unknown>[] }).agents[0]).not.toHaveProperty("name");
    const ask = await fixture.frontend.ask(
      fixture.workspaceRoot,
      { agent: "requirements", message: "hello" },
      "req-ask"
    );
    expect(ask).toMatchObject({ code: "WORKSPACE_APPROVAL_REQUIRED" });
    expect(fixture.transport.creates).toBe(0);
    fixture.client.close();
  });

  it("invokes interactive browser methods with their transport receiver intact", async () => {
    const fixture = await setup(false);
    servers.push(fixture.server);
    await expect(fixture.client.call("browser.login", { timeoutMs: 12_345 })).resolves.toEqual({
      authenticated: true,
      state: "authenticated"
    });
    expect(fixture.transport.lastLoginTimeout).toBe(12_345);
    await expect(
      fixture.client.call("agent.inspectUrl", { url: "https://m365.example.test/chat/requirements" })
    ).resolves.toMatchObject({ displayName: "Requirements Agent" });
    expect(fixture.transport.lastInspectedUrl).toBe("fake:https://m365.example.test/chat/requirements");
    fixture.client.close();
  });

  it("cancels an interactive sign-in through browser.cancelLogin, and reports when there was none", async () => {
    const fixture = await setup(false);
    servers.push(fixture.server);

    // Nothing is signing in: cancelling is answered, not refused.
    await expect(fixture.client.call("browser.cancelLogin", {})).resolves.toEqual({ cancelled: false });

    fixture.transport.signInInProgress = true;
    await expect(fixture.client.call("browser.cancelLogin", {})).resolves.toEqual({ cancelled: true });
    expect(fixture.transport.cancels).toBe(2);
    // The method takes no arguments at all.
    await expect(fixture.client.call("browser.cancelLogin", { timeoutMs: 1 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT"
    });
    fixture.client.close();
  });

  it("keeps local registry details private when a previously approved agent becomes ineligible", async () => {
    const fixture = await setup(true);
    servers.push(fixture.server);
    await saveRegistry(fixture.paths, { version: 1, agents: [{ ...agent, enabled: false }] });
    const list = await fixture.frontend.list(fixture.workspaceRoot, "req-disabled-list");
    expect(list).toMatchObject({
      ok: true,
      agents: [{ alias: "requirements", status: "approval-required" }]
    });
    expect((list as { agents: Record<string, unknown>[] }).agents[0]).not.toHaveProperty("name");
    expect((list as { agents: Record<string, unknown>[] }).agents[0]).not.toHaveProperty("capabilityClass");
    fixture.client.close();
  });

  it("returns public envelopes and automatically closes a one-shot ask", async () => {
    const fixture = await setup(true);
    servers.push(fixture.server);
    const list = await fixture.frontend.list(fixture.workspaceRoot, "req-list");
    expect(list).toMatchObject({
      ok: true,
      requestId: "req-list",
      workspace: { approvalStatus: "approved" },
      agents: [{ alias: "requirements", name: "Requirements Agent", status: "ready" }]
    });
    const answer = await fixture.frontend.ask(
      fixture.workspaceRoot,
      { agent: "requirements", message: "hello" },
      "req-ask"
    );
    expect(answer).toMatchObject({
      ok: true,
      requestId: "req-ask",
      agent: "requirements",
      text: "answer",
      sourceType: "m365-agent",
      conversationClosed: true
    });
    expect((answer as { conversationHandle: string }).conversationHandle).toMatch(/^conv_/);
    const listed = await fixture.frontend.session(fixture.workspaceRoot, { action: "list" }, "req-sessions");
    expect(listed).toMatchObject({ ok: true, action: "list", conversations: [] });
    expect(fixture.transport.closes).toBe(1);
    fixture.client.close();
  });

  it("invalidates every existing handle when the browser context crashes", async () => {
    const fixture = await setup(true);
    servers.push(fixture.server);
    const created = await fixture.frontend.session(
      fixture.workspaceRoot,
      { action: "new", agent: "requirements" },
      "req-new"
    );
    const handle = (created as { conversation: { conversationHandle: string } }).conversation
      .conversationHandle;
    fixture.transport.emitCrash();
    const listed = await fixture.frontend.session(
      fixture.workspaceRoot,
      { action: "list" },
      "req-list-after-crash"
    );
    expect(listed).toMatchObject({ ok: true, conversations: [] });
    const continued = await fixture.frontend.ask(
      fixture.workspaceRoot,
      { agent: "requirements", message: "again", conversationHandle: handle },
      "req-continue-after-crash"
    );
    expect(continued).toMatchObject({ code: "CONVERSATION_EXPIRED" });
    expect(fixture.transport.invokes).toBe(0);
    fixture.client.close();
  });

  it("rechecks approval after a queued invocation obtains the conversation lock", async () => {
    const fixture = await setup(true);
    servers.push(fixture.server);
    const created = await fixture.frontend.session(
      fixture.workspaceRoot,
      { action: "new", agent: "requirements" },
      "req-queue-new"
    );
    const handle = (created as { conversation: { conversationHandle: string } }).conversation
      .conversationHandle;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    fixture.transport.invokeHook = async (call) => {
      if (call === 1) {
        started();
        await gate;
      }
    };
    const secondClient = new IpcClient(fixture.descriptor);
    await secondClient.connect();
    const secondFrontend = new IpcBrokerClient(secondClient);
    const first = fixture.frontend.ask(
      fixture.workspaceRoot,
      { agent: "requirements", message: "first", conversationHandle: handle },
      "req-queue-first"
    );
    await began;
    const second = secondFrontend.ask(
      fixture.workspaceRoot,
      { agent: "requirements", message: "second", conversationHandle: handle },
      "req-queue-second"
    );
    const queueDeadline = Date.now() + 2_000;
    while (
      ((
        fixture.server as unknown as { conversations: { queues: Map<string, number> } }
      ).conversations.queues.get(handle) ?? 0) < 2 &&
      Date.now() < queueDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      (
        fixture.server as unknown as { conversations: { queues: Map<string, number> } }
      ).conversations.queues.get(handle)
    ).toBe(2);
    const approvals = await loadApprovals(fixture.paths);
    approvals.approvals = [];
    await saveApprovals(fixture.paths, approvals);
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ code: "WORKSPACE_APPROVAL_REQUIRED" });
    expect(fixture.transport.invokes).toBe(1);
    secondClient.close();
    fixture.client.close();
  });

  it("serializes conversation.close against a same-handle invoke through the conversation mutex instead of racing the transport", async () => {
    const fixture = await setup(true);
    servers.push(fixture.server);
    const created = await fixture.frontend.session(
      fixture.workspaceRoot,
      { action: "new", agent: "requirements" },
      "req-close-race-new"
    );
    const handle = (created as { conversation: { conversationHandle: string } }).conversation
      .conversationHandle;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Gate the transport-level close so it stays "in flight" while we issue an invoke for the
    // same handle. Before the fix, conversation.close called transport.closeConversation directly
    // without going through the per-conversation mutex, so a same-handle invoke queued via
    // runExclusive could start (and call transport.invoke) concurrently with the still-pending
    // transport close. After the fix, the close itself now runs inside runExclusive, so the
    // invoke queues behind it and never touches the transport until the close (including marking
    // the conversation expired) has fully completed.
    fixture.transport.closeHook = async () => {
      started();
      await gate;
    };
    const secondClient = new IpcClient(fixture.descriptor);
    await secondClient.connect();
    const secondFrontend = new IpcBrokerClient(secondClient);
    const closeCall = fixture.frontend.session(
      fixture.workspaceRoot,
      { action: "close", conversationHandle: handle },
      "req-close-race-close"
    );
    await began;
    const invokeCall = secondFrontend.ask(
      fixture.workspaceRoot,
      { agent: "requirements", message: "during-close", conversationHandle: handle },
      "req-close-race-invoke"
    );
    const queueDeadline = Date.now() + 2_000;
    while (
      ((
        fixture.server as unknown as { conversations: { queues: Map<string, number> } }
      ).conversations.queues.get(handle) ?? 0) < 2 &&
      Date.now() < queueDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      (
        fixture.server as unknown as { conversations: { queues: Map<string, number> } }
      ).conversations.queues.get(handle)
    ).toBe(2);
    expect(fixture.transport.invokes).toBe(0);
    release();
    await expect(closeCall).resolves.toMatchObject({ ok: true, action: "close" });
    await expect(invokeCall).resolves.toMatchObject({ code: "CONVERSATION_EXPIRED" });
    expect(fixture.transport.invokes).toBe(0);
    expect(fixture.transport.closes).toBe(1);
    secondClient.close();
    fixture.client.close();
  });
});

async function setup(approved: boolean, idleExpirationMinutes = 30) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-pick-link-e2e-"));
  const paths = await initializeLocalState(appPaths(path.join(base, "appdata")), noopLocalStatePreparer);
  if (idleExpirationMinutes !== 30) {
    const global = await loadGlobalConfig(paths);
    global.conversations.idleExpirationMinutes = idleExpirationMinutes;
    await saveGlobalConfig(paths, global);
  }
  const workspaceRoot = path.join(base, "workspace");
  await mkdir(workspaceRoot);
  const normalizedWorkspaceRoot = normalizeRoot(await realpath(workspaceRoot));
  const config = WorkspaceConfigSchema.parse({
    version: 1,
    agents: [{ alias: agent.alias, bindingFingerprint: fingerprint }]
  });
  await writeFile(path.join(workspaceRoot, ".m365-agents.json"), JSON.stringify(config));
  await saveRegistry(paths, { version: 1, agents: [agent] });
  if (approved) {
    const approvals = await loadApprovals(paths);
    new ApprovalService(approvals).approve(
      {
        root: normalizedWorkspaceRoot,
        workspaceKey: workspaceKey(normalizedWorkspaceRoot),
        config,
        configDigest: configDigest(config)
      },
      [agent]
    );
    await saveApprovals(paths, approvals);
  }
  const transport = new FakeTransport();
  const router = new TransportRouter().register("browser", transport);
  const socket = testIpcEndpoint(base);
  const server = new BrokerServer({ paths, pipeName: socket, packageVersion: "test", router });
  const descriptor = await server.start();
  const client = new IpcClient(descriptor);
  await client.connect();
  return {
    workspaceRoot,
    paths,
    server,
    descriptor,
    transport,
    client,
    frontend: new IpcBrokerClient(client)
  };
}

describe("broker resource maintenance", () => {
  afterEach(() => vi.useRealTimers());

  it("closes idle conversation pages on the timer while the broker remains available", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fixture = await setup(true, 1);
    try {
      await fixture.frontend.session(fixture.workspaceRoot, { action: "new", agent: agent.alias }, "create");
      expect(fixture.transport.creates).toBe(1);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(fixture.transport.closes).toBe(1);
      await expect(fixture.client.call("broker.health", {})).resolves.toHaveProperty("instanceId");
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(fixture.transport.closes).toBe(1);
    } finally {
      fixture.client.close();
      await fixture.server.stop();
    }
  });

  it("does not idle-stop an active login with no conversation and restarts its idle clock on completion", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fixture = await setup(false);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.transport.login = async () => {
      entered();
      await gate;
      return { authenticated: true, state: "authenticated" };
    };
    const login = fixture.client.call("browser.login", {});
    try {
      await started;
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      await expect(fixture.client.call("broker.health", {})).resolves.toHaveProperty("instanceId");
      release();
      await login;
      expect(fixture.server.lastActivityAt()).toBe(Date.now());
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(fixture.client.call("broker.health", {})).resolves.toHaveProperty("instanceId");
    } finally {
      release();
      await login.catch(() => undefined);
      fixture.client.close();
      await fixture.server.stop();
    }
  });

  it("drains an active browser request before disposing the transport and descriptor", async () => {
    const fixture = await setup(true);
    let release!: () => void;
    let entered!: () => void;
    const enteredInvoke = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const invocationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.transport.invokeHook = async () => {
      entered();
      await invocationGate;
    };
    const request = fixture.frontend.ask(
      fixture.workspaceRoot,
      { agent: agent.alias, message: "keep this page alive" },
      "req-shutdown-drain"
    );
    await enteredInvoke;
    const stopping = fixture.server.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.transport.disposed).toBe(0);
    expect(await readDescriptorForTest(fixture.paths)).toBeDefined();
    release();
    await expect(request).resolves.toMatchObject({ text: "answer" });
    await stopping;
    expect(fixture.transport.disposed).toBe(1);
    expect(await readDescriptorForTest(fixture.paths)).toBeUndefined();
    fixture.client.close();
  });

  it("keeps the descriptor until broker.shutdown has finished disposing the browser", async () => {
    const fixture = await setup(true);
    let release!: () => void;
    let entered!: () => void;
    const disposeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const disposeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.transport.disposeHook = async () => {
      entered();
      await disposeGate;
    };
    await expect(fixture.client.call("broker.shutdown", {})).resolves.toEqual({ stopping: true });
    await disposeEntered;
    expect(await readDescriptorForTest(fixture.paths)).toMatchObject({ state: "stopping" });
    release();
    while (await readDescriptorForTest(fixture.paths)) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fixture.transport.disposed).toBe(1);
    fixture.client.close();
  });

  it("retains ownership when transport disposal fails and allows a later shutdown retry", async () => {
    const fixture = await setup(true);
    fixture.transport.disposeHook = async () => {
      throw new Error("profile context is still closing");
    };

    await expect(fixture.client.call("broker.shutdown", {})).resolves.toEqual({ stopping: true });
    // Publishing the failure rewrites a protected descriptor through real Windows ACLs.
    const deadline = Date.now() + (process.platform === "win32" ? 20_000 : 2_000);
    while ((await readDescriptorForTest(fixture.paths))?.state !== "stop-failed") {
      if (Date.now() >= deadline) throw new Error("Shutdown failure was not published");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await readDescriptorForTest(fixture.paths)).toMatchObject({
      instanceId: fixture.descriptor.instanceId,
      state: "stop-failed"
    });

    const management = await connectExistingBroker(fixture.paths);
    expect(management).toBeDefined();
    await expect(management!.call("broker.health", {})).resolves.toMatchObject({
      stopping: true,
      stopFailed: true
    });
    await expect(management!.call("workspace.list", { root: fixture.workspaceRoot })).rejects.toMatchObject({
      code: "BROKER_UNAVAILABLE"
    });
    fixture.transport.disposeHook = undefined;
    await expect(management!.call("broker.shutdown", {})).resolves.toEqual({ stopping: true });
    management!.close();
    while (await readDescriptorForTest(fixture.paths)) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await readDescriptorForTest(fixture.paths)).toBeUndefined();
    fixture.client.close();
  });
});

describe("broker health: incidents and authentication state", () => {
  const servers: BrokerServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it("records a real browser crash as an incident but not a deliberate sign-in reset", async () => {
    const fixture = await setup(true);
    servers.push(fixture.server);
    fixture.transport.emitReset();
    let health = (await fixture.client.call("broker.health", {})) as { incidents: unknown[] };
    expect(health.incidents).toEqual([]);
    fixture.transport.emitCrash();
    health = (await fixture.client.call("broker.health", {})) as { incidents: Array<{ code: string }> };
    expect(health.incidents.map((item) => item.code)).toEqual(["BROWSER_CRASHED"]);
    fixture.client.close();
  });

  it("folds the browser transport's description, cached once at startup, into every incident it records", async () => {
    const fixture = await setup(true);
    servers.push(fixture.server);
    fixture.transport.emitCrash();
    const health = (await fixture.client.call("broker.health", {})) as {
      incidents: Array<{ code: string; browser?: unknown }>;
    };
    expect(health.incidents).toEqual([
      expect.objectContaining({
        code: "BROWSER_CRASHED",
        browser: { channel: "chrome", headless: true, viewport: { width: 1440, height: 900 } }
      })
    ]);
    fixture.client.close();
  });

  it("always reports the development-mode flags in broker.health", async () => {
    const fixture = await setup(true);
    servers.push(fixture.server);
    const health = (await fixture.client.call("broker.health", {})) as {
      devMode?: { insecureLoopback: boolean; devAppUrl: boolean };
    };
    // A transport that says nothing about development switches reads as the production shape.
    expect(health.devMode).toEqual({ insecureLoopback: false, devAppUrl: false });
    fixture.client.close();
  });

  it("does not count broker.health (or broker.shutdown) polling as activity for the idle-shutdown clock", async () => {
    const fixture = await setup(true);
    servers.push(fixture.server);
    const server = fixture.server as unknown as { lastActivityAt(): number };

    const initial = server.lastActivityAt();
    await fixture.client.call("broker.health", {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fixture.client.call("broker.health", {});
    expect(server.lastActivityAt()).toBe(initial);

    // A real domain call still bumps it, so the exemption is specific to health/shutdown, not a
    // general regression that stopped tracking activity altogether.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fixture.frontend.list(fixture.workspaceRoot, "req-activity");
    expect(server.lastActivityAt()).toBeGreaterThan(initial);

    fixture.client.close();
  });

  it("reports a timed-out interactive sign-in as sign-in-required, and a denial as access-denied", async () => {
    const fixture = await setup(true);
    servers.push(fixture.server);
    fixture.transport.loginFailure = new DomainError(
      "AUTH_FAILED",
      "Interactive Microsoft 365 sign-in timed out."
    );
    await expect(fixture.client.call("browser.login", {})).rejects.toMatchObject({ code: "AUTH_FAILED" });
    let health = (await fixture.client.call("broker.health", {})) as { authState?: { state: string } };
    expect(health.authState?.state).toBe("sign-in-required");
    fixture.transport.loginFailure = new DomainError("AUTH_FAILED", "Microsoft 365 access was denied.");
    await expect(fixture.client.call("browser.login", {})).rejects.toMatchObject({ code: "AUTH_FAILED" });
    health = (await fixture.client.call("broker.health", {})) as { authState?: { state: string } };
    expect(health.authState?.state).toBe("access-denied");
    fixture.client.close();
  });
});
