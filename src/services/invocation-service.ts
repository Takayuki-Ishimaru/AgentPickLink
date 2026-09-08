import type { Conversation } from "../domain/conversation.js";
import { DomainError } from "../domain/errors.js";
import type { ProgressEvent, ProgressSink } from "../domain/progress.js";
import type { AgentResponse } from "../domain/response.js";
import type { AuditLogger } from "../observability/audit.js";
import { writeFailureDiagnostic } from "../observability/diagnostics.js";
import type { IncidentBrowser, IncidentLog } from "../observability/incidents.js";
import { diagnosticsOf, isIncidentCode } from "../observability/incidents.js";
import type { ConversationService } from "./conversation-service.js";
import type { PolicyService } from "./policy-service.js";
import type { InvocationLimiter } from "./rate-limiter.js";
import type { InteractiveAgentTransport, ValidationResult } from "../transports/transport.js";
import type { TransportRouter } from "../transports/transport-router.js";

export type InvocationDependencies = {
  policy: PolicyService;
  conversations: ConversationService;
  limiter: InvocationLimiter;
  router: TransportRouter;
  /** Metadata-only audit sink. Omitted (or disabled by configuration) means no audit record. */
  audit?: AuditLogger;
  /** Directory failure diagnostics are written to; contents are metadata-only (see redact.ts). */
  diagnosticsPath: string;
  /** Metadata-only incident log (see src/observability/incidents.ts). Optional so tests and any
   * caller that does not care about incidents can omit it; when present, invoke() records
   * failures whose error code is one of INCIDENT_CODES. */
  incidents?: IncidentLog;
  /** Metadata-only description of the browser the "browser" transport launches, cached by
   * BrokerServer at startup (see src/broker/broker-server.ts). Folded into every incident this
   * service records, so a diagnostic never needs a separate health round trip. */
  browserDescription?: () => IncidentBrowser | undefined;
  /** Keep broker status in sync when recovery signs in without a separate browser.login RPC. */
  onSignedIn?: (transport: InteractiveAgentTransport) => void;
  clock?: () => number;
};

/**
 * §29.5. Owns the whole authenticated invocation path: policy authorization, broker-wide
 * concurrency plus per-workspace rate limiting, explicit conversation creation/ownership,
 * re-authorization at the last safe boundary inside the per-conversation lock, transport
 * selection and invocation, stable error mapping, and metadata-only audit/diagnostics. It also
 * owns the conversation lifecycle operations that must share the same per-conversation mutex
 * (list/close/close-all and expired-page cleanup). BrokerServer only parses and shapes IPC.
 */
export class InvocationService {
  private readonly now: () => number;
  private readonly signIns = new Map<
    InteractiveAgentTransport,
    {
      result: Promise<void>;
      subscribers: Set<ProgressSink>;
    }
  >();
  /** One cleanup attempt per handle at a time; concurrent maintenance callers share it. */
  private readonly cleanupFlights = new Map<string, Promise<void>>();
  constructor(private readonly deps: InvocationDependencies) {
    this.now = deps.clock ?? Date.now;
  }

  /** `workspace.list`: the policy-filtered public roster (no transport is touched). */
  roster(root: string): Promise<Record<string, unknown>> {
    return this.deps.policy.roster(root);
  }

  /** `agent.validate`: registry-level eligibility plus a transport-side identity check. */
  async validateAgent(
    alias: string,
    sendTestMessage?: boolean
  ): Promise<ValidationResult & { responseText?: string }> {
    const agent = await this.deps.policy.assertEligible(alias);
    const transport = this.deps.router.select(agent);
    return transport.testAgent ? transport.testAgent(agent, sendTestMessage) : transport.validateAgent(agent);
  }

  /** Creates a fresh, verified conversation for an authorized alias. */
  async create(root: string, alias: string, onProgress?: ProgressSink): Promise<Conversation> {
    try {
      return await this.createConversation(root, alias, onProgress);
    } catch (error) {
      throw this.recordIncident(error, "create");
    }
  }

