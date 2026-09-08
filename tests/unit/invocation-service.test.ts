import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GlobalConfigSchema } from "../../src/config/schema.js";
import type { Registry } from "../../src/config/registry.js";
import type { ApprovalStore } from "../../src/domain/approval.js";
import { deriveBindingFingerprint, type BrowserAgentDefinition } from "../../src/domain/agent.js";
import { DomainError } from "../../src/domain/errors.js";
import { configDigest, WorkspaceConfigSchema, workspaceKey } from "../../src/domain/workspace.js";
import type { ProgressEvent } from "../../src/domain/progress.js";
import { AuditLogger } from "../../src/observability/audit.js";
import { attachDiagnostics, IncidentLog, type IncidentBrowser } from "../../src/observability/incidents.js";
import { ConversationService } from "../../src/services/conversation-service.js";
import { InvocationService } from "../../src/services/invocation-service.js";
import { PolicyService } from "../../src/services/policy-service.js";
import { InvocationLimiter } from "../../src/services/rate-limiter.js";
import { WorkspaceService } from "../../src/services/workspace-service.js";
import { TransportRouter } from "../../src/transports/transport-router.js";
import type {
  AgentInvokeRequest,
  AgentTransport,
  InteractiveAgentTransport,
  InvocationContext,
  TransportConversation
} from "../../src/transports/transport.js";

const template: BrowserAgentDefinition = {
  alias: "requirements",
  displayName: "Requirements Agent",
  kind: "m365-agent-builder",
  transport: "browser",
  entryPoint: {
    mode: "direct-chat",
    url: "https://m365.example.test/chat/requirements",
    surface: "m365-copilot"
  },
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
    bindingFingerprint: `sha256:${"a".repeat(64)}`,
    validatedAt: "2026-09-01T00:00:00.000Z"
  }
};
const agent: BrowserAgentDefinition = {
  ...template,
  verification: { ...template.verification, bindingFingerprint: deriveBindingFingerprint(template) }
};

