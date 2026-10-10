import { normalizeRoot } from "../../src/services/workspace-service.js";
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
import {
  attachDiagnostics,
  diagnosticsOf,
  IncidentLog,
  type IncidentBrowser
} from "../../src/observability/incidents.js";
import { ConversationService } from "../../src/services/conversation-service.js";
import { InvocationService } from "../../src/services/invocation-service.js";
import { PolicyService } from "../../src/services/policy-service.js";
import { InvocationLimiter } from "../../src/services/rate-limiter.js";
import { WorkspaceService } from "../../src/services/workspace-service.js";
import { TransportRouter } from "../../src/transports/transport-router.js";
import type {
  AgentInvokeRequest,
  AgentReadRequest,
  AgentTransport,
  ConversationReading,
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
  reads = 0;
  readHook?: (call: number) => Promise<void>;
  readFailWith?: unknown;
  /** What the next read finds in the conversation. */
  reading: ConversationReading = {
    message: "shown",
    reply: "complete",
    response: {
      text: "the late answer",
      citations: [],
      attachments: [],
      truncated: false,
      actionRequired: false
    }
  };
  lastReadConversation?: TransportConversation;
  lastReadRequest?: AgentReadRequest;
  /** Assign `undefined` to model a transport that cannot read a conversation. */
  readConversation?: AgentTransport["readConversation"] = async (conversation, request) => {
    this.reads++;
    this.lastReadConversation = conversation;
    this.lastReadRequest = request;
    await this.readHook?.(this.reads);
    if (this.readFailWith) throw this.readFailWith;
    return this.reading;
  };
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
  const workspaceRoot = normalizeRoot(
    await realpath(
      await mkdir(path.join(base, "workspace"), { recursive: true }).then(() => path.join(base, "workspace"))
    )
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
  return {
    service,
    conversations,
    transport,
    approvals,
    registry,
    loads,
    workspaceRoot,
    logs,
    diagnostics,
    queued
  };
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

  it("forwards the caller's cancellation signal to the transport's invoke request", async () => {
    const fixture = await harness();
    const controller = new AbortController();
    await fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "hello",
      undefined,
      "req-signal",
      undefined,
      controller.signal
    );
    expect(fixture.transport.lastRequest?.signal).toBe(controller.signal);
  });

  it("never sends a request its caller cancelled while it waited, and records no incident for a cancel", async () => {
    const incidents = new IncidentLog();
    const fixture = await harness({ incidents });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "hello",
        undefined,
        "req-cancelled-early",
        undefined,
        cancelled.signal
      )
    ).rejects.toMatchObject({ code: "SUBMIT_FAILED", options: { submissionState: "not-sent" } });
    expect(fixture.transport.invokes).toBe(0);

    // Cancelled mid-response: the transport's timeout-shaped outcome is not an incident.
    const controller = new AbortController();
    fixture.transport.invokeHook = async () => controller.abort();
    fixture.transport.failWith = new DomainError("RESPONSE_TIMEOUT", "The request was cancelled.");
    await expect(
      fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "hello",
        undefined,
        "req-cancelled-late",
        undefined,
        controller.signal
      )
    ).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });
    expect(incidents.list()).toEqual([]);

    // A genuine UI failure is still an incident even when the caller happened to cancel too.
    const alsoCancelled = new AbortController();
    fixture.transport.invokeHook = async () => alsoCancelled.abort();
    fixture.transport.failWith = new DomainError("UI_CHANGED", "The chat composer could not be located.");
    await expect(
      fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "hello",
        undefined,
        "req-cancelled-ui",
        undefined,
        alsoCancelled.signal
      )
    ).rejects.toMatchObject({ code: "UI_CHANGED" });
    expect(incidents.list().map((item) => item.code)).toEqual(["UI_CHANGED"]);
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

type Fixture = Awaited<ReturnType<typeof harness>>;