  private async createConversation(
    root: string,
    alias: string,
    onProgress?: ProgressSink
  ): Promise<Conversation> {
    // Authorize before opening a window or joining another caller's sign-in. A fresh attempt
    // below authorizes again after the human wait, before allocating a new conversation.
    const { agent } = await this.deps.policy.authorize(root, alias);
    const transport = this.deps.router.select(agent);
    if (this.signIns.has(transport) || (transport.login && transport.isLoginPending?.())) {
      await this.signIn(transport, onProgress);
      return this.createConversationAttempt(root, alias);
    }
    try {
      return await this.createConversationAttempt(root, alias);
    } catch (error) {
      if (!(error instanceof DomainError) || !transport.login) throw error;
      const resetDuringSignIn =
        (this.signIns.has(transport) || transport.isLoginPending?.()) &&
        ["BROWSER_CRASHED", "CONCURRENT_REQUEST", "CONVERSATION_EXPIRED"].includes(error.code);
      if (error.code !== "AUTH_REQUIRED" && !resetDuringSignIn) throw error;
      await this.signIn(transport, onProgress);
      // Exactly one retry, and only for creation: no prompt has been filled or submitted.
      // The old handle was invalidated when the shared browser profile switched to visible.
      return this.createConversationAttempt(root, alias);
    }
  }

  private async signIn(transport: InteractiveAgentTransport, onProgress?: ProgressSink): Promise<void> {
    const waiting: ProgressEvent = {
      phase: "login-waiting",
      message:
        "Microsoft 365 sign-in is required. Complete sign-in in the AgentPickLink window; this request will resume automatically."
    };
    const emit = (sink: ProgressSink, event: ProgressEvent) => {
      try {
        sink(event);
      } catch {
        /* a disconnected caller must not interrupt sign-in */
      }
    };
    if (onProgress) emit(onProgress, waiting);
    let flight = this.signIns.get(transport);
    if (!flight) {
      const subscribers = new Set<ProgressSink>();
      const result = Promise.resolve().then(async () => {
        const authenticated = await transport.login!(300_000, (event) => {
          // Login's done event completes authentication, not the waiting agent request.
          const progress =
            event.phase === "done"
              ? {
                  ...event,
                  phase: "connecting" as const,
                  message: "Signed in; reconnecting to the requested agent"
                }
              : event;
          for (const sink of subscribers) emit(sink, progress);
        });
        if (!authenticated.authenticated || authenticated.state !== "authenticated")
          throw new DomainError("AUTH_FAILED", "Microsoft 365 sign-in did not complete.", false, {
            submissionState: "not-sent"
          });
        this.deps.onSignedIn?.(transport);
      });
      flight = { result, subscribers };
      this.signIns.set(transport, flight);
      const current = flight;
      const cleanup = () => {
        if (this.signIns.get(transport) === current) this.signIns.delete(transport);
        subscribers.clear();
      };
      void result.then(cleanup, cleanup);
    }
    if (onProgress) flight.subscribers.add(onProgress);
    try {
      await flight.result;
    } finally {
      if (onProgress) flight.subscribers.delete(onProgress);
    }
  }

  private async createConversationAttempt(root: string, alias: string): Promise<Conversation> {
    const { workspace, agent } = await this.deps.policy.authorize(root, alias);
    const conversation = this.deps.conversations.create({
      workspaceKey: workspace.workspaceKey,
      agentAlias: alias,
      bindingFingerprint: agent.verification.bindingFingerprint
    });
    try {
      await this.cleanupExpiredPages();
      conversation.transport = await this.deps.router.select(agent).createConversation(agent, {
        workspaceKey: workspace.workspaceKey,
        workspaceRoot: workspace.root,
        conversationHandle: conversation.handle
      });
      return this.deps.conversations.ready(conversation.handle);
    } catch (error) {
      conversation.state = "failed";
      throw error;
    }
  }

