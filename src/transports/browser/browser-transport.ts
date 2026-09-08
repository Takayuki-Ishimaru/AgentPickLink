import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import type { AgentDefinition } from "../../domain/agent.js";
import { DomainError, ERROR_CODES, type ErrorCode } from "../../domain/errors.js";
import type { ProgressSink } from "../../domain/progress.js";
import type { AgentResponse } from "../../domain/response.js";
import { pathPattern } from "../../domain/text.js";
import { attachDiagnostics, isUiDriftCode, type IncidentDiagnostics } from "../../observability/incidents.js";
import type {
  AgentInvokeRequest,
  BrowserInvalidationEvent,
  CapturedAgent,
  DiscoveryResult,
  InteractiveAgentTransport,
  InvocationContext,
  TransportConversation,
  TransportDevMode,
  TransportHealth
} from "../transport.js";
import { AgentDiscovery } from "./agent-discovery.js";
import { AgentNavigator } from "./agent-navigator.js";
import { AttachmentSaver } from "./attachment-saver.js";
import { AuthDetector } from "./auth-detector.js";
import { BROWSER_ADAPTER_REGISTRY, GenericDiagnosticAdapter } from "./adapters/index.js";
import { BrowserManager } from "./browser-manager.js";
import { ConversationDriver } from "./conversation-driver.js";
import { NavigationPolicy } from "./navigation-policy.js";
import { SessionManager } from "./session-manager.js";
import { createBrowserLauncher } from "./session-preserving-launcher.js";
import {
  BrowserTransportError,
  type BrowserAgentDefinition,
  type BrowserContextLike,
  type BrowserPageConversation,
  type PageLike
} from "./types.js";
import type { ChatUiAdapter } from "./ui-adapter.js";

export interface BrowserTransportOptions {
  manager?: BrowserManager;
  navigationPolicy?: NavigationPolicy;
  adapters?: ChatUiAdapter[];
  profilePath?: string;
  /** Browser channel to launch; defaults to msedge. */
  channel?: "msedge" | "chrome" | "chromium";
  /** Hidden automation context (default true). The interactive sign-in window is always headed. */
  headless?: boolean;
  /** Development only: permit http:// to 127.0.0.1/localhost so the mock chat app can be driven. */
  allowInsecureLoopback?: boolean;
  appHosts?: string[];
  authHosts?: string[];
  neutralAppUrl?: string;
  startupTimeoutMs?: number;
  /** Maximum retained conversation and transient browser pages. Defaults to BrowserManager's 16. */
  maxPages?: number;
  navigationTimeoutMs?: number;
  /** How long the authentication probe waits for Microsoft 365's silent-auth bounce to land back
   * on an application host before reporting that sign-in is required. */
  authLandingTimeoutMs?: number;
  /** Whole-response budget, measured from the moment the prompt was submitted. */
  responseTimeoutMs?: number;
  /** Wait for the submitted prompt to appear as a user message. */
  ackTimeoutMs?: number;
  /** Wait for the agent's first response node after acknowledgement. */
  responseStartTimeoutMs?: number;
  /** Per-character delay used when typing into a rich-text composer. */
  typingDelayMs?: number;
  /** Grace period after completion before one cheap attachment re-scan. */
  attachmentSettleMs?: number;
  stabilityWindowMs?: number;
  pollIntervalMs?: number;
  /** Extra quiet time before an unchanged response counts as complete with no streaming signal. */
  quietStreamingGraceMs?: number;
  acceptDownloads?: boolean;
  /** Optional browser knobs, passed straight through to the persistent context. */
  userAgent?: string;
  args?: string[];
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  /** Development relaxations this broker was started with (see src/broker/process.ts). Reported
   * through healthCheck() so the panel/CLI can say the broker is not in its production shape. */
  devMode?: { insecureLoopback: boolean; devAppUrl: boolean };
  attachmentsPath?: string;
  downloadHosts?: string[];
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  allowedCapabilityClasses?: Array<"knowledge-only" | "actions-possible">;
}

type Active = {
  conversation: BrowserPageConversation;
  agent: BrowserAgentDefinition;
  adapter: ChatUiAdapter;
  page: PageLike;
  workspaceKey: string;
  workspaceRoot?: string;
};

type DiscoveryFlight = {
  result: Promise<DiscoveryResult>;
  subscribers: Set<ProgressSink>;
};

