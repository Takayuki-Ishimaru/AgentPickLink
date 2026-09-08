import type { AppPaths } from "../config/paths.js";
import { loadApprovals } from "../config/approvals.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { loadRegistry } from "../config/registry.js";
import { asDomainError, DomainError } from "../domain/errors.js";
import type { ProgressSink } from "../domain/progress.js";
import { IpcServer } from "../ipc/server.js";
import {
  assertNever,
  BROKER_CAPABILITIES,
  BROKER_PROTOCOL,
  type BrokerDescriptor,
  type BrokerBuild
} from "../ipc/protocol.js";
import type { BrokerMethod } from "../ipc/schemas.js";
import { AuditLogger } from "../observability/audit.js";
import { cleanupAttachments } from "../observability/attachments-cleanup.js";
import { cleanupDiagnostics } from "../observability/diagnostics.js";
import {
  diagnosticsOf,
  IncidentLog,
  isIncidentCode,
  type Incident,
  type IncidentBrowser
} from "../observability/incidents.js";
import { ConversationService } from "../services/conversation-service.js";
import { HealthService } from "../services/health-service.js";
import { InvocationService } from "../services/invocation-service.js";
import { PolicyService } from "../services/policy-service.js";
import { InvocationLimiter } from "../services/rate-limiter.js";
import { WorkspaceService } from "../services/workspace-service.js";
import type { InteractiveAgentTransport } from "../transports/transport.js";
import type { TransportRouter } from "../transports/transport-router.js";
import { createBrokerInstanceId, createBrokerSecret } from "./broker-auth.js";
import { readDescriptor, removeDescriptorIfOwned, writeDescriptor } from "./broker-descriptor.js";

/** How often the broker re-runs the attachment retention/quota pass (see cleanupAttachments). */
const ATTACHMENT_CLEANUP_INTERVAL_MS = 6 * 60 * 60_000;

export type BrokerDependencies = {
  paths: AppPaths;
  pipeName: string;
  packageVersion: string;
  router: TransportRouter;
  /** The entry file this broker runs from and its mtime (see BrokerDescriptor.build). */
  build?: BrokerBuild;
};

/**
 * The IPC surface of the broker: it owns the socket, the descriptor, the idle timer, and the
 * lifetime of the services it composes in start(). Every method body below is parse -> call one
 * service -> shape the IPC result; policy, invocation, conversation lifecycle, and health checks
 * live in src/services (see InvocationService, PolicyService, HealthService).
 */
export class BrokerServer {
  readonly instanceId = createBrokerInstanceId();
  private conversations?: ConversationService;
  private policies?: PolicyService;
  private invocations?: InvocationService;
  private healthChecks?: HealthService;
  private server?: IpcServer;
  private descriptor?: BrokerDescriptor;
  private idleTimer?: ReturnType<typeof setInterval>;
  private attachmentsTimer?: ReturnType<typeof setInterval>;
  private unsubscribeCrash?: () => void;
  private lastActivity = Date.now();
  private idleShutdownMs = 30 * 60_000;
  private stopping = false;
  private activeOperations = 0;
  private readonly operationDrainWaiters = new Set<() => void>();
  private maintenance?: Promise<void>;
  /** All callers observe the same shutdown completion, including concurrent stop requests. */
  private stopPromise?: Promise<void>;
  /** Metadata-only incident log surfaced through `broker.health` (see src/observability/incidents.ts). */
  private readonly incidents = new IncidentLog();
  /** The most recently observed authentication state, updated by browser.login/browser.authState
   * results and by any browser or agent method failure whose code is AUTH_REQUIRED/AUTH_FAILED.
   * Absent until the first such observation. */
  private lastAuthState?: { state: string; checkedAt: string };
  /** Metadata-only description of the browser the "browser" transport launches (channel, headless,
   * viewport -- see IncidentBrowser), cached once at startup rather than re-asked on every
   * incident: it never changes for the life of a broker process. Folded into every incident this
   * broker records (see recordIncident below), so a diagnostic never needs a separate health
   * round trip to know what was running. Absent when no browser transport is registered. */
  private cachedBrowserDescription?: IncidentBrowser;