  async invoke(
    root: string,
    alias: string,
    message: string,
    handle: string | undefined,
    requestId: string,
    onProgress?: ProgressSink
  ) {
    const started = this.now();
    const { workspace, agent } = await this.deps.policy.authorize(root, alias);
    let conversation: Conversation | undefined;
    let phase = handle ? "invoke" : "create";
    let recordedFailure: DomainError | undefined;
    let freshConversationCloseFailed = false;
    let freshConversationHandle: string | undefined;
    try {
      conversation = handle
        ? this.deps.conversations.assertOwner(handle, {
            workspaceKey: workspace.workspaceKey,
            agentAlias: alias,
            bindingFingerprint: agent.verification.bindingFingerprint
          })
        : await this.createConversation(root, alias, onProgress);
      const activeConversation = conversation;
      if (!handle) freshConversationHandle = activeConversation.handle;
      phase = "invoke";
      const result = await this.deps.limiter.run(workspace.workspaceKey, () =>
        this.deps.conversations.runExclusive(activeConversation.handle, async () => {
          try {
            // A queued invocation may wait while the repository request, local
            // approval, or registry binding changes. Re-evaluate at the last safe
            // boundary before the browser transport is allowed to fill or submit.
            const current = await this.deps.policy.authorize(root, alias);
            this.deps.conversations.assertOwner(activeConversation.handle, {
              workspaceKey: current.workspace.workspaceKey,
              agentAlias: alias,
              bindingFingerprint: current.agent.verification.bindingFingerprint
            });
            const response = await this.deps.router
              .select(current.agent)
              .invoke(this.transportHandle(activeConversation), {
                message,
                requestId,
                onProgress
              });
            const attachments = response.attachments ?? [];
            await this.deps.audit
              ?.write({
                event: "agent.invoke.complete",
                requestId,
                workspace: workspace.workspaceKey,
                agent: alias,
                conversation: activeConversation.handle,
                durationMs: this.now() - started,
                requestChars: Array.from(message).length,
                responseChars: Array.from(response.text).length,
                citationCount: response.citations.length,
                attachmentCount: attachments.filter((item) => item.status === "saved").length,
                attachmentBytes: attachments.reduce(
                  (total, item) => total + (item.status === "saved" ? (item.sizeBytes ?? 0) : 0),
                  0
                ),
                attachmentFailuresByStage: attachmentFailuresByStage(attachments),
                status: "success"
              })
              .catch(() => undefined);
            if (!handle) {
              // A handle created implicitly for a one-shot ask is an implementation detail. Close
              // its page before releasing the conversation lock so another caller can never
              // observe it as a reusable session. Keep the already-sent response if cleanup fails:
              // turning that into an ask error would invite a duplicate submission on retry.
              try {
                await this.transportFor(activeConversation).closeConversation(
                  this.transportHandle(activeConversation)
                );
                this.deps.conversations.close(activeConversation.handle, workspace.workspaceKey);
              } catch {
                freshConversationCloseFailed = true;
                this.deps.conversations.fail(activeConversation.handle);
              }
            }
            return {
              ...response,
              attachments,
              conversationHandle: activeConversation.handle,
              agent: alias,
              elapsedMs: this.now() - started
            };
          } catch (error) {
            // Invalidate a crashed browser before releasing the conversation lock to a waiter.
            recordedFailure = this.recordIncident(error, "invoke");
            throw recordedFailure;
          }
        })
      );
      if (!freshConversationHandle) return { ...result, conversationClosed: false };
      if (freshConversationCloseFailed) {
        await this.cleanupExpiredPages();
        const cleanupPending = this.deps.conversations.has(freshConversationHandle);
        return {
          ...result,
          conversationClosed: !cleanupPending,
          ...(cleanupPending ? { conversationCleanupPending: true } : {})
        };
      }
      this.deps.conversations.forget(freshConversationHandle);
      return { ...result, conversationClosed: true };
    } catch (error) {
      const domain = recordedFailure ?? this.recordIncident(error, phase);
      // A fresh ask is ephemeral. If sending or the limiter fails before a handle can be returned
      // to the caller, retire the conversation and release its page; successful asks close their
      // page in the invocation lock above. Existing handles remain available for explicit
      // inspection or close by the caller. The browser transport also re-checks identity before
      // every future submission, so an AGENT_CONTEXT_CHANGED page cannot be reused to send blindly.
      if (!handle && conversation) {
        this.deps.conversations.fail(conversation.handle);
        await this.cleanupExpiredPages();
      }
      // Creation is part of an ask too: failures before a transport handle exists must be
      // recorded. Observability failures must never replace the original operational error.
      await this.deps.audit
        ?.write({
          event: "agent.invoke.failed",
          requestId,
          workspace: workspace.workspaceKey,
          agent: alias,
          conversation: conversation?.handle ?? handle ?? "",
          durationMs: this.now() - started,
          requestChars: Array.from(message).length,
          responseChars: 0,
          citationCount: 0,
          attachmentCount: 0,
          attachmentBytes: 0,
          status: "failure",
          errorCode: domain.code
        })
        .catch(() => undefined);
      const fingerprint = diagnosticsOf(domain)?.fingerprint;
      await writeFailureDiagnostic(this.deps.diagnosticsPath, {
        requestId,
        stateTransitions: [phase],
        errorCode: domain.code,
        ...(fingerprint ? { adapterId: fingerprint.adapterId, uiFingerprint: { ...fingerprint } } : {})
      }).catch(() => undefined);
      throw domain;
    }
  }