/** Broker-owned M365 transport. Its public methods expose domain values only. */
export class BrowserTransport implements InteractiveAgentTransport {
  readonly name = "browser";
  private readonly manager: BrowserManager;
  private readonly policy: NavigationPolicy;
  private readonly navigator: AgentNavigator;
  private readonly driver: ConversationDriver;
  private readonly sessions: SessionManager;
  private readonly discovery: AgentDiscovery;
  private readonly adapters: ChatUiAdapter[];
  private readonly appHosts: string[];
  private readonly authHosts: string[];
  private readonly neutralAppUrl?: string;
  private readonly navigationTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly allowedCapabilityClasses: Set<"knowledge-only" | "actions-possible">;
  private readonly devMode: TransportDevMode;
  private readonly active = new Map<string, Active>();
  /** Pending discovery is expensive (one page plus rail/store scans). Same-deadline callers share
   * that work, but completed results are never retained. */
  private readonly discoveryFlights = new Map<number, DiscoveryFlight>();
  private loginFlight?: {
    result: Promise<{ authenticated: boolean; state: string }>;
    subscribers: Set<ProgressSink>;
  };
  private readonly crashHandlers = new Set<(event: BrowserInvalidationEvent) => void>();
  /** authHosts minus appHosts: a host that serves the application itself must never be treated as
   * a sign-in host, or AuthDetector would report every page as interactive-auth. */
  private readonly signInHosts: string[];
  /** Set when the automation context was torn down while conversations existed, so the next
   * invocation on a stale handle reports BROWSER_CRASHED rather than CONVERSATION_NOT_FOUND. */
  private contextInvalidated = false;

  constructor(options: BrowserTransportOptions = {}) {
    this.appHosts = options.appHosts ?? [];
    this.authHosts = options.authHosts ?? [];
    const appHostSet = new Set(this.appHosts.map((host) => host.toLowerCase()));
    this.signInHosts = this.authHosts.filter((host) => !appHostSet.has(host.toLowerCase()));
    this.neutralAppUrl = options.neutralAppUrl;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 45_000;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 300_000;
    this.allowedCapabilityClasses = new Set(options.allowedCapabilityClasses ?? ["knowledge-only"]);
    this.devMode = {
      insecureLoopback: options.devMode?.insecureLoopback ?? options.allowInsecureLoopback ?? false,
      devAppUrl: options.devMode?.devAppUrl ?? !!options.neutralAppUrl
    };
    const invalidate = (reason: "crash" | "reset") => {
      if (this.active.size) this.contextInvalidated = true;
      this.active.clear();
      for (const handler of this.crashHandlers) handler({ reason });
    };
    this.manager =
      options.manager ??
      new BrowserManager({
        launcher: createBrowserLauncher(chromium),
        profilePath: options.profilePath,
        channel: options.channel,
        headless: options.headless,
        startupTimeoutMs: options.startupTimeoutMs,
        maxPages: options.maxPages,
        acceptDownloads: options.acceptDownloads,
        userAgent: options.userAgent,
        args: options.args,
        viewport: options.viewport,
        locale: options.locale,
        timezoneId: options.timezoneId
      });
    // A crash and a deliberate reset for an interactive sign-in both invalidate every page this
    // transport handed out, so open conversations must fail with BROWSER_CRASHED afterwards.
    this.manager.onContextInvalidated(invalidate);
    this.policy =
      options.navigationPolicy ??
      new NavigationPolicy({
        appHosts: this.appHosts,
        authHosts: this.authHosts,
        allowInsecureLoopback: options.allowInsecureLoopback
      });
    this.navigator = new AgentNavigator(this.policy, new AuthDetector({ signInHosts: this.signInHosts }));
    this.sessions = new SessionManager({
      manager: this.manager,
      policy: this.policy,
      navigator: this.navigator,
      appHosts: this.appHosts,
      authHosts: this.signInHosts,
      neutralAppUrl: this.neutralAppUrl,
      navigationTimeoutMs: this.navigationTimeoutMs,
      authLandingTimeoutMs: options.authLandingTimeoutMs
    });
    this.discovery = new AgentDiscovery({
      manager: this.manager,
      policy: this.policy,
      navigator: this.navigator,
      appHosts: this.appHosts,
      authHosts: this.signInHosts,
      neutralAppUrl: this.neutralAppUrl,
      navigationTimeoutMs: this.navigationTimeoutMs
    });
    this.driver = new ConversationDriver(
      this.navigator,
      new AttachmentSaver({
        enabled: options.acceptDownloads,
        directory: options.attachmentsPath,
        allowedHosts: options.downloadHosts,
        maxAttachments: options.maxAttachments,
        maxAttachmentBytes: options.maxAttachmentBytes,
        maxTotalAttachmentBytes: options.maxTotalAttachmentBytes,
        timeoutMs: options.navigationTimeoutMs
      }),
      {
        ackTimeoutMs: options.ackTimeoutMs,
        responseStartTimeoutMs: options.responseStartTimeoutMs,
        attachmentSettleMs: options.attachmentSettleMs
      }
    );
    this.adapters = options.adapters ?? [
      ...BROWSER_ADAPTER_REGISTRY.map((entry) =>
        entry.create({
          hostnames: this.appHosts,
          attachmentHosts: options.downloadHosts,
          stabilityWindowMs: options.stabilityWindowMs,
          pollIntervalMs: options.pollIntervalMs,
          quietStreamingGraceMs: options.quietStreamingGraceMs,
          typingDelayMs: options.typingDelayMs
        })
      ),
      new GenericDiagnosticAdapter()
    ];
  }