class FakeTransport implements AgentTransport {
  readonly name = "fake";
  creates = 0;
  invokes = 0;
  closes = 0;
  responseText = "an answer";
  invokeHook?: (call: number) => Promise<void>;
  failWith?: DomainError;
  closeFailure?: DomainError;
  closeFailuresRemaining = 0;
  closeHook?: () => Promise<void>;
  createFailure?: DomainError;
  login?: InteractiveAgentTransport["login"];
  isLoginPending?: InteractiveAgentTransport["isLoginPending"];
  lastRequest?: AgentInvokeRequest;
  lastCreateContext?: InvocationContext;
  healthCheck = async () => ({ healthy: true });
  validateAgent = async () => ({ valid: true });
  async createConversation(_agent: unknown, context: InvocationContext): Promise<TransportConversation> {
    this.creates++;
    this.lastCreateContext = context;
    if (this.createFailure) throw this.createFailure;
    return { transportId: "browser", opaque: `page-${context.conversationHandle}` };
  }
  async invoke(conversation: TransportConversation, request?: AgentInvokeRequest) {
    this.invokes++;
    this.lastRequest = request;
    await this.invokeHook?.(this.invokes);
    if (this.failWith) throw this.failWith;
    return {
      agent: agent.alias,
      conversationHandle: String(conversation.opaque),
      text: this.responseText,
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
    await this.closeHook?.();
    if (this.closeFailure && this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining--;
      throw this.closeFailure;
    }
  }
  async dispose() {}
}

async function harness(
  options: {
    approved?: boolean;
    assignedAlias?: string;
    maxPerMinute?: number;
    incidents?: IncidentLog;
    browserDescription?: () => IncidentBrowser | undefined;
  } = {}
) {
  const base = await mkdtemp(path.join(os.tmpdir(), "apl-invocation-"));
  const logs = path.join(base, "logs");
  const diagnostics = path.join(base, "diagnostics");
  const workspaceRoot = await realpath(
    await mkdir(path.join(base, "workspace"), { recursive: true }).then(() => path.join(base, "workspace"))
  );
  const config = WorkspaceConfigSchema.parse({
    version: 1,
    agents: [{ alias: options.assignedAlias ?? agent.alias }]
  });
  await writeFile(path.join(workspaceRoot, ".m365-agents.json"), JSON.stringify(config));
  const registry: Registry = { version: 1, agents: [agent] };
  const approvals: ApprovalStore = {
    version: 1,
    approvals:
      options.approved === false
        ? []
        : [
            {
              workspaceKey: workspaceKey(workspaceRoot),
              approvedBindings: [
                {
                  alias: agent.alias,
                  bindingFingerprint: agent.verification.bindingFingerprint,
                  capabilityClass: "knowledge-only"
                }
              ],
              approvedConfigDigest: configDigest(config),
              approvedAt: new Date().toISOString(),
              approvalVersion: 1
            }
          ]
  };
  const loads = { config: 0, registry: 0, approvals: 0 };
  const policy = new PolicyService(new WorkspaceService(), {
    config: async () => {
      loads.config++;
      return GlobalConfigSchema.parse({ version: 1, browser: { profilePath: path.join(base, "profile") } });
    },
    registry: async () => {
      loads.registry++;
      return registry;
    },
    approvals: async () => {
      loads.approvals++;
      return approvals;
    }
  });
  const transport = new FakeTransport();
  const conversations = new ConversationService("broker_test", {
    maxPerWorkspace: 6,
    maxTotal: 10,
    idleExpirationMinutes: 30,
    perConversationQueueLimit: 3
  });
  const service = new InvocationService({
    policy,
    conversations,
    limiter: new InvocationLimiter(4, options.maxPerMinute ?? 30),
    router: new TransportRouter().register("browser", transport),
    audit: new AuditLogger(logs, true),
    diagnosticsPath: diagnostics,
    incidents: options.incidents,
    browserDescription: options.browserDescription
  });
  const queued = (handle: string) =>
    (conversations as unknown as { queues: Map<string, number> }).queues.get(handle) ?? 0;
  return { service, conversations, transport, approvals, loads, workspaceRoot, logs, diagnostics, queued };
}

describe("InvocationService", () => {
  it("reports every successfully closed conversation without expiring newly created ones", async () => {
    const fixture = await harness();
    const first = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    const second = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    const release = Promise.withResolvers<void>();
    fixture.transport.closeHook = () => release.promise;
    const pending = fixture.service.closeAll(fixture.workspaceRoot);
    await vi.waitFor(() => expect(fixture.transport.closes).toBe(2));
    const newer = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    release.resolve();

    const closed = await pending;
    expect(closed.map((item) => item.handle).sort()).toEqual([first.handle, second.handle].sort());
    expect(fixture.conversations.get(newer.handle).state).toBe("ready");
    expect(fixture.conversations.activeCount()).toBe(1);
  });

  it("retries failed close-all pages in maintenance and only counts successful closes", async () => {
    const fixture = await harness();
    const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    fixture.transport.closeFailure = new DomainError("BROWSER_START_FAILED", "close failed");
    fixture.transport.closeFailuresRemaining = 1;

    expect(await fixture.service.closeAll(fixture.workspaceRoot)).toEqual([]);
    expect(fixture.conversations.activeCount()).toBe(0);
    expect(fixture.conversations.has(conversation.handle)).toBe(true);
    await fixture.service.cleanupExpiredPages();
    expect(fixture.transport.closes).toBe(2);
    expect(fixture.conversations.has(conversation.handle)).toBe(false);
  });

  it.each([false, true])(
    "preserves the completed response when audit storage fails (explicit handle: %s)",
    async (explicit) => {
      const fixture = await harness();
      // A file at the logs directory deterministically makes AuditLogger.mkdir fail.
      await writeFile(fixture.logs, "not a directory");
      const conversation = explicit
        ? await fixture.service.create(fixture.workspaceRoot, agent.alias)
        : undefined;

      const result = await fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "question",
        conversation?.handle,
        "req-audit-storage-failure"
      );

      expect(result).toMatchObject({
        text: "an answer",
        submissionState: "sent",
        conversationClosed: !explicit
      });
      expect(fixture.transport.invokes).toBe(1);
      expect(fixture.transport.closes).toBe(explicit ? 0 : 1);
      expect(fixture.conversations.activeCount()).toBe(explicit ? 1 : 0);
    }
  );

  it("holds a fresh ask for human sign-in, re-creates after profile reset, and sends exactly once", async () => {
    const fixture = await harness();
    const events: ProgressEvent[] = [];
    const signedIn = Promise.withResolvers<void>();
    fixture.transport.createFailure = new DomainError("AUTH_REQUIRED", "Session expired");
    fixture.transport.login = vi.fn(async (timeout, progress) => {
      expect(timeout).toBe(300_000);
      fixture.conversations.failAll(); // Broker's real profile-reset callback.
      progress?.({ phase: "login-waiting" });
      await signedIn.promise;
      fixture.transport.createFailure = undefined;
      progress?.({ phase: "done" });
      return { authenticated: true, state: "authenticated" };
    });
    const pending = fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "question",
      undefined,
      "req-login",
      (event) => events.push(event)
    );
    await vi.waitFor(() => expect(fixture.transport.login).toHaveBeenCalledTimes(1));
    expect(fixture.transport.invokes).toBe(0);
    signedIn.resolve();
    const result = await pending;
    expect(result.text).toBe("an answer");
    expect(result.conversationClosed).toBe(true);
    expect(fixture.transport.creates).toBe(2);
    expect(fixture.transport.invokes).toBe(1);
    expect(fixture.transport.closes).toBe(1);
    expect(fixture.conversations.activeCount()).toBe(0);
    expect(() => fixture.conversations.get(result.conversationHandle)).toThrow(/expired|invalidated/i);
    expect(events.map((event) => event.phase)).toContain("login-waiting");
    expect(events.map((event) => event.phase)).toContain("connecting");
    expect(events.map((event) => event.phase)).not.toContain("done");
  });