/** The audit records of a harness, oldest first. */
async function auditEvents(logs: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(logs, "audit.jsonl"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const mayHaveBeenSent = () =>
  new DomainError("SUBMIT_STATE_UNKNOWN", "The message may have been submitted.", false, {
    submissionState: "unknown"
  });

/** Runs an ask that fails with `failure` and returns what the service threw. */
async function failedAsk(
  fixture: Fixture,
  failure: DomainError,
  options: { signal?: AbortSignal; handle?: string } = {}
): Promise<DomainError> {
  fixture.transport.failWith = failure;
  const outcome = await fixture.service
    .invoke(
      fixture.workspaceRoot,
      agent.alias,
      "question",
      options.handle,
      "req-failed-ask",
      undefined,
      options.signal
    )
    .then(
      () => undefined,
      (error: unknown) => error
    );
  fixture.transport.failWith = undefined;
  if (!(outcome instanceof DomainError)) throw new Error("The ask was expected to fail with a DomainError.");
  return outcome;
}

/** A one-shot ask whose message may have been sent leaves its conversation open: its handle. */
async function keptConversation(fixture: Fixture): Promise<string> {
  const handle = (await failedAsk(fixture, mayHaveBeenSent())).options.conversationHandle;
  if (!handle) throw new Error("The failed ask was expected to keep its conversation.");
  return handle;
}

/** A second, otherwise valid workspace: a handle of the first must not be readable from it. */
async function anotherWorkspace(): Promise<string> {
  const root = normalizeRoot(await realpath(await mkdtemp(path.join(os.tmpdir(), "apl-invocation-other-"))));
  await writeFile(
    path.join(root, ".m365-agents.json"),
    JSON.stringify(WorkspaceConfigSchema.parse({ version: 1, agents: [{ alias: agent.alias }] }))
  );
  return root;
}

describe("InvocationService: a failed ask whose message was or may have been sent", () => {
  it.each([
    ["SUBMIT_STATE_UNKNOWN", "unknown", false],
    ["SUBMIT_STATE_UNKNOWN", "sent", false],
    ["RESPONSE_TIMEOUT", "sent", true],
    ["RESPONSE_TIMEOUT", "unknown", true]
  ] as const)(
    "keeps a one-shot conversation to be read after %s (%s) and returns its handle",
    async (code, submissionState, retryable) => {
      const fixture = await harness();
      const partialResponse = { text: "so far", citations: [] };
      const original = new DomainError(code, "original message text", retryable, {
        submissionState,
        partialResponse,
        retryAfterMs: 1234,
        remediation: "the original remediation"
      });

      const error = await failedAsk(fixture, original);

      // A new error that says what the transport said and adds the handle and how to use it.
      expect(error).toBeInstanceOf(DomainError);
      expect(error).not.toBe(original);
      expect(error).toMatchObject({ code, message: "original message text", retryable });
      const handle = error.options.conversationHandle!;
      expect(handle).toMatch(/^conv_[A-Za-z0-9_-]+$/);
      expect(error.options).toEqual({
        submissionState,
        partialResponse,
        retryAfterMs: 1234,
        remediation: expect.any(String),
        conversationHandle: handle
      });
      const remediation = error.options.remediation!;
      expect(remediation).not.toBe("the original remediation");
      expect(remediation).toContain("m365_agent_session");
      expect(remediation).toContain("action=read");
      expect(remediation).toContain(handle);
      expect(error.toResult("req-failed-ask").error).toMatchObject({
        code,
        submissionState,
        conversationHandle: handle,
        remediation
      });
      expect(original.options.conversationHandle).toBeUndefined();
      expect(original.options.remediation).toBe("the original remediation");

      // Nothing was closed, retired or sent again: the conversation waits for its read.
      expect(fixture.transport.invokes).toBe(1);
      expect(fixture.transport.reads).toBe(0);
      expect(fixture.transport.closes).toBe(0);
      expect(fixture.conversations.get(handle)).toMatchObject({ state: "ready", closeAfterRead: true });
      expect(fixture.conversations.activeCount()).toBe(1);
      expect(await fixture.service.list(fixture.workspaceRoot)).toEqual([
        expect.objectContaining({ handle })
      ]);
      // The failure is audited as before, against the conversation that stays open.
      expect(await auditEvents(fixture.logs)).toEqual([
        expect.objectContaining({
          event: "agent.invoke.failed",
          conversation: handle,
          errorCode: code,
          status: "failure"
        })
      ]);
    }
  );

  it.each([
    ["SUBMIT_STATE_UNKNOWN", "not-sent"],
    ["SUBMIT_STATE_UNKNOWN", undefined],
    ["RESPONSE_TIMEOUT", "not-sent"],
    ["RESPONSE_TIMEOUT", undefined],
    ["SUBMIT_FAILED", "unknown"],
    ["SUBMIT_FAILED", "sent"],
    ["UI_CHANGED", "not-sent"],
    ["UI_CHANGED", "unknown"],
    ["AGENT_CONTEXT_CHANGED", "sent"],
    ["AGENT_CONTEXT_CHANGED", "unknown"],
    ["RESPONSE_EXTRACTION_FAILED", "sent"],
    ["AUTH_REQUIRED", "sent"],
    ["BROKER_UNAVAILABLE", "unknown"],
    ["BROWSER_CRASHED", "unknown"]
  ] as const)("still retires and closes a one-shot conversation after %s (%s)", async (code, state) => {
    const fixture = await harness();

    const error = await failedAsk(
      fixture,
      new DomainError(code, "fixture failure", false, state ? { submissionState: state } : {})
    );

    expect(error).toMatchObject({ code });
    expect(error.options.conversationHandle).toBeUndefined();
    expect(error.toResult("req-failed-ask").error).not.toHaveProperty("conversationHandle");
    expect(fixture.transport.closes).toBe(1);
    expect(fixture.conversations.activeCount()).toBe(0);
    expect(await fixture.service.list(fixture.workspaceRoot)).toEqual([]);
  });

  it.each(["SUBMIT_STATE_UNKNOWN", "RESPONSE_TIMEOUT"] as const)(
    "retires the conversation when the caller cancelled the ask (%s): nobody waits for its reply",
    async (code) => {
      const fixture = await harness();
      const controller = new AbortController();
      fixture.transport.invokeHook = async () => controller.abort();

      const error = await failedAsk(
        fixture,
        new DomainError(code, "cancelled", false, { submissionState: "unknown" }),
        { signal: controller.signal }
      );

      expect(error).toMatchObject({ code });
      expect(error.options.conversationHandle).toBeUndefined();
      expect(fixture.transport.closes).toBe(1);
      expect(fixture.conversations.activeCount()).toBe(0);
    }
  );

  it("does not offer a conversation that was invalidated while the ask ran", async () => {
    const fixture = await harness();
    fixture.transport.invokeHook = async () => fixture.conversations.failAll();

    const error = await failedAsk(fixture, mayHaveBeenSent());

    expect(error.options.conversationHandle).toBeUndefined();
    expect(fixture.transport.closes).toBe(1);
    expect(fixture.conversations.activeCount()).toBe(0);
  });

  it("never offers a handle for a failure that came before any conversation existed", async () => {
    const fixture = await harness();
    fixture.transport.createFailure = mayHaveBeenSent();

    const outcome = await fixture.service
      .invoke(fixture.workspaceRoot, agent.alias, "question", undefined, "req-create-failed")
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(outcome).toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
    expect((outcome as DomainError).options.conversationHandle).toBeUndefined();
    expect(fixture.transport.invokes).toBe(0);
    expect(fixture.conversations.activeCount()).toBe(0);
  });

  it("carries the handle of an explicit conversation too, and leaves it the caller's own", async () => {
    const fixture = await harness();
    const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);

    const error = await failedAsk(fixture, mayHaveBeenSent(), { handle: conversation.handle });

    expect(error.options.conversationHandle).toBe(conversation.handle);
    expect(error.options.remediation).toContain("m365_agent_session");
    expect(error.options.remediation).toContain("action=read");
    expect(error.options.remediation).toContain(conversation.handle);
    expect(fixture.transport.closes).toBe(0);
    const kept = fixture.conversations.get(conversation.handle);
    expect(kept.state).toBe("ready");
    // It was never a one-shot conversation, so reading its reply does not end it.
    expect(kept.closeAfterRead).toBeUndefined();
  });

  it("offers no handle for an explicit conversation when the caller cancelled or the failure is another kind", async () => {
    const fixture = await harness();
    const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    const controller = new AbortController();
    fixture.transport.invokeHook = async () => controller.abort();

    const cancelled = await failedAsk(fixture, mayHaveBeenSent(), {
      handle: conversation.handle,
      signal: controller.signal
    });
    fixture.transport.invokeHook = undefined;
    const other = await failedAsk(
      fixture,
      new DomainError("AGENT_CONTEXT_CHANGED", "The agent context changed.", false, {
        submissionState: "sent"
      }),
      { handle: conversation.handle }
    );

    expect(cancelled.options.conversationHandle).toBeUndefined();
    expect(other.options.conversationHandle).toBeUndefined();
    expect(fixture.conversations.get(conversation.handle).state).toBe("ready");
  });

  it("keeps the diagnostics of the original failure and records one incident for it", async () => {
    const incidents = new IncidentLog();
    const fixture = await harness({ incidents });
    const original = new DomainError("RESPONSE_TIMEOUT", "The response did not finish.", false, {
      submissionState: "sent"
    });
    const completion = { reason: "timeout", sawStreamingSignal: true, finalChars: 42 };
    attachDiagnostics(original, { completion });

    const error = await failedAsk(fixture, original);

    expect(error.options.conversationHandle).toBeDefined();
    expect(diagnosticsOf(error)).toEqual({ completion });
    expect(incidents.list()).toEqual([
      expect.objectContaining({ code: "RESPONSE_TIMEOUT", phase: "invoke", completion })
    ]);
  });

  // Independent review of the 2026-10-10 fixes: only a question that goes into the conversation makes
  // it the caller's own session; an ask refused before that leaves it to close after its read.
  it("keeps a kept conversation for its read when an ask continuing it is refused before its question goes in", async () => {
    const fixture = await harness();
    const handle = await keptConversation(fixture);
    const cancelled = new AbortController();
    cancelled.abort();

    await expect(
      fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "follow-up",
        handle,
        "req-refused",
        undefined,
        cancelled.signal
      )
    ).rejects.toMatchObject({ options: { submissionState: "not-sent" } });
    expect(fixture.transport.invokes).toBe(1);
    expect(fixture.conversations.get(handle).closeAfterRead).toBe(true);

    // The fake transport's reading is a complete reply by default.
    await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-read")).resolves.toMatchObject({
      reply: "complete",
      conversationClosed: true
    });
  });

  // A client of protocol minor 4 cannot read a conversation: it is offered none to read.
  it("does not keep a one-shot conversation, or name it, for a client that cannot read", async () => {
    const fixture = await harness();
    fixture.transport.failWith = mayHaveBeenSent();
    const error = await fixture.service
      .invoke(
        fixture.workspaceRoot,
        agent.alias,
        "question",
        undefined,
        "req-old-client",
        undefined,
        undefined,
        {
          readable: false
        }
      )
      .then(
        () => undefined,
        (caught: unknown) => caught as DomainError
      );
    fixture.transport.failWith = undefined;

    expect(error).toMatchObject({ code: "SUBMIT_STATE_UNKNOWN", options: { submissionState: "unknown" } });
    expect(error?.options.conversationHandle).toBeUndefined();
    expect(error?.options.remediation ?? "").not.toContain("action=read");
    // Retired as before minor 5: its page released, nothing left to read or count against the limits.
    expect(fixture.transport.closes).toBe(1);
    expect(await fixture.service.list(fixture.workspaceRoot)).toHaveLength(0);
  });

  it("treats a kept conversation the caller then continues by its handle as the caller's own session", async () => {
    const fixture = await harness();
    const handle = await keptConversation(fixture);
    expect(fixture.conversations.get(handle).closeAfterRead).toBe(true);

    const continued = await fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "follow-up",
      handle,
      "req-continue"
    );
    expect(continued).toMatchObject({ conversationHandle: handle, conversationClosed: false });
    const reading = await fixture.service.read(fixture.workspaceRoot, handle, "req-read-after-continue");

    // A read that now returns a complete reply no longer ends the conversation.
    expect(reading).toMatchObject({ reply: "complete" });
    expect(reading).not.toHaveProperty("conversationClosed");
    expect(fixture.transport.closes).toBe(0);
    expect(fixture.conversations.get(handle).state).toBe("ready");
  });
});