  isBrowserRunning(): boolean {
    return this.manager.isRunning();
  }
  onBrowserCrash(handler: (event: BrowserInvalidationEvent) => void): () => void {
    this.crashHandlers.add(handler);
    return () => this.crashHandlers.delete(handler);
  }

  /** Metadata only: what this transport launches, whether it is up, and which development
   * relaxations are in effect. No page content, no profile path, no hostnames. */
  async healthCheck(): Promise<TransportHealth> {
    const { channel, headless, viewport, running } = this.manager.describe();
    const configuration = [
      `channel=${channel}`,
      "executable=resolved by channel",
      `headless=${String(headless)}`,
      `sessionHandoff=${this.manager.keepsSignedInProcess() ? "same-process" : "browser-restart"}`,
      `viewport=${viewport.width}x${viewport.height}`
    ].join(", ");
    return {
      healthy: true,
      details: `${
        running
          ? "Hidden automation browser context running"
          : "The hidden automation browser context is stopped and will start lazily"
      } (${configuration})`,
      devMode: this.devMode,
      browser: { channel, headless, viewport }
    };
  }

  async validateAgent(
    agent: AgentDefinition
  ): Promise<{ valid: true } | { valid: false; reason: ErrorCode }> {
    if (agent.transport !== "browser") return { valid: false, reason: "AGENT_ENTRYPOINT_UNSUPPORTED" };
    const browserAgent = agent as BrowserAgentDefinition;
    if (!browserAgent.enabled) return { valid: false, reason: "AGENT_DISABLED" };
    if (browserAgent.verification.status !== "verified") return { valid: false, reason: "AGENT_UNVERIFIED" };
    if (
      browserAgent.capabilityClass === "unknown" ||
      !this.allowedCapabilityClasses.has(browserAgent.capabilityClass)
    )
      return { valid: false, reason: "AGENT_CAPABILITY_BLOCKED" };
    try {
      this.policy.validateAgentEntryPoint(browserAgent);
    } catch (error) {
      return { valid: false, reason: codeOf(error, "POLICY_BLOCKED") as ErrorCode };
    }
    const adapter = this.submittingAdapter(browserAgent.verification.adapterId);
    if (!adapter) return { valid: false, reason: "AGENT_ENTRYPOINT_UNSUPPORTED" };
    return { valid: true };
  }

