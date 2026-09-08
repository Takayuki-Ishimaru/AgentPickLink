import type { ProgressPhase, ProgressSink } from "../../domain/progress.js";
import { AgentNavigator } from "./agent-navigator.js";
import { AttachmentSaver } from "./attachment-saver.js";
import { RESPONSE_SELECTORS } from "./selectors/common.js";
import { directAgentIdFromUrl, matchesValidatedAgentPath } from "./identity.js";
import { SubmissionTracker } from "./submission-tracker.js";
import {
  BrowserTransportError,
  type BrowserAgentDefinition,
  type AgentResponse,
  type BrowserInvokeRequest,
  type BrowserPageConversation,
  type AttachmentCandidate,
  type PageLike
} from "./types.js";
import type { ChatUiAdapter } from "./ui-adapter.js";

export interface ConversationDriverOptions {
  /** Spacing of `streaming` progress events while a response grows. */
  streamingProgressIntervalMs?: number;
  /** How long to wait for the submitted prompt to appear as a user message. */
  ackTimeoutMs?: number;
  /** How long to wait for the agent's first response node after acknowledgement. */
  responseStartTimeoutMs?: number;
  /** Quiet window for the attachment candidate set; zero disables settling. */
  attachmentSettleMs?: number;
  /** Hard cap on attachment observation after text completion. */
  attachmentMaxWaitMs?: number;
  attachmentPollIntervalMs?: number;
}