describe("InvocationService: expectFiles", () => {
  it.each([
    ["false", { expectFiles: false }, true],
    ["true", { expectFiles: true }, false],
    ["undefined", { expectFiles: undefined }, false],
    ["left out", {}, false]
  ])("hands expectFiles=%s to the transport only when it is false", async (_name, options, forwarded) => {
    const fixture = await harness();

    await fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "question",
      undefined,
      "req-expect-files",
      undefined,
      undefined,
      options
    );

    const request = fixture.transport.lastRequest!;
    expect(Object.hasOwn(request, "expectFiles")).toBe(forwarded);
    if (forwarded) expect(request.expectFiles).toBe(false);
  });

  it("hands nothing extra to the transport when no options are given at all", async () => {
    const fixture = await harness();
    await fixture.service.invoke(fixture.workspaceRoot, agent.alias, "question", undefined, "req-no-options");
    expect(Object.hasOwn(fixture.transport.lastRequest!, "expectFiles")).toBe(false);
  });

  it("applies to a continued conversation as well", async () => {
    const fixture = await harness();
    const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
    await fixture.service.invoke(
      fixture.workspaceRoot,
      agent.alias,
      "question",
      conversation.handle,
      "req-continued",
      undefined,
      undefined,
      { expectFiles: false }
    );
    expect(fixture.transport.lastRequest?.expectFiles).toBe(false);
  });
});