  async createConversation(
    agent: AgentDefinition,
    context: InvocationContext
  ): Promise<TransportConversation> {
    // Captured as soon as they exist so a UI-drift failure anywhere below can be enriched with a
    // structural fingerprint (see attachFingerprint) before it is mapped to a DomainError.
    let diagnosticPage: PageLike | undefined;
    let diagnosticAdapter: ChatUiAdapter | undefined;
    try {
      const valid = await this.validateAgent(agent);
      if (!valid.valid)
        throw new BrowserTransportError(
          valid.reason ?? "AGENT_UNVERIFIED",
          "The agent is not eligible for browser invocation."
        );
      const browserAgent = agent as BrowserAgentDefinition;
      const adapter = this.submittingAdapter(browserAgent.verification.adapterId)!;
      diagnosticAdapter = adapter;
      const pageKey = `page_${context.workspaceKey}_${context.conversationHandle}`
        .replace(/[^A-Za-z0-9_.:-]/g, "_")
        .slice(0, 160);
      const pageHandle = await this.manager.createConversationPage(pageKey);
      diagnosticPage = pageHandle.page;
      const navigationDeadline = Date.now() + this.navigationTimeoutMs;
      let stopWatching: (() => void) | undefined;
      try {
        await this.navigator.open(pageHandle.page, browserAgent, adapter, {
          timeoutMs: this.navigationTimeoutMs
        });
        stopWatching = this.navigator.watch(pageHandle.page, "app");
        await this.assertIdentity(
          pageHandle.page,
          browserAgent,
          adapter,
          "AGENT_IDENTITY_UNVERIFIED",
          navigationDeadline
        );
        const before = await adapter.captureConversationMarker(pageHandle.page);
        const freshDirectAgentLanding =
          isDirectAgentLanding(pageHandle.page.url()) && before.id === undefined && before.userCount === 0;
        let freshness: { verified: boolean; reason?: string };
        if (freshDirectAgentLanding) {
          freshness = { verified: true };
        } else {
          await adapter.startNewConversation(pageHandle.page);
          freshness = await adapter.verifyNewConversation(pageHandle.page, before);
        }
        if (!freshness.verified)
          throw new BrowserTransportError(
            "NEW_CONVERSATION_UNVERIFIED",
            freshness.reason ?? "The new conversation state could not be verified."
          );
        this.navigator.assertNavigationSafe(pageHandle.page, "app");
        await this.assertIdentity(pageHandle.page, browserAgent, adapter, "AGENT_CONTEXT_CHANGED");
        await adapter.findComposer(pageHandle.page);
        const conversation: BrowserPageConversation = {
          handle: context.conversationHandle,
          agentAlias: browserAgent.alias,
          bindingFingerprint: browserAgent.verification.bindingFingerprint,
          pageKey,
          state: "ready"
        };
        const opaque = randomBytes(16).toString("hex");
        this.contextInvalidated = false;
        this.active.set(opaque, {
          conversation,
          agent: browserAgent,
          adapter,
          page: pageHandle.page,
          workspaceKey: context.workspaceKey,
          workspaceRoot: context.workspaceRoot
        });
        return { transportId: this.name, opaque };
      } catch (error) {
        // Capture the failing UI while the page is still alive; cleanup destroys its DOM.
        await this.attachFingerprint(error, pageHandle.page, adapter);
        await this.manager.closePage(pageKey).catch(() => undefined);
        throw error;
      } finally {
        stopWatching?.();
      }
    } catch (error) {
      await this.attachFingerprint(error, diagnosticPage, diagnosticAdapter);
      throw mapTransportError(error);
    }
  }

  async invoke(conversation: TransportConversation, request: AgentInvokeRequest): Promise<AgentResponse> {
    let diagnosticPage: PageLike | undefined;
    let diagnosticAdapter: ChatUiAdapter | undefined;
    try {
      const item = this.lookup(conversation);
      if (!item)
        throw new BrowserTransportError(
          this.manager.isRunning() && !this.contextInvalidated ? "CONVERSATION_NOT_FOUND" : "BROWSER_CRASHED",
          "The browser conversation is invalid or the browser context closed."
        );
      diagnosticPage = item.page;
      diagnosticAdapter = item.adapter;
      const response = await this.driver.invoke(item.page, item.conversation, item.agent, item.adapter, {
        message: request.message,
        requestId: request.requestId,
        signal: request.signal,
        onProgress: request.onProgress,
        workspaceKey: item.workspaceKey,
        workspaceRoot: item.workspaceRoot,
        timeoutMs: this.responseTimeoutMs
      });
      item.conversation.state = "ready";
      return response as AgentResponse;
    } catch (error) {
      await this.attachFingerprint(error, diagnosticPage, diagnosticAdapter);
      throw mapTransportError(error);
    }
  }

  /** Best-effort UI-drift diagnostic: when the escaping error carries a UI-structure code and a
   * page/adapter are available, captures the adapter's structural fingerprint (see UiFingerprint)
   * and attaches it to the error's details so InvocationService/BrokerServer can fold it into the
   * incident they record. A fingerprint an inner layer already attached is never overwritten, and
   * a failure to capture one (a closed page, an adapter without the optional method) is swallowed
   * -- this must never mask or replace the original failure. */
  private async attachFingerprint(
    error: unknown,
    page: PageLike | undefined,
    adapter: ChatUiAdapter | undefined
  ): Promise<void> {
    if (!page || !adapter?.captureUiFingerprint) return;
    if (!(error instanceof BrowserTransportError) || !isUiDriftCode(error.code)) return;
    if (error.details?.fingerprint) return;
    try {
      const fingerprint = await adapter.captureUiFingerprint(page);
      error.details = { ...error.details, fingerprint };
    } catch {
      /* best effort only */
    }
  }