  private recordIncident(error: unknown, phase: string): DomainError {
    const domain =
      error instanceof DomainError ? error : new DomainError("INTERNAL_ERROR", "Agent invocation failed.");
    if (domain.code === "BROWSER_CRASHED") this.deps.conversations.failAll();
    if (isIncidentCode(domain.code)) {
      const browser = this.deps.browserDescription?.();
      this.deps.incidents?.record({
        code: domain.code,
        phase,
        message: domain.message.slice(0, 200),
        ...diagnosticsOf(domain),
        ...(browser ? { browser } : {})
      });
    }
    return domain;
  }

  /** Conversations of this workspace that current policy still allows the caller to see. */
  async list(root: string): Promise<Conversation[]> {
    const workspace = await this.deps.policy.loadWorkspace(root);
    const current = this.deps.conversations.list(workspace.workspaceKey);
    await this.cleanupExpiredPages();
    const visible: Conversation[] = [];
    for (const conversation of current) {
      try {
        await this.deps.policy.authorize(root, conversation.agentAlias);
        visible.push(conversation);
      } catch {
        /* revoked/changed conversations are inaccessible */
      }
    }
    return visible;
  }

  async close(root: string, handle: string): Promise<Conversation> {
    const workspace = await this.deps.policy.loadWorkspace(root);
    const conversation = this.deps.conversations.get(handle);
    if (conversation.workspaceKey !== workspace.workspaceKey)
      throw new DomainError(
        "CONVERSATION_OWNERSHIP_MISMATCH",
        "This conversation belongs to another workspace."
      );
    if (conversation.state === "busy")
      throw new DomainError(
        "CONCURRENT_REQUEST",
        "The conversation is currently processing a request.",
        true
      );
    // Route the actual transport close + expiry through the same per-conversation mutex that
    // conversation.invoke uses, so an invoke that is already running or queued ahead of this
    // close cannot race the transport's closeConversation call for the same page. The early
    // "busy" check above is only a point-in-time fast-fail; the mutex is what makes it safe.
    // runExclusive enforces the per-conversation queue limit (§22.7); if it is already full this
    // rejects with CONCURRENT_REQUEST, the same signal used above for an actively-busy
    // conversation, rather than letting a close silently jump the queue.
    return this.deps.conversations.runExclusive(handle, async () => {
      const current = this.deps.conversations.get(handle);
      if (current.workspaceKey !== workspace.workspaceKey)
        throw new DomainError(
          "CONVERSATION_OWNERSHIP_MISMATCH",
          "This conversation belongs to another workspace."
        );
      await this.transportFor(current).closeConversation(this.transportHandle(current));
      return this.deps.conversations.close(handle, workspace.workspaceKey);
    });
  }