export class ConversationDriver {
  private readonly streamingProgressIntervalMs: number;
  private readonly ackTimeoutMs: number;
  private readonly responseStartTimeoutMs: number;
  private readonly attachmentSettleMs: number;
  private readonly attachmentMaxWaitMs: number;
  private readonly attachmentPollIntervalMs: number;
  constructor(
    private readonly navigator: AgentNavigator,
    private readonly attachmentSaver = new AttachmentSaver(),
    options: ConversationDriverOptions = {}
  ) {
    this.streamingProgressIntervalMs = options.streamingProgressIntervalMs ?? 2_000;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 30_000;
    this.responseStartTimeoutMs = options.responseStartTimeoutMs ?? 90_000;
    this.attachmentSettleMs = options.attachmentSettleMs ?? 2_000;
    this.attachmentMaxWaitMs = options.attachmentMaxWaitMs ?? 6_000;
    this.attachmentPollIntervalMs = Math.max(1, options.attachmentPollIntervalMs ?? 250);
  }
  async invoke(
    page: PageLike,
    conversation: BrowserPageConversation,
    agent: BrowserAgentDefinition,
    adapter: ChatUiAdapter,
    request: BrowserInvokeRequest
  ): Promise<AgentResponse> {
    const tracker = new SubmissionTracker();
    const started = Date.now();
    // The response budget starts when the prompt is actually submitted: identity assertion and
    // filling a slow rich-text composer must not eat into the agent's time to answer.
    const timeout = request.timeoutMs ?? 300_000;
    let deadline = started + timeout;
    const remaining = () => Math.max(1, deadline - Date.now());
    // Metadata only: a phase, the elapsed time and a character count. Never message text.
    const report = (phase: ProgressPhase, message?: string) =>
      request.onProgress?.({ phase, message, elapsedMs: Date.now() - started });
    const identity = async (
      fallback: "AGENT_IDENTITY_UNVERIFIED" | "AGENT_IDENTITY_MISMATCH" | "AGENT_CONTEXT_CHANGED",
      forceFallback = false,
      waitForNameMs = 0
    ) => {
      let result = await adapter.assertAgentIdentity(page, agent.verification);
      const nameDeadline = Math.min(deadline, Date.now() + waitForNameMs);
      // M365 renders an empty assistant header while starting a reply. Wait for the
      // independent visible name to arrive; never accept an absent name or return
      // response text on route evidence alone. A conflicting name, ID, surface, or
      // route still fails immediately. This polls the UI and never resubmits.
      while (!result.valid && !result.identity?.displayName && Date.now() < nameDeadline) {
        this.navigator.assertNavigationSafe(page, "app");
        const expected = agent.verification;
        const observed = result.identity;
        if (
          !expected.expectedStableAgentId ||
          directAgentIdFromUrl(page.url()) !== expected.expectedStableAgentId ||
          !matchesValidatedAgentPath(new URL(page.url()).pathname, expected) ||
          (observed?.stableAgentId && observed.stableAgentId !== expected.expectedStableAgentId) ||
          (observed?.surface && observed.surface !== expected.expectedSurface)
        )
          break;
        if (request.signal?.aborted) break;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, nameDeadline - Date.now())));
        result = await adapter.assertAgentIdentity(page, expected);
      }
      if (!result.valid) {
        const observed = result.identity;
        let pathname = "<invalid-url>";
        try {
          pathname = new URL(page.url()).pathname;
        } catch {
          // Preserve the identity failure when the current URL itself is malformed.
        }
        throw new BrowserTransportError(
          forceFallback ? fallback : result.code || fallback,
          [
            `The active Microsoft 365 agent identity could not be verified during ${tracker.phase}.`,
            `Expected name=${JSON.stringify(agent.verification.expectedDisplayName)}, stableId=${JSON.stringify(agent.verification.expectedStableAgentId ?? "")};`,
            `observed name=${JSON.stringify(observed?.displayName ?? "")}, stableId=${JSON.stringify(observed?.stableAgentId ?? "")},`,
            `evidence=${JSON.stringify(observed?.evidence ?? [])}; path=${JSON.stringify(pathname)}.`
          ].join(" ")
        );
      }
      return result.identity!;
    };
    const assertPostSubmitContext = async () => {
      try {
        this.navigator.assertNavigationSafe(page, "app");
        await identity("AGENT_CONTEXT_CHANGED", true, Math.min(this.responseStartTimeoutMs, remaining()));
      } catch (error) {
        const diagnostic = error instanceof BrowserTransportError ? ` ${error.message}` : "";
        throw new BrowserTransportError(
          "AGENT_CONTEXT_CHANGED",
          `The agent context changed after submission.${diagnostic}`,
          undefined,
          { submissionState: "sent" }
        );
      }
    };
    const stopWatching = this.navigator.watch(page, "app");
    try {
      tracker.transition("ASSERTING_IDENTITY_BEFORE_FILL");
      report("asserting-identity", "Verifying the active agent identity");
      this.navigator.assertNavigationSafe(page, "app");
      await identity("AGENT_IDENTITY_UNVERIFIED");
      if (request.signal?.aborted)
        throw new BrowserTransportError(
          "SUBMIT_FAILED",
          "The request was cancelled before submission.",
          undefined,
          { submissionState: "not-sent" }
        );
      tracker.transition("FILLING");
      report("filling", "Entering the prompt into the agent composer");
      await adapter.fillComposer(page, request.message);
      tracker.transition("ASSERTING_IDENTITY_BEFORE_SUBMIT");
      let afterFillIdentity;
      try {
        this.navigator.assertNavigationSafe(page, "app");
        afterFillIdentity = await identity("AGENT_CONTEXT_CHANGED", true);
      } catch (error) {
        await adapter.clearComposer(page);
        throw error;
      }
      const marker = await adapter.captureSubmissionMarker(page, afterFillIdentity.digest);
      tracker.record(marker);
      if (marker.url !== page.url() || marker.identityDigest !== afterFillIdentity.digest) {
        const currentUrl = page.url();
        await adapter.clearComposer(page);
        throw new BrowserTransportError(
          "AGENT_CONTEXT_CHANGED",
          [
            "The agent context changed after the composer was filled.",
            `URL changed=${String(marker.url !== currentUrl)};`,
            `identity digest changed=${String(marker.identityDigest !== afterFillIdentity.digest)}.`
          ].join(" ")
        );
      }
      if (request.signal?.aborted) {
        await adapter.clearComposer(page);
        throw new BrowserTransportError(
          "SUBMIT_FAILED",
          "The request was cancelled before submission.",
          undefined,
          { submissionState: "not-sent" }
        );
      }
      tracker.transition("SUBMITTING");
      report("submitting", "Submitting the prompt");
      try {
        await adapter.submitComposer(page);
      } catch (error) {
        if (error instanceof BrowserTransportError && error.details?.submissionState === "not-sent")
          await adapter.clearComposer(page);
        throw error;
      }
      deadline = Date.now() + timeout;
      tracker.transition("WAITING_USER_MESSAGE_ACK");
      report("submitted", "Waiting for the message to be acknowledged");
      const ack = await adapter.waitForUserMessageAck(
        page,
        marker,
        Math.min(remaining(), this.ackTimeoutMs),
        request.signal
      );
      tracker.acknowledge(ack);
      if (ack.state !== "sent")
        throw new BrowserTransportError(
          ack.state === "unknown" ? "SUBMIT_STATE_UNKNOWN" : "SUBMIT_FAILED",
          ack.state === "unknown"
            ? "The message may have been submitted and was not retried."
            : "The user message was not acknowledged.",
          undefined,
          { submissionState: ack.state }
        );
      await assertPostSubmitContext();
      tracker.transition("WAITING_RESPONSE_START");
      report("waiting-response", "Waiting for the agent to start responding");
      const responseMarker = await adapter.waitForResponseStart(
        page,
        marker,
        Math.min(remaining(), this.responseStartTimeoutMs),
        request.signal
      );
      await assertPostSubmitContext();
      tracker.transition("WAITING_RESPONSE_COMPLETE");
      const stopStreamingProgress = this.reportStreaming(page, request.onProgress, started);
      let completion;
      try {
        completion = await adapter.waitForResponseComplete(page, responseMarker, remaining(), request.signal);
      } finally {
        stopStreamingProgress();
      }
      if (!completion.complete) {
        let partialResponse: { text: string; citations: import("./types.js").AgentCitation[] } | undefined;
        try {
          const partial = await adapter.extractLatestResponse(page, responseMarker);
          if (partial.text) partialResponse = { text: partial.text, citations: partial.citations };
        } catch {
          /* conservative partial only */
        }
        throw new BrowserTransportError(
          "RESPONSE_TIMEOUT",
          "The Microsoft 365 agent response did not complete before the timeout.",
          undefined,
          {
            submissionState: "sent",
            partialResponse,
            // Metadata only: why the wait ended, whether the page ever showed a streaming signal,
            // and how long the last observed text was. Never the text itself.
            completion: {
              reason: completion.reason ?? (completion.cancelled ? "cancelled" : "timeout"),
              sawStreamingSignal: completion.sawStreamingSignal ?? false,
              finalChars: completion.finalChars ?? completion.partial?.length ?? 0
            }
          }
        );
      }
      await assertPostSubmitContext();
      tracker.transition("EXTRACTING");
      report("extracting", "Extracting the response");
      const extracted = await adapter.extractLatestResponse(page, responseMarker);
      const candidates = new Map<string, AttachmentCandidate>();
      const collect = (items: AttachmentCandidate[]) => {
        // Keep the latest locator indices, while retaining links seen in earlier passes.
        for (const item of items) candidates.set(attachmentKey(item), item);
        return JSON.stringify([...new Set(items.map(attachmentKey))].sort());
      };
      let observedSet = collect(extracted.attachmentCandidates ?? []);
      let stableSince = Date.now();
      const settleDeadline = Math.min(deadline, stableSince + this.attachmentMaxWaitMs);
      while (this.attachmentSettleMs > 0 && Date.now() < settleDeadline && !request.signal?.aborted) {
        await delay(Math.min(this.attachmentPollIntervalMs, settleDeadline - Date.now()), page);
        if (request.signal?.aborted) break;
        // A delayed scan must obey the same context checks as the first extraction.
        await assertPostSubmitContext();
        try {
          const late = await adapter.extractLatestResponse(page, responseMarker);
          const nextSet = collect(late.attachmentCandidates ?? []);
          if (nextSet !== observedSet) {
            observedSet = nextSet;
            stableSince = Date.now();
          }
          if (Date.now() - stableSince >= this.attachmentSettleMs) break;
        } catch {
          // An unreadable scan is not evidence of stability; retain known candidates.
          stableSince = Date.now();
        }
      }
      if (request.signal?.aborted)
        throw new BrowserTransportError(
          "RESPONSE_TIMEOUT",
          "The request was cancelled while collecting attachments.",
          undefined,
          { submissionState: "sent", partialResponse: extracted }
        );
      await assertPostSubmitContext();
      const { attachmentCandidates: _initialCandidates, ...response } = extracted;
      const attachmentCandidates = [...candidates.values()];
      report("saving-attachments", "Saving returned files");
      const attachments = await this.attachmentSaver.save(page, attachmentCandidates ?? [], {
        workspaceKey: request.workspaceKey ?? "workspace",
        workspaceRoot: request.workspaceRoot,
        requestId: request.requestId ?? conversation.handle
      });
      tracker.complete();
      report("done", "The agent response is complete");
      return {
        agent: agent.alias,
        conversationHandle: conversation.handle,
        ...response,
        attachments,
        elapsedMs: Date.now() - started,
        submissionState: "sent",
        sourceType: "m365-agent"
      };
    } catch (error) {
      tracker.fail();
      throw error;
    } finally {
      stopWatching();
    }
  }

  /** Emits a `streaming` heartbeat (elapsed time + response length) while the response grows.
   * Only the character count is reported; the response text itself never leaves the page. */
  private reportStreaming(page: PageLike, onProgress: ProgressSink | undefined, started: number): () => void {
    if (!onProgress) return () => undefined;
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const responseChars = await responseLength(page);
        if (!stopped) onProgress({ phase: "streaming", elapsedMs: Date.now() - started, responseChars });
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void tick(), this.streamingProgressIntervalMs);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}

async function delay(ms: number, page: PageLike): Promise<void> {
  if (page.waitForTimeout) await page.waitForTimeout(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseLength(page: PageLike): Promise<number | undefined> {
  try {
    if (!page.evaluate) return undefined;
    const length = await page.evaluate<number>((selector: string) => {
      const nodes = [...document.querySelectorAll(selector)] as HTMLElement[];
      const node = nodes[nodes.length - 1];
      return (node?.innerText ?? "").trim().length;
    }, RESPONSE_SELECTORS.join(", "));
    return typeof length === "number" ? length : undefined;
  } catch {
    return undefined;
  }
}

/** URLs identify separate same-name files. UI-only controls use their structural location too. */
function attachmentKey(candidate: AttachmentCandidate): string {
  if (candidate.url) return `url:${candidate.url}`;
  return JSON.stringify([
    candidate.fileCardIndex !== undefined ? "card" : "control",
    candidate.fileCardIndex ?? candidate.downloadControlIndex ?? candidate.index,
    candidate.name
  ]);
}