  async closeConversation(conversation: TransportConversation): Promise<void> {
    const opaque = opaqueKey(conversation);
    if (opaque === undefined) return;
    const item = this.active.get(opaque);
    if (!item) return;
    await this.manager.closePage(item.conversation.pageKey);
    // Keep the opaque handle indexed until BrowserManager confirms the page close. A failed
    // close retains the page for a later retry; deleting it first would make maintenance believe
    // cleanup succeeded and permanently orphan the still-live browser page.
    this.active.delete(opaque);
  }

  /** Resolves a public TransportConversation handle back to this transport's own bookkeeping.
   * `conversation.opaque` never leaks outside this transport (see types.ts's
   * BrowserPageConversation doc comment): it is only ever a key into `this.active`, minted by
   * createConversation() and handed back unchanged by the broker. */
  private lookup(conversation: TransportConversation): Active | undefined {
    if (conversation.transportId !== this.name) return undefined;
    const opaque = opaqueKey(conversation);
    return opaque === undefined ? undefined : this.active.get(opaque);
  }

  isLoginPending(): boolean {
    return this.loginFlight !== undefined;
  }

  async login(
    timeoutMs = 300_000,
    onProgress?: ProgressSink
  ): Promise<{ authenticated: boolean; state: string }> {
    // The panel and an AI request can reach sign-in together. They share one visible window
    // and its verification; the first caller's deadline applies to everyone joining it.
    let flight = this.loginFlight;
    if (!flight) {
      const subscribers = new Set<ProgressSink>(onProgress ? [onProgress] : []);
      this.discovery.clearDescriptionCache();
      const result = this.sessions.interactiveLogin(timeoutMs, (event) => {
        for (const sink of subscribers) {
          try {
            sink(event);
          } catch {
            /* progress delivery is best-effort */
          }
        }
      });
      flight = { result, subscribers };
      this.loginFlight = flight;
      const current = flight;
      const cleanup = () => {
        if (this.loginFlight === current) this.loginFlight = undefined;
        subscribers.clear();
      };
      void result.then(cleanup, cleanup);
    }
    if (onProgress) flight.subscribers.add(onProgress);
    try {
      return await flight.result;
    } catch (error) {
      throw mapTransportError(error);
    } finally {
      if (onProgress) flight.subscribers.delete(onProgress);
    }
  }

  /** Cancels the sign-in currently running in the visible window, if any: the pending `login()`
   * rejects with AUTH_FAILED ("The sign-in was cancelled.") and the manager is left stopped, so the
   * next operation relaunches the hidden context. Cancelling when nothing is running is not an
   * error -- it simply reports `cancelled: false`. */
  async cancelLogin(): Promise<{ cancelled: boolean }> {
    const cancelled = this.manager.cancelInteractiveLogin();
    // The visible window is closing and the login promise is unwinding; wait for that so a
    // start() issued right after this call cannot race the profile lock.
    await this.manager.settleInteractiveLogin();
    if (cancelled) await this.loginFlight?.result.catch(() => undefined);
    return { cancelled };
  }

  async authenticationState(): Promise<{ state: string }> {
    try {
      if (!this.sessions.configured) return { state: "unknown" };
      const { state } = await this.sessions.probe();
      return { state };
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  /** Candidate list only: every candidate still goes through inspectAgentUrl before registration. */
  private readonly cancellableDiscoveries = new Map<string, AbortController>();

  async cancelDiscovery(operationId: string): Promise<{ cancelled: boolean }> {
    const controller = this.cancellableDiscoveries.get(operationId);
    controller?.abort();
    return { cancelled: !!controller };
  }

  async discoverAgents(
    timeoutMs = 60_000,
    onProgress?: ProgressSink,
    operationId?: string
  ): Promise<DiscoveryResult> {
    if (operationId) {
      if (this.cancellableDiscoveries.has(operationId))
        throw new DomainError("INVALID_ARGUMENT", "Duplicate discovery operation.");
      const controller = new AbortController();
      this.cancellableDiscoveries.set(operationId, controller);
      try {
        return await this.discovery.discover(timeoutMs, onProgress, controller.signal);
      } catch (error) {
        throw mapTransportError(error);
      } finally {
        this.cancellableDiscoveries.delete(operationId);
      }
    }
    const existing = this.discoveryFlights.get(timeoutMs);
    if (existing) return this.joinDiscovery(existing, onProgress);
    const subscribers = new Set<ProgressSink>();
    if (onProgress) subscribers.add(onProgress);
    const result = this.discovery.discover(timeoutMs, (event) => {
      // A disconnected MCP/panel caller must not interrupt the shared browser operation or the
      // progress stream for the callers that are still listening.
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(event);
        } catch {
          /* progress delivery is best-effort */
        }
      }
    });
    const flight: DiscoveryFlight = { result, subscribers };
    this.discoveryFlights.set(timeoutMs, flight);
    void result.then(
      () => this.clearDiscoveryFlight(timeoutMs, flight),
      () => this.clearDiscoveryFlight(timeoutMs, flight)
    );
    try {
      return await result;
    } catch (error) {
      throw mapTransportError(error);
    } finally {
      if (onProgress) subscribers.delete(onProgress);
    }
  }