  async closeAll(root: string): Promise<Conversation[]> {
    const workspace = await this.deps.policy.loadWorkspace(root);
    const conversations = this.deps.conversations.list(workspace.workspaceKey);
    if (conversations.some((item) => item.state === "busy"))
      throw new DomainError(
        "CONCURRENT_REQUEST",
        "One or more workspace conversations are currently processing requests.",
        true
      );
    // Close only this snapshot, under each handle's mutex. A final workspace-wide sweep would
    // invalidate conversations created while the transport closes were pending and lose the
    // successful records needed to report closedCount.
    const closed = await Promise.all(
      conversations.map((item) =>
        this.deps.conversations
          .runExclusive(item.handle, async () => {
            const current = this.deps.conversations.get(item.handle);
            try {
              await this.transportFor(current).closeConversation(this.transportHandle(current));
              return this.deps.conversations.close(item.handle, workspace.workspaceKey);
            } catch (error) {
              // Keep failed closes available to maintenance for another page cleanup attempt.
              this.deps.conversations.fail(item.handle);
              throw error;
            }
          })
          .catch(() => undefined)
      )
    );
    return closed.filter((item): item is Conversation => item !== undefined);
  }

  /** Sweeps idle/failed conversations and releases their pages without waiting for another request. */
  async cleanupExpiredPages(): Promise<void> {
    const expired = this.deps.conversations.expiredForCleanup();
    await Promise.all(expired.map((item) => this.cleanupExpiredConversation(item)));
  }

  private cleanupExpiredConversation(item: Conversation): Promise<void> {
    const existing = this.cleanupFlights.get(item.handle);
    if (existing) return existing;
    const flight = (async () => {
      // Failed creation may never have produced a transport handle.
      if (!item.transport) {
        this.deps.conversations.forget(item.handle);
        return;
      }
      try {
        await this.transportFor(item).closeConversation(item.transport);
        this.deps.conversations.forget(item.handle);
      } catch {
        // Keep the expired record indexed. BrowserManager and BrowserTransport retain failed
        // page ownership, so a later maintenance pass can retry instead of orphaning it.
      }
    })();
    this.cleanupFlights.set(item.handle, flight);
    void flight.finally(() => {
      if (this.cleanupFlights.get(item.handle) === flight) this.cleanupFlights.delete(item.handle);
    });
    return flight;
  }

  /** Resolves the transport that owns an already-created conversation, using the transportId
   * recorded on its opaque handle rather than re-resolving the conversation's agent -- so a
   * conversation can still be closed even if its agent has since been unassigned or revoked. */
  private transportFor(conversation: Conversation): InteractiveAgentTransport {
    const handle = this.transportHandle(conversation);
    const transport = this.deps.router.get(handle.transportId);
    if (!transport)
      throw new DomainError(
        "AGENT_ENTRYPOINT_UNSUPPORTED",
        `No transport is registered for "${handle.transportId}" conversations.`
      );
    return transport;
  }

  private transportHandle(conversation: Conversation): NonNullable<Conversation["transport"]> {
    if (!conversation.transport)
      throw new DomainError("INTERNAL_ERROR", "The conversation has no transport handle.");
    return conversation.transport;
  }
}

/** Counts not-saved attachments by acquisition stage (falling back to errorCode when no stage was
 * recorded), for the audit event's `attachmentFailuresByStage` field. Metadata only -- names,
 * source URLs, and every other attachment field are deliberately not read here. Returns
 * `undefined` (never an empty object) when nothing failed to save. */
function attachmentFailuresByStage(
  attachments: AgentResponse["attachments"]
): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const attachment of attachments) {
    if (attachment.status !== "not-saved") continue;
    const key = attachment.stage ?? attachment.errorCode ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.keys(counts).length ? counts : undefined;
}