  constructor(private readonly deps: BrokerDependencies) {}

  /** Records one incident, folding in the cached browser description (see
   * `cachedBrowserDescription`) alongside whatever fingerprint/hosts/completion diagnostics
   * `diagnosticsOf` recovers for the causing error, if any. The single call site both
   * `dispatch()` and `InvocationService` (via the `incidents` dependency it shares) ultimately
   * feed through -- kept here so the two paths cannot drift on what "every incident" means. */
  private recordIncident(
    incident: Pick<Incident, "code" | "phase" | "adapterId" | "message">,
    cause?: unknown
  ): void {
    const diagnostics = diagnosticsOf(cause) ?? {};
    this.incidents.record({
      ...incident,
      ...diagnostics,
      ...(this.cachedBrowserDescription ? { browser: this.cachedBrowserDescription } : {})
    });
  }

  async start(): Promise<BrokerDescriptor> {
    const config = await loadGlobalConfig(this.deps.paths);
    this.conversations = new ConversationService(this.instanceId, config.conversations);
    this.policies = new PolicyService(new WorkspaceService(), {
      config: () => loadGlobalConfig(this.deps.paths),
      registry: () => loadRegistry(this.deps.paths),
      approvals: () => loadApprovals(this.deps.paths)
    });
    // Cached once, not re-asked per incident: the browser transport's channel/headless/viewport
    // never change for the life of this broker process (see cachedBrowserDescription's doc).
    this.cachedBrowserDescription = await this.deps.router
      .get("browser")
      ?.healthCheck()
      .then((health) => health.browser)
      .catch(() => undefined);
    this.invocations = new InvocationService({
      policy: this.policies,
      conversations: this.conversations,
      limiter: new InvocationLimiter(
        config.invocation.maxConcurrentTotal,
        config.invocation.maxPerMinutePerWorkspace
      ),
      router: this.deps.router,
      audit: new AuditLogger(this.deps.paths.logs, config.logging.audit),
      diagnosticsPath: this.deps.paths.diagnostics,
      incidents: this.incidents,
      browserDescription: () => this.cachedBrowserDescription,
      onSignedIn: (transport) => {
        if (transport === this.deps.router.get("browser")) this.setAuthState("authenticated");
      }
    });
    this.healthChecks = new HealthService({
      paths: this.deps.paths,
      router: this.deps.router,
      instanceId: this.instanceId
    });
    await cleanupDiagnostics(this.deps.paths.diagnostics, config.security.diagnosticRetentionHours);
    // Saved attachments outlive the conversation that produced them, so age and total size are
    // enforced here rather than at save time: once at startup, then every six hours. The result is
    // metadata (counts and bytes) the caller may use; nothing about a user's files is logged.
    const attachmentLimits = {
      retentionHours: config.security.attachmentRetentionHours,
      quotaBytes: config.security.attachmentQuotaBytes
    };
    await cleanupAttachments(this.deps.paths.attachments, attachmentLimits);
    this.attachmentsTimer = setInterval(
      () => void cleanupAttachments(this.deps.paths.attachments, attachmentLimits).catch(() => undefined),
      ATTACHMENT_CLEANUP_INTERVAL_MS
    );
    this.attachmentsTimer.unref();
    this.idleShutdownMs = config.browser.idleShutdownMinutes * 60_000;
    const secret = createBrokerSecret();
    this.descriptor = {
      pid: process.pid,
      pipeName: this.deps.pipeName,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: this.deps.packageVersion,
      instanceId: this.instanceId,
      authSecret: secret,
      createdAt: new Date().toISOString(),
      state: "running",
      ...(this.deps.build ? { build: this.deps.build } : {})
    };
    this.server = new IpcServer(
      this.deps.pipeName,
      secret,
      {
        packageVersion: this.deps.packageVersion,
        capabilities: [...BROKER_CAPABILITIES],
        instanceId: this.instanceId
      },
      (method, params, requestId, notify) => this.dispatch(method, params, requestId, notify)
    );
    this.unsubscribeCrash = this.deps.router.get("browser")?.onBrowserCrash?.((event) => {
      this.conversations?.failAll();
      // A deliberate reset for an interactive sign-in invalidates conversations by design; only a
      // real crash/disconnect is an incident worth surfacing.
      if (event?.reason === "reset") return;
      this.recordIncident({
        code: "BROWSER_CRASHED",
        phase: "browser-crash",
        message: "The automation browser process crashed or was disconnected."
      });
    });
    try {
      await this.server.listen();
      await writeDescriptor(this.deps.paths, this.descriptor);
    } catch (error) {
      this.unsubscribeCrash?.();
      if (this.attachmentsTimer) clearInterval(this.attachmentsTimer);
      await this.server.close().catch(() => undefined);
      this.server = undefined;
      throw error;
    }
    this.idleTimer = setInterval(() => void this.maintainResources(), Math.min(60_000, this.idleShutdownMs));
    this.idleTimer.unref();
    return this.descriptor;
  }