describe("InvocationService.read", () => {
  const completeReading = (overrides: Partial<ConversationReading> = {}): ConversationReading => ({
    message: "shown",
    reply: "complete",
    response: {
      text: "response-body-marker",
      citations: [{ index: 1, title: "Doc", url: "https://example.test/doc" }],
      attachments: [
        {
          index: 1,
          name: "report.pdf",
          mediaType: "application/pdf",
          sourceUrl: "https://tenant.sharepoint.com/report",
          status: "saved",
          localPath: "/tmp/agent-pick-link/report.pdf",
          sizeBytes: 100,
          sha256: "a".repeat(64)
        },
        {
          index: 2,
          name: "blocked.docx",
          mediaType: "application/octet-stream",
          sourceUrl: "https://elsewhere.example/blocked",
          status: "not-saved",
          errorCode: "host-not-allowed"
        }
      ],
      truncated: false,
      actionRequired: false
    },
    ...overrides
  });

  describe("a conversation kept open by a failed one-shot ask", () => {
    it.each(["shown", "differs"] as const)(
      "returns the complete reply (message %s), then closes and forgets the conversation",
      async (message) => {
        const fixture = await harness();
        const handle = await keptConversation(fixture);
        fixture.transport.reading = completeReading({ message });

        const result = await fixture.service.read(fixture.workspaceRoot, handle, "req-read");

        expect(result).toEqual({
          conversation: {
            handle,
            agentAlias: agent.alias,
            createdAt: expect.any(String),
            lastUsedAt: expect.any(String)
          },
          message,
          reply: "complete",
          text: "response-body-marker",
          citations: [{ index: 1, title: "Doc", url: "https://example.test/doc" }],
          attachments: fixture.transport.reading.response!.attachments,
          truncated: false,
          actionRequired: false,
          sourceType: "m365-agent",
          conversationClosed: true
        });
        // Nothing was sent: the one invoke is the ask that failed.
        expect(fixture.transport.invokes).toBe(1);
        expect(fixture.transport.reads).toBe(1);
        expect(fixture.transport.closes).toBe(1);
        expect(fixture.conversations.has(handle)).toBe(false);
        expect(() => fixture.conversations.get(handle)).toThrow(
          expect.objectContaining({ code: "CONVERSATION_EXPIRED" })
        );
        expect(await fixture.service.list(fixture.workspaceRoot)).toEqual([]);
        // The read is audited as metadata only.
        const events = await auditEvents(fixture.logs);
        expect(events.map((event) => event.event)).toEqual(["agent.invoke.failed", "agent.read.complete"]);
        expect(events[1]).toEqual({
          event: "agent.read.complete",
          requestId: "req-read",
          workspace: workspaceKey(fixture.workspaceRoot),
          agent: agent.alias,
          conversation: handle,
          durationMs: expect.any(Number),
          requestChars: 0,
          responseChars: "response-body-marker".length,
          citationCount: 1,
          attachmentCount: 1,
          attachmentBytes: 100,
          attachmentFailuresByStage: { "host-not-allowed": 1 },
          status: "success"
        });
        expect(JSON.stringify(events)).not.toContain("response-body-marker");
        await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-again")).rejects.toMatchObject({
          code: "CONVERSATION_EXPIRED"
        });
      }
    );

    it.each([
      [
        "an incomplete reply with what it showed so far",
        { message: "shown", reply: "incomplete", partialResponse: { text: "so far", citations: [] } }
      ],
      ["an incomplete reply that showed nothing", { message: "shown", reply: "incomplete" }],
      ["no reply started", { message: "shown", reply: "none" }],
      ["a message that is not shown", { message: "not-shown", reply: "none" }],
      ["a message that is not confirmed", { message: "unconfirmed", reply: "none" }],
      ["no message entered at all", { message: "none", reply: "none" }]
    ] as const)("keeps the conversation open when the read ends with %s", async (_name, reading) => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      fixture.transport.reading = reading;

      const result = await fixture.service.read(fixture.workspaceRoot, handle, "req-read");

      // Only what the read found, and the conversation is not closed.
      expect(result).toEqual({
        conversation: {
          handle,
          agentAlias: agent.alias,
          createdAt: expect.any(String),
          lastUsedAt: expect.any(String)
        },
        ...reading,
        conversationClosed: false
      });
      expect(fixture.transport.closes).toBe(0);
      expect(fixture.conversations.get(handle)).toMatchObject({ state: "ready", closeAfterRead: true });
      expect(await fixture.service.list(fixture.workspaceRoot)).toHaveLength(1);

      // The read can be repeated until the reply is complete; that read ends the conversation.
      fixture.transport.reading = completeReading();
      await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-read-2")).resolves.toMatchObject({
        reply: "complete",
        conversationClosed: true
      });
      expect(fixture.transport.closes).toBe(1);
      expect(fixture.conversations.has(handle)).toBe(false);
    });

    // Independent review of the 2026-10-10 fixes: a reply collected for a caller who stopped waiting
    // reached nobody, so the conversation must stay to be read again.
    it("stays open when the caller stopped waiting for the read that collected its reply", async () => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      const controller = new AbortController();
      fixture.transport.reading = completeReading();
      fixture.transport.readHook = async () => controller.abort();

      const reading = await fixture.service.read(
        fixture.workspaceRoot,
        handle,
        "req-read-cancelled",
        undefined,
        controller.signal
      );

      expect(reading).toMatchObject({ reply: "complete", conversationClosed: false });
      expect(fixture.transport.closes).toBe(0);
      expect(fixture.conversations.get(handle)).toMatchObject({ state: "ready", closeAfterRead: true });
      fixture.transport.readHook = undefined;
      await expect(
        fixture.service.read(fixture.workspaceRoot, handle, "req-read-again")
      ).resolves.toMatchObject({
        reply: "complete",
        conversationClosed: true
      });
      expect(fixture.transport.closes).toBe(1);
    });

    it("passes on which ask's message it judged", async () => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      fixture.transport.reading = { ...completeReading(), messageRequestId: "req-failed-ask" };

      await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-read")).resolves.toMatchObject({
        message: "shown",
        messageRequestId: "req-failed-ask"
      });
    });

    it("marks the conversation failed when closing its page fails, but still returns the reply", async () => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      fixture.transport.closeFailure = new DomainError("BROWSER_START_FAILED", "page close failed");
      fixture.transport.closeFailuresRemaining = 2;
      fixture.transport.reading = completeReading();

      const result = await fixture.service.read(fixture.workspaceRoot, handle, "req-read");

      expect(result).toMatchObject({
        reply: "complete",
        text: "response-body-marker",
        conversationClosed: false
      });
      // The close ran under the lock and once more in the sweep that follows; the record stays
      // indexed so that maintenance can retry the page, and the handle is no longer usable.
      expect(fixture.transport.closes).toBe(2);
      expect(fixture.conversations.has(handle)).toBe(true);
      expect(() => fixture.conversations.get(handle)).toThrow(
        expect.objectContaining({ code: "CONVERSATION_EXPIRED" })
      );
      expect(fixture.conversations.activeCount()).toBe(0);
      await fixture.service.cleanupExpiredPages();
      expect(fixture.transport.closes).toBe(3);
      expect(fixture.conversations.has(handle)).toBe(false);
      expect(fixture.transport.reads).toBe(1);
    });

    it("lets only one of two simultaneous reads collect the reply", async () => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      const gate = Promise.withResolvers<void>();
      fixture.transport.readHook = async (call) => {
        if (call === 1) await gate.promise;
      };

      const first = fixture.service.read(fixture.workspaceRoot, handle, "req-read-1");
      await vi.waitFor(() => expect(fixture.transport.reads).toBe(1));
      const second = fixture.service.read(fixture.workspaceRoot, handle, "req-read-2");
      await vi.waitFor(() => expect(fixture.queued(handle)).toBe(2));
      gate.resolve();

      await expect(first).resolves.toMatchObject({ reply: "complete", conversationClosed: true });
      await expect(second).rejects.toMatchObject({ code: "CONVERSATION_EXPIRED" });
      expect(fixture.transport.reads).toBe(1);
      await fixture.service.cleanupExpiredPages();
      expect(fixture.conversations.has(handle)).toBe(false);
    });
  });

  describe("a conversation the caller opened", () => {
    it("is read without being closed, and says nothing about closing", async () => {
      const fixture = await harness();
      const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
      fixture.transport.reading = completeReading();

      const result = await fixture.service.read(fixture.workspaceRoot, conversation.handle, "req-read");

      expect(result).toMatchObject({ reply: "complete", sourceType: "m365-agent" });
      expect(result).not.toHaveProperty("conversationClosed");
      expect(fixture.transport.closes).toBe(0);
      expect(fixture.conversations.get(conversation.handle).state).toBe("ready");
      expect(await fixture.service.list(fixture.workspaceRoot)).toHaveLength(1);
    });

    it("reports a conversation nothing has been entered in as message none, reply none", async () => {
      const fixture = await harness();
      const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
      fixture.transport.reading = { message: "none", reply: "none" };

      const result = await fixture.service.read(fixture.workspaceRoot, conversation.handle, "req-read");

      expect(result).toEqual({
        conversation: expect.objectContaining({ handle: conversation.handle }),
        message: "none",
        reply: "none"
      });
    });
  });

  it("never exposes the transport handle or any internal field of the conversation", async () => {
    const fixture = await harness();
    const handle = await keptConversation(fixture);
    fixture.transport.reading = completeReading();

    const result = await fixture.service.read(fixture.workspaceRoot, handle, "req-read");

    expect(Object.keys(result.conversation).sort()).toEqual([
      "agentAlias",
      "createdAt",
      "handle",
      "lastUsedAt"
    ]);
    const wire = JSON.stringify(result);
    for (const leak of [
      `page-${handle}`,
      "opaque",
      "transportId",
      "bindingFingerprint",
      "workspaceKey",
      "brokerInstanceId"
    ])
      expect(wire).not.toContain(leak);
  });

  it("gives the transport its own handle for the conversation, with the request id, progress sink and signal", async () => {
    const fixture = await harness();
    const handle = await keptConversation(fixture);
    const controller = new AbortController();
    const onProgress = vi.fn();

    await fixture.service.read(fixture.workspaceRoot, handle, "req-read", onProgress, controller.signal);

    expect(fixture.transport.lastReadConversation).toEqual({
      transportId: "browser",
      opaque: `page-${handle}`
    });
    expect(fixture.transport.lastReadRequest).toEqual({
      requestId: "req-read",
      onProgress,
      signal: controller.signal
    });
    expect(fixture.transport.lastReadRequest!.onProgress).toBe(onProgress);
    expect(fixture.transport.lastReadRequest!.signal).toBe(controller.signal);
  });

  describe("refuses a conversation it may not read", () => {
    it("refuses a handle of another workspace without touching the transport", async () => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      const other = await anotherWorkspace();

      await expect(fixture.service.read(other, handle, "req-read")).rejects.toMatchObject({
        code: "CONVERSATION_OWNERSHIP_MISMATCH"
      });

      expect(fixture.transport.reads).toBe(0);
      expect(fixture.conversations.get(handle).state).toBe("ready");
    });

    it("answers an unknown handle with CONVERSATION_NOT_FOUND", async () => {
      const fixture = await harness();
      await expect(
        fixture.service.read(fixture.workspaceRoot, "conv_never_issued", "req-read")
      ).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
      expect(fixture.transport.reads).toBe(0);
    });

    it.each([
      [
        "closed",
        async (fixture: Fixture, handle: string) => {
          await fixture.service.close(fixture.workspaceRoot, handle);
        }
      ],
      [
        "closed and swept",
        async (fixture: Fixture, handle: string) => {
          await fixture.service.close(fixture.workspaceRoot, handle);
          await fixture.service.cleanupExpiredPages();
        }
      ],
      [
        "invalidated by a browser crash",
        async (fixture: Fixture) => {
          fixture.conversations.failAll();
        }
      ]
    ])("answers a handle that was %s with CONVERSATION_EXPIRED", async (_name, end) => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      await end(fixture, handle);

      await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-read")).rejects.toMatchObject({
        code: "CONVERSATION_EXPIRED"
      });
      expect(fixture.transport.reads).toBe(0);
    });

    it.each([
      [
        "its approval is removed",
        async (fixture: Fixture) => {
          fixture.approvals.approvals = [];
        },
        "WORKSPACE_APPROVAL_REQUIRED"
      ],
      [
        "it is no longer assigned to the workspace",
        async (fixture: Fixture) => {
          await writeFile(
            path.join(fixture.workspaceRoot, ".m365-agents.json"),
            JSON.stringify(WorkspaceConfigSchema.parse({ version: 1, agents: [{ alias: "other" }] }))
          );
        },
        "AGENT_NOT_ASSIGNED"
      ],
      [
        "it is disabled",
        async (fixture: Fixture) => {
          fixture.registry.agents = [{ ...agent, enabled: false }];
        },
        "AGENT_DISABLED"
      ],
      [
        "its binding changes",
        async (fixture: Fixture) => {
          const changed: BrowserAgentDefinition = {
            ...agent,
            verification: { ...agent.verification, expectedStableAgentId: "agent-2" }
          };
          changed.verification.bindingFingerprint = deriveBindingFingerprint(changed);
          fixture.registry.agents = [changed];
          fixture.approvals.approvals[0]!.approvedBindings = [
            {
              alias: agent.alias,
              bindingFingerprint: changed.verification.bindingFingerprint,
              capabilityClass: "knowledge-only"
            }
          ];
        },
        "CONVERSATION_OWNERSHIP_MISMATCH"
      ]
    ])("refuses to read once %s, and audits the refusal", async (_name, revoke, code) => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      await revoke(fixture);

      await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-read")).rejects.toMatchObject({
        code
      });

      expect(fixture.transport.reads).toBe(0);
      expect(fixture.transport.closes).toBe(0);
      expect(await auditEvents(fixture.logs)).toEqual([
        expect.objectContaining({ event: "agent.invoke.failed" }),
        expect.objectContaining({
          event: "agent.read.failed",
          requestId: "req-read",
          conversation: handle,
          requestChars: 0,
          responseChars: 0,
          status: "failure",
          errorCode: code
        })
      ]);
    });

    it("reads again once the approval is restored: a refusal does not poison the conversation", async () => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      const approvals = fixture.approvals.approvals;
      fixture.approvals.approvals = [];
      await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-refused")).rejects.toMatchObject({
        code: "WORKSPACE_APPROVAL_REQUIRED"
      });

      fixture.approvals.approvals = approvals;

      await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-allowed")).resolves.toMatchObject(
        {
          reply: "complete"
        }
      );
    });

    it("refuses with AGENT_ENTRYPOINT_UNSUPPORTED when the transport cannot read a conversation", async () => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      fixture.transport.readConversation = undefined;

      await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-read")).rejects.toMatchObject({
        code: "AGENT_ENTRYPOINT_UNSUPPORTED"
      });

      expect(fixture.conversations.get(handle)).toMatchObject({ state: "ready", closeAfterRead: true });
      expect(await auditEvents(fixture.logs)).toContainEqual(
        expect.objectContaining({ event: "agent.read.failed", errorCode: "AGENT_ENTRYPOINT_UNSUPPORTED" })
      );
    });

    it("counts a read against the workspace's request rate, like an ask", async () => {
      const fixture = await harness({ maxPerMinute: 1 });
      const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
      await fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "question",
        conversation.handle,
        "req-ask"
      );

      await expect(
        fixture.service.read(fixture.workspaceRoot, conversation.handle, "req-read")
      ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });

      expect(fixture.transport.reads).toBe(0);
    });
  });

  describe("shares the conversation's lock with asks", () => {
    it("waits for an ask running on the same conversation instead of reading underneath it", async () => {
      const fixture = await harness();
      const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
      const gate = Promise.withResolvers<void>();
      const order: string[] = [];
      fixture.transport.invokeHook = async () => {
        order.push("ask started");
        await gate.promise;
        order.push("ask finished");
      };
      fixture.transport.readHook = async () => {
        order.push("read started");
      };

      const ask = fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "question",
        conversation.handle,
        "req-ask"
      );
      await vi.waitFor(() => expect(order).toEqual(["ask started"]));
      const read = fixture.service.read(fixture.workspaceRoot, conversation.handle, "req-read");
      await vi.waitFor(() => expect(fixture.queued(conversation.handle)).toBe(2));
      expect(fixture.transport.reads).toBe(0);
      gate.resolve();

      await expect(ask).resolves.toMatchObject({ text: "an answer" });
      await expect(read).resolves.toMatchObject({ reply: "complete" });
      expect(order).toEqual(["ask started", "ask finished", "read started"]);
    });

    it("holds off an ask on the same conversation while it reads", async () => {
      const fixture = await harness();
      const conversation = await fixture.service.create(fixture.workspaceRoot, agent.alias);
      const gate = Promise.withResolvers<void>();
      const order: string[] = [];
      fixture.transport.readHook = async () => {
        order.push("read started");
        await gate.promise;
        order.push("read finished");
      };
      fixture.transport.invokeHook = async () => {
        order.push("ask started");
      };

      const read = fixture.service.read(fixture.workspaceRoot, conversation.handle, "req-read");
      await vi.waitFor(() => expect(order).toEqual(["read started"]));
      const ask = fixture.service.invoke(
        fixture.workspaceRoot,
        agent.alias,
        "question",
        conversation.handle,
        "req-ask"
      );
      await vi.waitFor(() => expect(fixture.queued(conversation.handle)).toBe(2));
      expect(fixture.transport.invokes).toBe(0);
      gate.resolve();

      await expect(read).resolves.toMatchObject({ reply: "complete" });
      await expect(ask).resolves.toMatchObject({ text: "an answer" });
      expect(order).toEqual(["read started", "read finished", "ask started"]);
    });
  });

  describe("when reading fails", () => {
    it("audits agent.read.failed with the error code and leaves the conversation open to be read again", async () => {
      const incidents = new IncidentLog();
      const fixture = await harness({ incidents });
      const handle = await keptConversation(fixture);
      fixture.transport.readFailWith = new DomainError(
        "RESPONSE_EXTRACTION_FAILED",
        "The reply could not be extracted."
      );

      await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-read")).rejects.toMatchObject({
        code: "RESPONSE_EXTRACTION_FAILED"
      });

      const events = await auditEvents(fixture.logs);
      expect(events.at(-1)).toEqual({
        event: "agent.read.failed",
        requestId: "req-read",
        workspace: workspaceKey(fixture.workspaceRoot),
        agent: agent.alias,
        conversation: handle,
        durationMs: expect.any(Number),
        requestChars: 0,
        responseChars: 0,
        citationCount: 0,
        attachmentCount: 0,
        attachmentBytes: 0,
        status: "failure",
        errorCode: "RESPONSE_EXTRACTION_FAILED"
      });
      expect(incidents.list()).toEqual([
        expect.objectContaining({ code: "RESPONSE_EXTRACTION_FAILED", phase: "read" })
      ]);
      expect(fixture.transport.closes).toBe(0);
      expect(fixture.conversations.get(handle)).toMatchObject({ state: "ready", closeAfterRead: true });

      fixture.transport.readFailWith = undefined;
      await expect(fixture.service.read(fixture.workspaceRoot, handle, "req-read-2")).resolves.toMatchObject({
        reply: "complete",
        conversationClosed: true
      });
    });

    it("reports an error that is not a DomainError as INTERNAL_ERROR, without its message", async () => {
      const fixture = await harness();
      const handle = await keptConversation(fixture);
      fixture.transport.readFailWith = new TypeError("secret internal detail");

      const error = await fixture.service.read(fixture.workspaceRoot, handle, "req-read").then(
        () => undefined,
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: "INTERNAL_ERROR" });
      expect((error as DomainError).message).not.toContain("secret internal detail");
      expect(await auditEvents(fixture.logs)).toContainEqual(
        expect.objectContaining({ event: "agent.read.failed", errorCode: "INTERNAL_ERROR" })
      );
    });

    it("does not record a caller's own cancellation as an incident", async () => {
      const incidents = new IncidentLog();
      const fixture = await harness({ incidents });
      const handle = await keptConversation(fixture);
      const controller = new AbortController();
      fixture.transport.readHook = async () => controller.abort();
      fixture.transport.readFailWith = new DomainError("RESPONSE_TIMEOUT", "The request was cancelled.");

      await expect(
        fixture.service.read(fixture.workspaceRoot, handle, "req-read", undefined, controller.signal)
      ).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });

      expect(incidents.list()).toEqual([]);
    });
  });
});