  private async joinDiscovery(flight: DiscoveryFlight, onProgress?: ProgressSink): Promise<DiscoveryResult> {
    if (onProgress) flight.subscribers.add(onProgress);
    try {
      return await flight.result;
    } catch (error) {
      throw mapTransportError(error);
    } finally {
      if (onProgress) flight.subscribers.delete(onProgress);
    }
  }

  private clearDiscoveryFlight(timeoutMs: number, flight: DiscoveryFlight): void {
    if (this.discoveryFlights.get(timeoutMs) !== flight) return;
    this.discoveryFlights.delete(timeoutMs);
    flight.subscribers.clear();
  }

  /**
   * `agent add --capture`: the automation context is hidden, so capture runs in the same visible
   * window mechanics as an interactive sign-in and waits for the operator to open the agent chat.
   */
  async captureAgent(timeoutMs = 300_000): Promise<CapturedAgent> {
    try {
      const target = this.sessions.landingUrl();
      this.policy.validate(target, "app");
      return await this.manager.runInteractiveLogin(async (context: BrowserContextLike) => {
        const page = await captureWindowPage(context);
        await page.goto?.(target, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try {
            await this.navigator.awaitAppLanding(page, deadline);
            const candidate = await this.inspectPage(page);
            if (candidate) return candidate;
          } catch (error) {
            const code = codeOf(error, "INTERNAL_ERROR");
            if (code === "POLICY_BLOCKED" || code === "AUTH_REQUIRED" || code === "AUTH_FAILED") throw error;
          }
          await delay(500, page);
        }
        throw new BrowserTransportError(
          "AGENT_IDENTITY_UNVERIFIED",
          "No strongly identifiable supported agent chat was captured before the timeout."
        );
      });
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async inspectAgentUrl(url: string): Promise<CapturedAgent> {
    try {
      this.policy.validate(url, "app");
      const pageKey = `inspect_${randomBytes(8).toString("hex")}`;
      const page = (await this.manager.createConversationPage(pageKey)).page;
      try {
        const stopWatching = this.navigator.watch(page, "app-or-auth");
        try {
          await page.goto?.(url, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
        } finally {
          stopWatching();
        }
        this.navigator.assertNavigationSafe(page, "app-or-auth");
        const requested = new URL(url);
        const requestedAgentId = agentIdFromDirectUrl(requested);
        let resumedAfterAuthLanding = false;
        const deadline = Date.now() + this.navigationTimeoutMs;
        while (Date.now() < deadline) {
          await this.navigator.awaitAppLanding(page, deadline);
          const current = new URL(page.url());
          if (
            !resumedAfterAuthLanding &&
            current.hostname.toLowerCase() === requested.hostname.toLowerCase() &&
            current.pathname !== requested.pathname
          ) {
            let selected = false;
            const agentRow = requestedAgentId
              ? page.locator?.(`[data-agent-id="${requestedAgentId}"]`)
              : undefined;
            const count = (await agentRow?.count?.()) ?? 0;
            for (let index = 0; index < count; index++) {
              const candidate = count > 1 ? agentRow?.nth?.(index) : agentRow;
              if (!candidate || !((await candidate.isVisible?.()) ?? true)) continue;
              await candidate.click?.();
              selected = true;
              break;
            }
            if (selected) {
              resumedAfterAuthLanding = true;
              continue;
            }
          }
          const candidate = await this.inspectPage(page);
          if (candidate) return candidate;
          await delay(500, page);
        }
        throw new BrowserTransportError(
          "AGENT_IDENTITY_UNVERIFIED",
          "The URL did not expose a strongly identifiable supported direct agent chat."
        );
      } finally {
        await this.manager.closePage(pageKey).catch(() => undefined);
      }
    } catch (error) {
      throw mapTransportError(error);
    }
  }

  async testAgent(agent: AgentDefinition, sendTestMessage = false) {
    const handle = `conv_${randomBytes(16).toString("base64url")}`;
    const conversation = await this.createConversation(agent, {
      workspaceKey: "agent-test",
      conversationHandle: handle
    });
    try {
      if (!sendTestMessage) return { valid: true };
      const response = await this.invoke(conversation, { message: "あなたの役割を一文で説明してください" });
      return { valid: true, responseText: response.text };
    } finally {
      await this.closeConversation(conversation);
    }
  }

  async resetProfile(): Promise<void> {
    this.discovery.clearDescriptionCache();
    try {
      this.active.clear();
      await this.manager.resetProfile();
    } catch (error) {
      throw mapTransportError(error);
    }
  }
  /** Shutdown: closes the visible sign-in window too, so nothing is left holding the profile. */
  async dispose(): Promise<void> {
    for (const controller of this.cancellableDiscoveries.values()) controller.abort();
    this.discovery.clearDescriptionCache();
    this.active.clear();
    await this.manager.dispose();
  }

  private submittingAdapter(id: string): ChatUiAdapter | undefined {
    return this.adapters.find((item) => item.id === id && item.canSubmit);
  }

  private async assertIdentity(
    page: PageLike,
    agent: BrowserAgentDefinition,
    adapter: ChatUiAdapter,
    fallback: ErrorCode,
    initialRenderDeadline?: number
  ): Promise<void> {
    let result = await adapter.assertAgentIdentity(page, agent.verification);
    const expectedStableId = agent.verification.expectedStableAgentId;
    const settleDeadline = initialRenderDeadline ?? Date.now();
    const matchesExpectedSignal = () => {
      const observed = result.identity;
      const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();
      return (
        (!observed?.displayName ||
          normalize(observed.displayName) === normalize(agent.verification.expectedDisplayName)) &&
        (!observed?.stableAgentId || observed.stableAgentId === expectedStableId) &&
        (!observed?.surface || observed.surface === agent.verification.expectedSurface)
      );
    };
    while (
      !result.valid &&
      expectedStableId &&
      // Only the just-opened direct page gets a render wait, and only while its identity is
      // incomplete. A populated mismatching identity remains a fail-closed result immediately.
      (!result.identity?.displayName || !result.identity?.stableAgentId) &&
      matchesExpectedSignal() &&
      Date.now() < settleDeadline
    ) {
      this.navigator.assertNavigationSafe(page, "app");
      const delayMs = Math.min(250, Math.max(0, settleDeadline - Date.now()));
      if (page.waitForTimeout) await page.waitForTimeout(delayMs);
      else await new Promise((resolve) => setTimeout(resolve, delayMs));
      this.navigator.assertNavigationSafe(page, "app");
      result = await adapter.assertAgentIdentity(page, agent.verification);
    }
    if (!result.valid) {
      let pathname = "<invalid-url>";
      try {
        pathname = new URL(page.url()).pathname;
      } catch {
        // Keep the diagnostic useful without allowing a malformed URL to mask
        // the original identity failure.
      }
      const observed = result.identity;
      throw new BrowserTransportError(
        result.code ?? fallback,
        [
          "The expected Microsoft 365 agent identity was not active.",
          `Expected name=${JSON.stringify(agent.verification.expectedDisplayName)}, stableId=${JSON.stringify(agent.verification.expectedStableAgentId ?? "")};`,
          `observed name=${JSON.stringify(observed?.displayName ?? "")}, stableId=${JSON.stringify(observed?.stableAgentId ?? "")},`,
          `evidence=${JSON.stringify(observed?.evidence ?? [])}; path=${JSON.stringify(pathname)}.`
        ].join(" ")
      );
    }
  }

  private async inspectPage(page: PageLike): Promise<CapturedAgent | undefined> {
    for (const adapter of this.adapters.filter((item) => item.canSubmit)) {
      const match = await adapter.canHandle(page);
      if (!match.matched || match.confidence !== "strong") continue;
      const identity = await adapter.detectAgentIdentity(page);
      if (!identity?.displayName || !identity.surface || !identity.evidence.includes("visible-name"))
        continue;
      await adapter.findComposer(page);
      const url = new URL(page.url());
      const surface = adapter.id.startsWith("teams-") ? "teams-web" : "m365-copilot";
      if (identity.surface !== surface) continue;
      return {
        url: url.toString(),
        surface,
        adapterId: adapter.id,
        displayName: identity.displayName,
        stableAgentId: identity.stableAgentId,
        validatedUrlPattern: pathPattern(url.pathname)
      };
    }
    return undefined;
  }
}

// BrowserTransportError.code is already a compile-time-checked ErrorCode, so a
// BrowserTransportError never needs runtime code-validity guessing here. Only
// errors that originate outside DomainError/BrowserTransportError entirely
// (e.g. a raw Playwright launch failure) need the message-sniffing fallback.
function mapTransportError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof BrowserTransportError) {
    const retry = retryAdvice(error.code);
    const domainError = new DomainError(error.code, error.message, retry.retryable, {
      remediation: error.remediation,
      submissionState: error.details?.submissionState as "not-sent" | "sent" | "unknown" | undefined,
      partialResponse: error.details?.partialResponse as never,
      ...(retry.retryAfterMs === undefined ? {} : { retryAfterMs: retry.retryAfterMs })
    });
    attachDiagnosticsFromDetails(domainError, error.details);
    return domainError;
  }
  const message = error instanceof Error ? error.message : "Browser transport failed.";
  // NavigationPolicy raises plain Errors carrying a policy code; keep that code instead of
  // reporting a policy refusal as an internal error.
  const tagged = codeOf(error, "");
  if ((ERROR_CODES as readonly string[]).includes(tagged)) {
    const domainError = new DomainError(tagged as ErrorCode, message);
    attachDiagnosticsFromDetails(domainError, (error as { details?: unknown })?.details);
    return domainError;
  }
  let known: ErrorCode = "INTERNAL_ERROR";
  if (/profile.*(lock|in use)|processsingleton|user data directory.*use/i.test(message))
    known = "BROWSER_PROFILE_LOCKED";
  else if (/executable.*(not found|doesn.t exist)|browser.*not installed/i.test(message))
    known = "BROWSER_START_FAILED";
  return new DomainError(known, message);
}
/** Picks the metadata-only diagnostic keys (fingerprint/hosts/completion) out of a
 * BrowserTransportError's -- or a NavigationPolicy-raised, `.code`-tagged Error's -- `details`
 * bag and attaches them to the mapped DomainError via the WeakMap in incidents.ts, so
 * InvocationService/BrokerServer can fold them into an incident. Every other detail key
 * (submissionState, partialResponse, sendDiagnostics, ...) is handled elsewhere and is
 * deliberately not carried over here. */
function attachDiagnosticsFromDetails(domainError: DomainError, details: unknown): void {
  if (!details || typeof details !== "object") return;
  const source = details as Record<string, unknown>;
  const diagnostics: IncidentDiagnostics = {};
  if (source.fingerprint) diagnostics.fingerprint = source.fingerprint as IncidentDiagnostics["fingerprint"];
  if (source.hosts) diagnostics.hosts = source.hosts as string[];
  if (source.completion) diagnostics.completion = source.completion as IncidentDiagnostics["completion"];
  attachDiagnostics(domainError, diagnostics);
}
/** Which browser-layer failures the caller may simply try again, and when. A busy profile (an
 * interactive sign-in owns it) and a rate limit both clear on their own; a crashed context needs a
 * fresh conversation, which the caller creates on retry. Everything else fails closed. */
function retryAdvice(code: ErrorCode): { retryable: boolean; retryAfterMs?: number } {
  if (code === "CONCURRENT_REQUEST") return { retryable: true, retryAfterMs: 5_000 };
  if (code === "RATE_LIMITED") return { retryable: true, retryAfterMs: 60_000 };
  if (code === "BROWSER_CRASHED") return { retryable: true };
  return { retryable: false };
}

async function captureWindowPage(context: BrowserContextLike): Promise<PageLike> {
  const existing = context.pages().find((page) => page.isClosed?.() !== true);
  const page = existing ?? (context.newPage ? await context.newPage() : undefined);
  if (!page)
    throw new BrowserTransportError(
      "BROWSER_START_FAILED",
      "The interactive Microsoft 365 capture window could not be opened."
    );
  return page;
}
function codeOf(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : fallback;
}
function opaqueKey(conversation: TransportConversation): string | undefined {
  return typeof conversation.opaque === "string" ? conversation.opaque : undefined;
}
function isDirectAgentLanding(value: string): boolean {
  try {
    return /^\/chat\/agent\/[^/]+\/?$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}
function agentIdFromDirectUrl(value: URL): string | undefined {
  const match = /^\/chat\/agent\/([^/]+)\/?$/i.exec(value.pathname);
  if (!match?.[1]) return undefined;
  const decoded = decodeURIComponent(match[1]);
  return /^[A-Za-z0-9._-]+$/.test(decoded) ? decoded : undefined;
}
async function delay(ms: number, page: PageLike): Promise<void> {
  if (page.waitForTimeout) await page.waitForTimeout(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}