  private maintainResources(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.maintenance) return this.maintenance;
    this.maintenance = (async () => {
      await this.invocationService().cleanupExpiredPages();
      if (
        !this.stopping &&
        this.activeOperations === 0 &&
        this.conversationStore().activeCount() === 0 &&
        Date.now() - this.lastActivity >= this.idleShutdownMs
      )
        await this.stop();
    })()
      .catch(() => undefined)
      .finally(() => {
        this.maintenance = undefined;
      });
    return this.maintenance;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const attempt = this.finishStop();
    const shared = attempt.catch((error) => {
      // Keep the descriptor/listener ownership on a failed dispose, but allow a later shutdown
      // request or signal to retry after the browser has become closable.
      return this.markStopFailed()
        .finally(() => {
          if (this.stopPromise === shared) this.stopPromise = undefined;
        })
        .then(() => {
          throw error;
        });
    });
    this.stopPromise = shared;
    return shared;
  }

  private async finishStop(): Promise<void> {
    this.stopping = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.attachmentsTimer) clearInterval(this.attachmentsTimer);
    this.unsubscribeCrash?.();
    if (this.descriptor) {
      // Publish the stopping state before closing the listener. New clients then wait for the
      // descriptor to disappear instead of handshaking with an endpoint that is mid-shutdown.
      this.descriptor.state = "stopping";
      const current = await readDescriptor(this.deps.paths).catch(() => undefined);
      if (current?.instanceId === this.instanceId)
        await writeDescriptor(this.deps.paths, this.descriptor).catch(() => undefined);
    }

    // A login owns the dedicated profile through a headed context. Cancel that one operation so
    // shutdown cannot wait forever for a human sign-in, while ordinary page operations drain
    // naturally and keep their pages alive until their response is complete.
    await Promise.all(
      this.deps.router.registeredKinds().map(async (kind) => {
        const transport = this.deps.router.get(kind);
        if (!transport?.cancelLogin || !transport.isLoginPending?.()) return;
        await transport.cancelLogin().catch(() => undefined);
      })
    );
    await this.waitForOperationsToDrain();
    // `dispatch()` settles just before IpcServer writes the final response frame. Yield one
    // event-loop turn so an in-flight request can deliver that frame before its socket is closed.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.conversations?.invalidateAll();

    // Keep the descriptor and listener published until every browser context is gone. If a
    // transport refuses to close, the owner remains reachable for a retry and a successor cannot
    // launch into a profile that Chromium still owns.
    await this.deps.router.disposeAllChecked();
    await this.server?.close().catch(() => undefined);
    await removeDescriptorIfOwned(this.deps.paths, this.instanceId);
    this.server = undefined;
  }

  private async markStopFailed(): Promise<void> {
    if (!this.descriptor) return;
    this.descriptor.state = "stop-failed";
    const current = await readDescriptor(this.deps.paths).catch(() => undefined);
    if (current?.instanceId === this.instanceId)
      await writeDescriptor(this.deps.paths, this.descriptor).catch(() => undefined);
  }

  private waitForOperationsToDrain(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.operationDrainWaiters.add(resolve));
  }

  /**
   * P1-10: excludes `broker.health` (and `broker.shutdown`, which is itself never something worth
   * keeping the broker alive for) from counting as activity for the idle-shutdown clock in
   * `start()`. Without this, a status-only poller (the extension's `HealthPoller`, `doctor`, ...)
   * calling `broker.health` every 20-30s would keep the browser/profile resources alive forever,
   * defeating `browser.idleShutdownMinutes` entirely.
   */
  private static readonly ACTIVITY_EXEMPT_METHODS: ReadonlySet<BrokerMethod> = new Set([
    "broker.health",
    "broker.shutdown"
  ]);

  /** Exposed for tests only (see tests/integration/broker-frontend.test.ts): confirms a poll-only
   * method left the idle clock untouched. */
  lastActivityAt(): number {
    return this.lastActivity;
  }

  private async dispatch(
    method: BrokerMethod,
    params: Record<string, unknown>,
    requestId: string,
    notify: ProgressSink
  ): Promise<unknown> {
    const stopFailed = this.descriptor?.state === "stop-failed";
    if (this.stopping && method !== "broker.shutdown" && !(stopFailed && method === "broker.health"))
      throw new DomainError("BROKER_UNAVAILABLE", "The broker is shutting down.", true);
    const active = !BrokerServer.ACTIVITY_EXEMPT_METHODS.has(method);
    if (active) {
      this.activeOperations++;
      this.lastActivity = Date.now();
    }
    try {
      return await this.route(method, params, requestId, notify);
    } catch (error) {
      // browser.*/agent.* methods are the only ones that talk to the automation browser
      // directly (conversation.* goes through InvocationService, which records its own
      // incidents -- see src/services/invocation-service.ts); a failure here that carries an
      // incident-worthy code is recorded the same way, keyed by method name instead of "invoke".
      if (method.startsWith("browser.") || method.startsWith("agent.")) {
        const domain = asDomainError(error);
        if (isIncidentCode(domain.code))
          this.recordIncident(
            { code: domain.code, phase: method, message: domain.message.slice(0, 200) },
            domain
          );
        if (domain.code === "AUTH_REQUIRED") this.setAuthState("sign-in-required");
        else if (domain.code === "AUTH_FAILED")
          this.setAuthState(/denied/i.test(domain.message) ? "access-denied" : "sign-in-required");
      }
      throw error;
    } finally {
      if (active) {
        this.activeOperations--;
        this.lastActivity = Date.now();
        if (this.activeOperations === 0) {
          for (const resolve of this.operationDrainWaiters) resolve();
          this.operationDrainWaiters.clear();
        }
      }
    }
  }

  private async route(
    method: BrokerMethod,
    params: Record<string, unknown>,
    requestId: string,
    notify: ProgressSink
  ): Promise<unknown> {
    switch (method) {
      case "broker.health":
        return {
          ...(await this.healthService().broker()),
          ...(this.deps.build ? { build: this.deps.build } : {}),
          ...(this.lastAuthState ? { authState: this.lastAuthState } : {}),
          ...(this.descriptor?.state === "stop-failed" ? { stopping: true, stopFailed: true } : {}),
          incidents: this.incidents.list()
        };
      case "broker.shutdown": {
        const timer = setTimeout(() => {
          void this.stop().catch((error) => {
            this.recordIncident(
              {
                code: "BROKER_UNAVAILABLE",
                phase: "broker-shutdown",
                message: "The browser could not be closed. Retry the broker shutdown."
              },
              error
            );
          });
        }, 0);
        timer.unref();
        return { stopping: true };
      }
      case "browser.login": {
        const transport = this.browserTransport();
        if (!transport.login)
          throw new DomainError(
            "AGENT_ENTRYPOINT_UNSUPPORTED",
            "This transport does not support interactive login."
          );
        const result = await transport.login(params.timeoutMs as number | undefined, notify);
        this.setAuthState(result.state);
        return result;
      }
      case "browser.cancelLogin": {
        const transport = this.browserTransport();
        if (!transport.cancelLogin)
          throw new DomainError(
            "AGENT_ENTRYPOINT_UNSUPPORTED",
            "This transport cannot cancel an interactive sign-in."
          );
        return transport.cancelLogin();
      }
      case "browser.authState": {
        const transport = this.browserTransport();
        if (!transport.authenticationState)
          throw new DomainError(
            "AGENT_ENTRYPOINT_UNSUPPORTED",
            "This transport cannot inspect authentication state."
          );
        const result = await transport.authenticationState();
        this.setAuthState(result.state);
        return result;
      }
      case "browser.resetProfile": {
        const transport = this.browserTransport();
        if (!transport.resetProfile)
          throw new DomainError(
            "AGENT_ENTRYPOINT_UNSUPPORTED",
            "This transport cannot reset the dedicated profile."
          );
        this.conversationStore().invalidateAll();
        await transport.resetProfile();
        return { reset: true };
      }
      case "agent.capture": {
        const transport = this.browserTransport();
        if (!transport.captureAgent)
          throw new DomainError("AGENT_ENTRYPOINT_UNSUPPORTED", "This transport does not support capture.");
        return transport.captureAgent(params.timeoutMs as number | undefined);
      }
      case "agent.inspectUrl": {
        const transport = this.browserTransport();
        if (!transport.inspectAgentUrl)
          throw new DomainError(
            "AGENT_ENTRYPOINT_UNSUPPORTED",
            "This transport does not support direct URL registration."
          );
        return transport.inspectAgentUrl(params.url as string);
      }
      case "agent.discover": {
        const transport = this.browserTransport();
        if (!transport.discoverAgents)
          throw new DomainError(
            "AGENT_ENTRYPOINT_UNSUPPORTED",
            "This transport does not support agent discovery."
          );
        return transport.discoverAgents(
          params.timeoutMs as number | undefined,
          notify,
          params.operationId as string | undefined
        );
      }
      case "agent.cancelDiscovery": {
        const transport = this.browserTransport();
        return transport.cancelDiscovery?.(params.operationId as string) ?? { cancelled: false };
      }
      case "agent.validate":
        return this.invocationService().validateAgent(
          params.agent as string,
          params.sendTestMessage as boolean | undefined
        );
      case "workspace.list":
        return this.invocationService().roster(params.root as string);
      case "conversation.create":
        return this.invocationService().create(params.root as string, params.agent as string, notify);
      case "conversation.invoke":
        return this.invocationService().invoke(
          params.root as string,
          params.agent as string,
          params.message as string,
          params.conversationHandle as string | undefined,
          requestId,
          notify
        );
      case "conversation.list":
        return this.invocationService().list(params.root as string);
      case "conversation.close":
        return this.invocationService().close(params.root as string, params.conversationHandle as string);
      case "conversation.closeAllForWorkspace":
        return this.invocationService().closeAll(params.root as string);
      default:
        return assertNever(method);
    }
  }

  private setAuthState(state: string): void {
    this.lastAuthState = { state, checkedAt: new Date().toISOString() };
  }

  private conversationStore(): ConversationService {
    if (!this.conversations) throw new DomainError("BROKER_UNAVAILABLE", "The broker is not started.");
    return this.conversations;
  }
  private invocationService(): InvocationService {
    if (!this.invocations) throw new DomainError("BROKER_UNAVAILABLE", "The broker is not started.");
    return this.invocations;
  }
  private healthService(): HealthService {
    if (!this.healthChecks) throw new DomainError("BROKER_UNAVAILABLE", "The broker is not started.");
    return this.healthChecks;
  }

  /** The interactive browser-kind transport, used for admin operations (login, capture, ...)
   * that are not tied to a specific agent. Throws if no browser transport is registered. */
  private browserTransport(): InteractiveAgentTransport {
    const transport = this.deps.router.get("browser");
    if (!transport)
      throw new DomainError(
        "AGENT_ENTRYPOINT_UNSUPPORTED",
        "No interactive browser transport is registered."
      );
    return transport;
  }
}