  it("keeps a successful one-shot response when closing its page fails, then retries cleanup", async () => {
    const fixture = await harness();
    fixture.transport.closeFailure = new DomainError("BROWSER_START_FAILED", "page close failed");
    fixture.transport.closeFailuresRemaining = 2;

    const result = await fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "question",
      undefined,
      "req-one-shot-close-failure"
    );

    expect(result).toMatchObject({
      conversationClosed: false,
      conversationCleanupPending: true,
      text: "an answer"
    });
    // The close is attempted while the invocation lock is held and once more by the existing
    // expired-page sweep after that lock is released. The prompt must never be invoked again.
    expect(fixture.transport.invokes).toBe(1);
    expect(fixture.transport.closes).toBe(2);
    expect(fixture.conversations.activeCount()).toBe(0);
    // The first ask close and immediate cleanup both failed. The same expired record remains
    // indexed, so a later maintenance pass can retry the browser page and retire it.
    await fixture.service.cleanupExpiredPages();
    expect(fixture.transport.closes).toBe(3);
    expect(() => fixture.conversations.get(result.conversationHandle)).toThrow(/unknown|expired/i);
  });

  it("reports a one-shot page as closed when the first maintenance retry succeeds", async () => {
    const fixture = await harness();
    fixture.transport.closeFailure = new DomainError("BROWSER_START_FAILED", "page close failed");
    fixture.transport.closeFailuresRemaining = 1;

    const result = await fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "question",
      undefined,
      "req-one-shot-close-retry-success"
    );

    expect(result).toMatchObject({ conversationClosed: true, text: "an answer" });
    expect(result.conversationCleanupPending).toBeUndefined();
    expect(fixture.transport.invokes).toBe(1);
    expect(fixture.transport.closes).toBe(2);
    expect(fixture.conversations.activeCount()).toBe(0);
  });

  it("single-flights concurrent maintenance cleanup for the same expired page", async () => {
    const fixture = await harness();
    const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    fixture.conversations.close(conversation.handle, conversation.workspaceKey);
    const released = Promise.withResolvers<void>();
    fixture.transport.closeHook = vi.fn(() => released.promise);

    const first = fixture.service.cleanupExpiredPages();
    await vi.waitFor(() => expect(fixture.transport.closes).toBe(1));
    const second = fixture.service.cleanupExpiredPages();
    await Promise.resolve();
    expect(fixture.transport.closes).toBe(1);

    released.resolve();
    await Promise.all([first, second]);
    expect(fixture.transport.closes).toBe(1);
    expect(() => fixture.conversations.get(conversation.handle)).toThrow(/expired|invalidated/i);
  });

  it("keeps an explicitly created conversation reusable after an ask", async () => {
    const fixture = await harness();
    const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    expect(fixture.transport.lastCreateContext).toMatchObject({
      workspaceRoot: fixture.workspaceRoot,
      workspaceKey: workspaceKey(fixture.workspaceRoot)
    });

    const result = await fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "question",
      conversation.handle,
      "req-explicit-handle"
    );

    expect(result).toMatchObject({ conversationHandle: conversation.handle, conversationClosed: false });
    expect(fixture.transport.closes).toBe(0);
    expect(fixture.conversations.get(conversation.handle).state).toBe("ready");
  });

  it("shares a pending sign-in with a second authorized caller and delivers progress to both", async () => {
    const fixture = await harness();
    const signedIn = Promise.withResolvers<void>();
    const firstEvents: ProgressEvent[] = [];
    const secondEvents: ProgressEvent[] = [];
    fixture.transport.createFailure = new DomainError("AUTH_REQUIRED", "Session expired");
    fixture.transport.login = vi.fn(async (_timeout, progress) => {
      await signedIn.promise;
      fixture.transport.createFailure = undefined;
      progress?.({ phase: "verifying" });
      return { authenticated: true, state: "authenticated" };
    });
    const first = fixture.service.create(fixture.workspaceRoot, agent.alias, (event) =>
      firstEvents.push(event)
    );
    await vi.waitFor(() => expect(fixture.transport.login).toHaveBeenCalledTimes(1));
    const second = fixture.service.create(fixture.workspaceRoot, agent.alias, (event) =>
      secondEvents.push(event)
    );
    await vi.waitFor(() => expect(secondEvents[0]?.phase).toBe("login-waiting"));
    expect(fixture.transport.creates).toBe(1);
    signedIn.resolve();
    const results = await Promise.all([first, second]);
    expect(results[0].handle).not.toBe(results[1].handle);
    expect(fixture.transport.login).toHaveBeenCalledTimes(1);
    expect(firstEvents.at(-1)?.phase).toBe("verifying");
    expect(secondEvents.at(-1)?.phase).toBe("verifying");
  });

  it("joins a panel sign-in before allocating a handle that its profile reset would invalidate", async () => {
    const fixture = await harness();
    fixture.transport.isLoginPending = () => true;
    fixture.transport.login = vi.fn(async () => {
      expect(fixture.transport.creates).toBe(0);
      fixture.conversations.failAll();
      return { authenticated: true, state: "authenticated" };
    });
    await expect(fixture.service.create(fixture.workspaceRoot, agent.alias)).resolves.toMatchObject({
      state: "ready"
    });
    expect(fixture.transport.login).toHaveBeenCalledTimes(1);
    expect(fixture.transport.creates).toBe(1);
  });

  it("re-checks approval after sign-in before creating or sending", async () => {
    const fixture = await harness();
    fixture.transport.createFailure = new DomainError("AUTH_REQUIRED", "Session expired");
    fixture.transport.login = async () => {
      fixture.approvals.approvals = [];
      fixture.transport.createFailure = undefined;
      return { authenticated: true, state: "authenticated" };
    };
    await expect(
      fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "question",
        undefined,
        "req-revoked-during-login"
      )
    ).rejects.toMatchObject({ code: "WORKSPACE_APPROVAL_REQUIRED" });
    expect(fixture.transport.creates).toBe(1);
    expect(fixture.transport.invokes).toBe(0);
  });

  it.each(["cancelled", "timed out", "window closed", "access denied"])(
    "stops without sending when sign-in is %s",
    async (reason) => {
      const fixture = await harness();
      const failure = new DomainError("AUTH_FAILED", reason);
      fixture.transport.createFailure = new DomainError("AUTH_REQUIRED", "Session expired");
      fixture.transport.login = vi.fn(async () => {
        throw failure;
      });
      await expect(
        fixture.service.invoke(fixture.workspaceRoot, agent.alias, "question", undefined, "req-login-failed")
      ).rejects.toBe(failure);
      expect(fixture.transport.creates).toBe(1);
      expect(fixture.transport.invokes).toBe(0);
      // Failed sign-in does not leave a rejected shared promise pinned forever.
      await expect(fixture.service.create(fixture.workspaceRoot, agent.alias)).rejects.toBe(failure);
      expect(fixture.transport.login).toHaveBeenCalledTimes(2);
    }
  );

  it("never loops the login window when the retried agent still requires authentication", async () => {
    const fixture = await harness();
    fixture.transport.createFailure = new DomainError("AUTH_REQUIRED", "Still signed out");
    fixture.transport.login = vi.fn(async () => ({ authenticated: true, state: "authenticated" }));
    await expect(fixture.service.create(fixture.workspaceRoot, agent.alias)).rejects.toMatchObject({
      code: "AUTH_REQUIRED"
    });
    expect(fixture.transport.login).toHaveBeenCalledTimes(1);
    expect(fixture.transport.creates).toBe(2);
    expect(fixture.transport.invokes).toBe(0);
  });

  it.each(["AUTH_FAILED", "POLICY_BLOCKED", "UI_CHANGED"] as const)(
    "does not open sign-in for %s",
    async (code) => {
      const fixture = await harness();
      fixture.transport.createFailure = new DomainError(code, "Not session expiry");
      fixture.transport.login = vi.fn();
      await expect(fixture.service.create(fixture.workspaceRoot, agent.alias)).rejects.toMatchObject({
        code
      });
      expect(fixture.transport.login).not.toHaveBeenCalled();
    }
  );

  it("does not open a browser for an unapproved caller", async () => {
    const fixture = await harness({ approved: false });
    fixture.transport.login = vi.fn();
    await expect(fixture.service.create(fixture.workspaceRoot, agent.alias)).rejects.toMatchObject({
      code: "WORKSPACE_APPROVAL_REQUIRED"
    });
    expect(fixture.transport.login).not.toHaveBeenCalled();
    expect(fixture.transport.creates).toBe(0);
  });

  it.each(["not-sent", "sent", "unknown"] as const)(
    "never replays an invocation failure (%s)",
    async (submissionState) => {
      const fixture = await harness();
      fixture.transport.failWith = new DomainError("AUTH_REQUIRED", "Expired during invocation", false, {
        submissionState
      });
      fixture.transport.login = vi.fn();
      await expect(
        fixture.service.invoke(fixture.workspaceRoot, agent.alias, "question", undefined, "req-no-replay")
      ).rejects.toMatchObject({ code: "AUTH_REQUIRED", options: { submissionState } });
      expect(fixture.transport.login).not.toHaveBeenCalled();
      expect(fixture.transport.invokes).toBe(1);
      expect(fixture.transport.closes).toBe(1);
      expect(await fixture.service.list(fixture.workspaceRoot)).toEqual([]);
    }
  );

  it("retires and closes a fresh conversation when an ask fails after submission", async () => {
    const fixture = await harness();
    fixture.transport.failWith = new DomainError(
      "AGENT_CONTEXT_CHANGED",
      "The agent context changed after submission.",
      false,
      { submissionState: "sent" }
    );

    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "question", undefined, "req-context-change")
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHANGED", options: { submissionState: "sent" } });

    expect(fixture.transport.invokes).toBe(1);
    expect(fixture.transport.closes).toBe(1);
    expect(await fixture.service.list(fixture.workspaceRoot)).toEqual([]);
    expect(fixture.conversations.activeCount()).toBe(0);
  });

  it("keeps a caller-owned conversation available to inspect and close after context change", async () => {
    const fixture = await harness();
    const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    fixture.transport.failWith = new DomainError(
      "AGENT_CONTEXT_CHANGED",
      "The agent context changed after submission.",
      false,
      { submissionState: "sent" }
    );

    await expect(
      fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "question",
        conversation.handle,
        "req-existing-context-change"
      )
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHANGED", options: { submissionState: "sent" } });

    expect(fixture.transport.closes).toBe(0);
    expect(await fixture.service.list(fixture.workspaceRoot)).toEqual([
      expect.objectContaining({ handle: conversation.handle, state: "ready" })
    ]);
    await expect(fixture.service.close(fixture.workspaceRoot, conversation.handle)).resolves.toMatchObject({
      state: "expired"
    });
    expect(fixture.transport.closes).toBe(1);
  });

  it("records an initial page failure exactly once, including its structural diagnostic, without sending", async () => {
    const incidents = new IncidentLog();
    const fixture = await harness({ incidents });
    const failure = new DomainError("UI_CHANGED", "The chat structure did not appear.");
    const fingerprint = {
      adapterId: "fixture@1",
      hasMainRegion: true,
      hasComposer: false,
      hasSendButton: false,
      hasConversationRegion: false,
      identitySignalCount: 1
    };
    attachDiagnostics(failure, { fingerprint });
    fixture.transport.createFailure = failure;

    await expect(
      fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "private-prompt-marker",
        undefined,
        "req-create-failure"
      )
    ).rejects.toBe(failure);

    expect(fixture.transport.invokes).toBe(0);
    expect(fixture.conversations.activeCount()).toBe(0);
    expect(incidents.list()).toEqual([
      expect.objectContaining({ code: "UI_CHANGED", phase: "create", fingerprint })
    ]);
    const audit = await readFile(path.join(fixture.logs, "audit.jsonl"), "utf8");
    expect(audit.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(audit)).toMatchObject({ event: "agent.invoke.failed", errorCode: "UI_CHANGED" });
    const diagnostic = await readFile(path.join(fixture.diagnostics, "req-create-failure.json"), "utf8");
    expect(JSON.parse(diagnostic)).toMatchObject({
      errorCode: "UI_CHANGED",
      stateTransitions: ["create"],
      uiFingerprint: fingerprint
    });
    expect(audit + diagnostic + JSON.stringify(incidents.list())).not.toContain("private-prompt-marker");
  });

  it("records a standalone new-session failure and releases the failed conversation", async () => {
    const incidents = new IncidentLog();
    const fixture = await harness({ incidents });
    fixture.transport.createFailure = new DomainError("UI_CHANGED", "No chat structure.");

    await expect(fixture.service.create(fixture.workspaceRoot, agent.alias)).rejects.toMatchObject({
      code: "UI_CHANGED"
    });

    expect(incidents.list()).toEqual([expect.objectContaining({ code: "UI_CHANGED", phase: "create" })]);
    expect(fixture.conversations.activeCount()).toBe(0);
    expect(fixture.transport.invokes).toBe(0);
  });

  it("rejects an unassigned alias before the local registry is even read", async () => {
    const fixture = await harness({ assignedAlias: "other" });
    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "hello", undefined, "req-1")
    ).rejects.toMatchObject({ code: "AGENT_NOT_ASSIGNED" });
    expect(fixture.loads.registry).toBe(0);
    expect(fixture.loads.approvals).toBe(0);
    expect(fixture.transport.creates).toBe(0);
    expect(fixture.transport.invokes).toBe(0);
  });

  it("rejects an unapproved workspace before any transport work happens", async () => {
    const fixture = await harness({ approved: false });
    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "hello", undefined, "req-2")
    ).rejects.toMatchObject({ code: "WORKSPACE_APPROVAL_REQUIRED" });
    await expect(fixture.service.create(fixture.workspaceRoot, agent.alias)).rejects.toMatchObject({
      code: "WORKSPACE_APPROVAL_REQUIRED"
    });
    expect(fixture.transport.creates).toBe(0);
    expect(fixture.transport.invokes).toBe(0);
  });

  it("hides an ineligible registry entry from the roster and never selects a transport for it", async () => {
    const fixture = await harness({ approved: false });
    const roster = (await fixture.service.roster(fixture.workspaceRoot)) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(roster.agents).toEqual([
      expect.objectContaining({ alias: agent.alias, status: "approval-required" })
    ]);
    expect(roster.agents[0]).not.toHaveProperty("name");
    expect(fixture.transport.creates).toBe(0);
  });

  it("re-runs policy after the conversation lock is obtained and refuses a revoked queued invocation", async () => {
    const fixture = await harness();
    const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
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
    const first = fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "first",
      conversation.handle,
      "req-first"
    );
    await began;
    const second = fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "second",
      conversation.handle,
      "req-second"
    );
    const deadline = Date.now() + 2_000;
    while (fixture.queued(conversation.handle) < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fixture.queued(conversation.handle)).toBe(2);
    fixture.approvals.approvals = [];
    release();
    await expect(first).resolves.toMatchObject({
      conversationHandle: conversation.handle,
      conversationClosed: false,
      agent: agent.alias
    });
    await expect(second).rejects.toMatchObject({ code: "WORKSPACE_APPROVAL_REQUIRED" });
    expect(fixture.transport.invokes).toBe(1);
  });

  it("invalidates every conversation when the transport reports BROWSER_CRASHED", async () => {
    const fixture = await harness();
    const one = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    const two = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    fixture.transport.invokeHook = async () => {
      throw new DomainError("BROWSER_CRASHED", "The browser crashed.");
    };
    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "hello", one.handle, "req-crash")
    ).rejects.toMatchObject({ code: "BROWSER_CRASHED" });
    expect(await fixture.service.list(fixture.workspaceRoot)).toEqual([]);
    expect(() => fixture.conversations.get(two.handle)).toThrow(/expired|invalidated/i);
    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "again", two.handle, "req-after-crash")
    ).rejects.toMatchObject({ code: "CONVERSATION_EXPIRED" });
  });

  it("audits invocation metadata only, never the prompt or the response body", async () => {
    const fixture = await harness();
    fixture.transport.responseText = "response-body-marker";
    await fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "prompt-body-marker",
      undefined,
      "req-audit"
    );
    const raw = await readFile(path.join(fixture.logs, "audit.jsonl"), "utf8");
    expect(raw).not.toContain("prompt-body-marker");
    expect(raw).not.toContain("response-body-marker");
    const event = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual([
      "agent",
      "attachmentBytes",
      "attachmentCount",
      "citationCount",
      "conversation",
      "durationMs",
      "event",
      "requestChars",
      "requestId",
      "responseChars",
      "status",
      "workspace"
    ]);
    expect(event).toMatchObject({
      event: "agent.invoke.complete",
      requestId: "req-audit",
      agent: agent.alias,
      status: "success",
      requestChars: "prompt-body-marker".length,
      responseChars: "response-body-marker".length
    });
  });

  it("maps an exhausted per-workspace rate limit to a retryable RATE_LIMITED", async () => {
    const fixture = await harness({ maxPerMinute: 1 });
    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "one", undefined, "req-rate-1")
    ).resolves.toMatchObject({ agent: agent.alias });
    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "two", undefined, "req-rate-2")
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(fixture.transport.invokes).toBe(1);
  });

  it("forwards onProgress straight through to the transport's invoke request", async () => {
    const fixture = await harness();
    const events: ProgressEvent[] = [];
    const onProgress = (event: ProgressEvent) => events.push(event);
    await fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "hello",
      undefined,
      "req-progress",
      onProgress
    );
    expect(fixture.transport.lastRequest?.onProgress).toBe(onProgress);
    fixture.transport.lastRequest?.onProgress?.({ phase: "filling" });
    expect(events).toEqual([{ phase: "filling" }]);
  });

  it("records an incident for a failure with an incident-worthy code, but not for one without", async () => {
    const incidents = new IncidentLog();
    const fixture = await harness({ incidents });

    fixture.transport.failWith = new DomainError("UI_CHANGED", "The chat composer could not be located.");
    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "hello", undefined, "req-incident")
    ).rejects.toMatchObject({ code: "UI_CHANGED" });
    expect(incidents.list()).toEqual([
      { at: expect.any(String), code: "UI_CHANGED", phase: "invoke", message: expect.any(String) }
    ]);

    fixture.transport.failWith = new DomainError("CONVERSATION_EXPIRED", "The conversation expired.");
    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "hello", undefined, "req-no-incident")
    ).rejects.toMatchObject({ code: "CONVERSATION_EXPIRED" });
    // Still exactly the one incident recorded above -- CONVERSATION_EXPIRED is not incident-worthy.
    expect(incidents.list()).toHaveLength(1);
  });

  it("truncates an incident's message to 200 characters and never includes the prompt text", async () => {
    const incidents = new IncidentLog();
    const fixture = await harness({ incidents });
    fixture.transport.failWith = new DomainError("AUTH_REQUIRED", "x".repeat(500));

    await expect(
      fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "prompt-body-marker",
        undefined,
        "req-incident-long"
      )
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const [incident] = incidents.list();
    expect(incident.message).toHaveLength(200);
    expect(incident.message).not.toContain("prompt-body-marker");
  });

  it("folds the cached browser description into every incident it records", async () => {
    const incidents = new IncidentLog();
    const browser: IncidentBrowser = {
      channel: "chrome",
      headless: true,
      viewport: { width: 1440, height: 900 }
    };
    const fixture = await harness({ incidents, browserDescription: () => browser });
    fixture.transport.failWith = new DomainError("UI_CHANGED", "The chat composer could not be located.");

    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "hello", undefined, "req-browser-desc")
    ).rejects.toMatchObject({ code: "UI_CHANGED" });

    expect(incidents.list()).toEqual([expect.objectContaining({ code: "UI_CHANGED", browser })]);
  });

  it("folds diagnostics (e.g. a timeout's completion metadata) attached to the failing error into the incident", async () => {
    const incidents = new IncidentLog();
    const fixture = await harness({ incidents });
    const failure = new DomainError("RESPONSE_TIMEOUT", "The response did not complete before the timeout.");
    const completion = { reason: "timeout", sawStreamingSignal: false, finalChars: 42 };
    attachDiagnostics(failure, { completion });
    fixture.transport.failWith = failure;

    await expect(
      fixture.service.invoke(fixture.workspaceRoot, agent.alias, "hello", undefined, "req-completion")
    ).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });

    expect(incidents.list()).toEqual([expect.objectContaining({ code: "RESPONSE_TIMEOUT", completion })]);
  });
});
