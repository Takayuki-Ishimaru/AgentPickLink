import type { Conversation } from "../domain/conversation.js";
import { DomainError } from "../domain/errors.js";
import type { ProgressEvent, ProgressSink } from "../domain/progress.js";
import type { AgentResponse, ConversationReading } from "../domain/response.js";
import type { AuditLogger } from "../observability/audit.js";
import { writeFailureDiagnostic } from "../observability/diagnostics.js";
import type { IncidentBrowser, IncidentLog } from "../observability/incidents.js";
import { attachDiagnostics, diagnosticsOf, isIncidentCode } from "../observability/incidents.js";
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
    onProgress?: ProgressSink,
    /** Aborted when the caller cancels (`broker.cancel`); the transport winds down at its next
     * safe point, and the outcome is not recorded as an incident. */
    signal?: AbortSignal,
    /** `expectFiles: false`: a text-only question, so the transport does not wait for files that
     * can appear after the answer. `readable: false`: the client cannot read a conversation
     * (protocol minor below 5), so a failed ask is not left open to be read. */
    options: { expectFiles?: boolean; readable?: boolean } = {}
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
            // A caller that gave up while this request was queued never has its message sent.
            if (signal?.aborted)
              throw new DomainError("SUBMIT_FAILED", "The request was cancelled before it was sent.", false, {
                submissionState: "not-sent"
              });
            // A queued invocation may wait while the repository request, local
            // approval, or registry binding changes. Re-evaluate at the last safe
            // boundary before the browser transport is allowed to fill or submit.
            const current = await this.deps.policy.authorize(root, alias);
            this.deps.conversations.assertOwner(activeConversation.handle, {
              workspaceKey: current.workspace.workspaceKey,
              agentAlias: alias,
              bindingFingerprint: current.agent.verification.bindingFingerprint
            });
            // A caller that continues a conversation a failed one-shot ask kept open makes it its own
            // session from here, as its question goes in: it no longer closes after a read.
            if (handle) activeConversation.closeAfterRead = undefined;
            const response = await this.deps.router
              .select(current.agent)
              .invoke(this.transportHandle(activeConversation), {
                message,
                requestId,
                onProgress,
                signal,
                ...(options.expectFiles === false ? { expectFiles: false } : {})
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
            recordedFailure = this.recordIncident(error, "invoke", signal);
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
      const domain = recordedFailure ?? this.recordIncident(error, phase, signal);
      // A message that was or may have been sent leaves its conversation open to be read
      // (m365_agent_session action=read) instead of being sent again: the caller learns whether it
      // arrived and collects the reply there. Not after the caller's own cancellation, which nobody
      // waits on any more.
      const readable =
        conversation !== undefined &&
        options.readable !== false &&
        signal?.aborted !== true &&
        this.readableAfter(domain, conversation)
          ? conversation
          : undefined;
      // A fresh ask is ephemeral. If sending or the limiter fails before a handle can be returned
      // to the caller, retire the conversation and release its page; successful asks close their
      // page in the invocation lock above. One kept open to be read closes once a read collects its
      // reply, or when it expires. Existing handles remain available for read or close by the
      // caller. The browser transport also re-checks identity before every future submission or
      // read, so an AGENT_CONTEXT_CHANGED page cannot be reused to send blindly.
      if (!handle && conversation && !readable) {
        this.deps.conversations.fail(conversation.handle);
        await this.cleanupExpiredPages();
      }
      if (!handle && readable) readable.closeAfterRead = true;
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
      throw readable ? readableFailure(domain, readable.handle) : domain;
    }
  }

  /** Whether a failed ask's conversation is worth reading instead of sending the message again: its
   * message was or may have been sent (SUBMIT_STATE_UNKNOWN), or was sent and its reply did not
   * finish in time (RESPONSE_TIMEOUT), and the conversation is still open and usable. */
  private readableAfter(domain: DomainError, conversation: Conversation): boolean {
    const state = domain.options.submissionState;
    if (state !== "unknown" && state !== "sent") return false;
    if (domain.code !== "SUBMIT_STATE_UNKNOWN" && domain.code !== "RESPONSE_TIMEOUT") return false;
    return (
      this.deps.conversations.has(conversation.handle) &&
      conversation.state === "ready" &&
      conversation.transport !== undefined
    );
  }

  /**
   * `conversation.read` (m365_agent_session action=read): reads a conversation of this workspace
   * without sending anything -- whether the last message entered in it is shown there, and the
   * reply to the latest user message, waiting for it to finish. Same boundaries as an ask: the
   * conversation must belong to the workspace, its agent must still be approved with the binding the
   * conversation was opened with, and the read runs in the conversation's own lock and the
   * workspace's limiter. A conversation a failed one-shot ask kept open closes once a read returns
   * its complete reply.
   */
  async read(
    root: string,
    handle: string,
    requestId: string,
    onProgress?: ProgressSink,
    signal?: AbortSignal
  ) {
    const started = this.now();
    const workspace = await this.deps.policy.loadWorkspace(root);
    const known = this.deps.conversations.get(handle);
    if (known.workspaceKey !== workspace.workspaceKey)
      throw new DomainError(
        "CONVERSATION_OWNERSHIP_MISMATCH",
        "This conversation belongs to another workspace."
      );
    const alias = known.agentAlias;
    try {
      const { result, closing } = await this.deps.limiter.run(workspace.workspaceKey, () =>
        this.deps.conversations.runExclusive(handle, async () => {
          const authorized = await this.deps.policy.authorize(root, alias);
          const current = this.deps.conversations.assertOwner(handle, {
            workspaceKey: authorized.workspace.workspaceKey,
            agentAlias: alias,
            bindingFingerprint: authorized.agent.verification.bindingFingerprint
          });
          const transport = this.transportFor(current);
          if (!transport.readConversation)
            throw new DomainError(
              "AGENT_ENTRYPOINT_UNSUPPORTED",
              "This agent's transport cannot read a conversation."
            );
          const reading = await transport.readConversation(this.transportHandle(current), {
            requestId,
            onProgress,
            signal
          });
          const response = reading.response;
          const attachments = response?.attachments ?? [];
          await this.deps.audit
            ?.write({
              event: "agent.read.complete",
              requestId,
              workspace: workspace.workspaceKey,
              agent: alias,
              conversation: handle,
              durationMs: this.now() - started,
              requestChars: 0,
              responseChars: response ? Array.from(response.text).length : 0,
              citationCount: response?.citations.length ?? 0,
              attachmentCount: attachments.filter((item) => item.status === "saved").length,
              attachmentBytes: attachments.reduce(
                (total, item) => total + (item.status === "saved" ? (item.sizeBytes ?? 0) : 0),
                0
              ),
              attachmentFailuresByStage: attachmentFailuresByStage(attachments),
              status: "success"
            })
            .catch(() => undefined);
          // The one question a kept-open one-shot conversation was for has its answer now: release
          // its page inside the lock, as a successful one-shot ask does.
          let closing: "closed" | "failed" | undefined;
          // Not when the caller stopped waiting: the reply would reach nobody, so the conversation
          // stays to be read again until it expires.
          if (current.closeAfterRead && reading.reply === "complete" && signal?.aborted !== true) {
            try {
              await transport.closeConversation(this.transportHandle(current));
              this.deps.conversations.close(handle, workspace.workspaceKey);
              closing = "closed";
            } catch {
              this.deps.conversations.fail(handle);
              closing = "failed";
            }
          }
          const result: ReadResult = {
            conversation: {
              handle: current.handle,
              agentAlias: current.agentAlias,
              createdAt: current.createdAt,
              lastUsedAt: current.lastUsedAt
            },
            message: reading.message,
            ...(reading.messageRequestId === undefined ? {} : { messageRequestId: reading.messageRequestId }),
            reply: reading.reply,
            ...(response
              ? {
                  text: response.text,
                  citations: response.citations,
                  attachments,
                  truncated: response.truncated,
                  actionRequired: response.actionRequired,
                  sourceType: "m365-agent" as const
                }
              : {}),
            ...(reading.partialResponse ? { partialResponse: reading.partialResponse } : {}),
            ...(current.closeAfterRead ? { conversationClosed: closing === "closed" } : {})
          };
          return { result, closing };
        })
      );
      if (closing === "closed") this.deps.conversations.forget(handle);
      else if (closing === "failed") await this.cleanupExpiredPages();
      return result;
    } catch (error) {
      const domain = this.recordIncident(error, "read", signal);
      await this.deps.audit
        ?.write({
          event: "agent.read.failed",
          requestId,
          workspace: workspace.workspaceKey,
          agent: alias,
          conversation: handle,
          durationMs: this.now() - started,
          requestChars: 0,
          responseChars: 0,
          citationCount: 0,
          attachmentCount: 0,
          attachmentBytes: 0,
          status: "failure",
          errorCode: domain.code
        })
        .catch(() => undefined);
      throw domain;
    }
  }

  private recordIncident(error: unknown, phase: string, signal?: AbortSignal): DomainError {
    const domain =
      error instanceof DomainError ? error : new DomainError("INTERNAL_ERROR", "Agent invocation failed.");
    if (domain.code === "BROWSER_CRASHED") this.deps.conversations.failAll();
    // A caller's own cancellation ends the transport's wait with RESPONSE_TIMEOUT; that is not an
    // incident. Any other incident-worthy failure is recorded even if the caller also cancelled.
    const cancelledByCaller = signal?.aborted === true && domain.code === "RESPONSE_TIMEOUT";
    if (isIncidentCode(domain.code) && !cancelledByCaller) {
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

/** `conversation.read`'s result: what reading found, with a complete reply in the shape of an ask
 * result, and the conversation's public fields only (never its transport handle). */
export type ReadResult = Omit<ConversationReading, "response"> &
  Partial<NonNullable<ConversationReading["response"]>> & {
    conversation: Pick<Conversation, "handle" | "agentAlias" | "createdAt" | "lastUsedAt">;
    sourceType?: "m365-agent";
    conversationClosed?: boolean;
  };

/** The failure of an ask whose conversation stays open to be read: the same error, carrying the
 * handle and saying how to read it instead of sending the message again. */
function readableFailure(domain: DomainError, handle: string): DomainError {
  const read = `call m365_agent_session with action=read and conversationHandle=${handle}`;
  const remediation =
    domain.code === "RESPONSE_TIMEOUT"
      ? `The prompt was not resubmitted. To collect the reply once it finishes, ${read}; it sends nothing.`
      : `The message was not sent again. To learn whether it arrived and to collect the reply, ${read}; it sends nothing. Send the message again only if read reports message=not-shown.`;
  const readable = new DomainError(domain.code, domain.message, domain.retryable, {
    ...domain.options,
    remediation,
    conversationHandle: handle
  });
  attachDiagnostics(readable, diagnosticsOf(domain) ?? {});
  return readable;
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
