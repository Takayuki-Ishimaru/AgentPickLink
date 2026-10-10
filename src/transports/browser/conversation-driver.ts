import { createHash } from "node:crypto";
import { DomainError, ERROR_CODES, type ErrorCode, type PartialResponse } from "../../domain/errors.js";
import type { ProgressPhase, ProgressSink } from "../../domain/progress.js";
import type { AgentAttachment, ConversationReading } from "../../domain/response.js";
import { AgentNavigator } from "./agent-navigator.js";
import { AttachmentSaver } from "./attachment-saver.js";
import {
  composerTextMatches,
  foldComposerWhitespace,
  normalizeComposerText,
  readComposerPlainText
} from "./composer-text.js";
import { RESPONSE_SELECTORS } from "./selectors/common.js";
import { directAgentIdFromUrl, matchesValidatedAgentPath } from "./identity.js";
import { changedBeforePress } from "./send-activation.js";
import { SubmissionTracker } from "./submission-tracker.js";
import {
  BrowserTransportError,
  type BrowserAgentDefinition,
  type AgentResponse,
  type BrowserInvokeRequest,
  type BrowserPageConversation,
  type BrowserReadRequest,
  type AttachmentCandidate,
  type ConversationExchange,
  type EnteredMessage,
  type ExtractedResponse,
  type PageLike,
  type ResponseMarker,
  type SubmissionMarker,
  type SubmissionState
} from "./types.js";
import type { ChatUiAdapter, SubmitGuard } from "./ui-adapter.js";

export interface ConversationDriverOptions {
  /** Spacing of `streaming` progress events while a response grows. */
  streamingProgressIntervalMs?: number;
  /** How long to wait for the submitted prompt to appear as a user message. A read waits as long
   * again for a message whose submission was uncertain before it calls the message not shown. */
  ackTimeoutMs?: number;
  /** How long to wait for the agent's first response node after acknowledgement, or for the reply
   * to a message a read found in the conversation. */
  responseStartTimeoutMs?: number;
  /** Quiet window for the attachment candidate set; zero disables settling. */
  attachmentSettleMs?: number;
  /** Cap on attachment observation after text completion while the set keeps changing; a longer
   * attachmentSettleMs (plus one poll) is honoured. */
  attachmentMaxWaitMs?: number;
  attachmentPollIntervalMs?: number;
}

/** How many more looks a read takes, at most, for two looks in a row to agree, and how far apart. */
const READ_LOOKS = 4;
const READ_LOOK_INTERVAL_MS = 200;

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
    const report = this.reporter(request.onProgress, started);
    const { identity, assertPostSubmitContext } = this.contextChecks(page, agent, adapter, {
      signal: request.signal,
      phase: () => tracker.phase,
      deadline: () => deadline,
      during: "submission"
    });
    // The user messages the conversation held when typing began: one more before the press may be
    // this message, sent some other way (see sentMeanwhile).
    let userMessagesBeforeTyping: number | undefined;
    const entered = request.entered;
    const stopWatching = this.navigator.watch(page, "app");
    try {
      tracker.transition("ASSERTING_IDENTITY_BEFORE_FILL");
      report("asserting-identity", "Verifying the active agent identity");
      try {
        this.navigator.assertNavigationSafe(page, "app");
        await identity("AGENT_IDENTITY_UNVERIFIED");
      } catch (error) {
        throw notSentBeforePress(error);
      }
      if (request.signal?.aborted)
        throw new BrowserTransportError(
          "SUBMIT_FAILED",
          "The request was cancelled before submission.",
          undefined,
          { submissionState: "not-sent" }
        );
      tracker.transition("FILLING");
      report("filling", "Entering the prompt into the agent composer");
      const beforeTyping = await adapter.captureConversationMarker(page).catch(() => undefined);
      userMessagesBeforeTyping = beforeTyping?.userCount;
      if (entered) {
        // From here on this is the conversation's last entered message. A count the page could not
        // really read is no baseline for a later read.
        entered.typed = true;
        entered.userCountBefore = beforeTyping?.unreadable ? undefined : beforeTyping?.userCount;
      }
      try {
        await adapter.fillComposer(page, request.message, request.signal);
      } catch (error) {
        // Await the stopped input before clearing, so no background typing can restore a draft.
        await adapter.clearComposer(page);
        throw error;
      }
      tracker.transition("ASSERTING_IDENTITY_BEFORE_SUBMIT");
      let afterFillIdentity;
      try {
        this.navigator.assertNavigationSafe(page, "app");
        afterFillIdentity = await identity("AGENT_CONTEXT_CHANGED", true);
      } catch (error) {
        await adapter.clearComposer(page);
        throw notSentBeforePress(error);
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
          ].join(" "),
          undefined,
          { submissionState: "not-sent" }
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
      if (!composerTextMatches(marker.composerValue, request.message)) {
        await adapter.clearComposer(page);
        throw new BrowserTransportError(
          "UI_CHANGED",
          "The composer changed after the requested message was verified.",
          undefined,
          { submissionState: "not-sent" }
        );
      }
      tracker.transition("SUBMITTING");
      report("submitting", "Submitting the prompt");
      // The send control can take seconds to become clickable. What was verified above must still
      // hold when it is pressed: the same agent and page address, the composer still holding the
      // requested message, and no new user message. The adapter's gate guards the press itself,
      // including the page context captured with the marker.
      const guard: SubmitGuard = {
        message: request.message,
        marker,
        verifyBeforePress: async () => {
          let now: SubmissionMarker;
          try {
            this.navigator.assertNavigationSafe(page, "app");
            now = await adapter.captureSubmissionMarker(page, marker.identityDigest);
          } catch (error) {
            throw notSentBeforePress(error);
          }
          if (now.userCount > marker.userCount) throw sentMeanwhile();
          try {
            await identity("AGENT_CONTEXT_CHANGED", true);
            if (routeOf(now.url) !== routeOf(marker.url))
              throw new BrowserTransportError(
                "AGENT_CONTEXT_CHANGED",
                "The page address changed while the send control was becoming clickable."
              );
            if (!composerTextMatches(now.composerValue, request.message))
              throw changedBeforePress("composer");
          } catch (error) {
            throw notSentBeforePress(error);
          }
        }
      };
      try {
        await adapter.submitComposer(page, request.signal, guard);
      } catch (error) {
        if (error instanceof BrowserTransportError && error.details?.submissionState === "not-sent") {
          // The composer held the message when submission started. One the page has emptied since
          // is the usual sign of a send, perhaps of this message some other way: never not-sent.
          if (await composerEmptied(adapter, page)) throw sentMeanwhile();
          await adapter.clearComposer(page);
        }
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
      // The control was pressed, so an unconfirmed message may still have been accepted: unknown,
      // never not-sent, whatever the composer shows (v0.2.8 review).
      if (ack.state !== "sent")
        throw new BrowserTransportError(
          "SUBMIT_STATE_UNKNOWN",
          `The message may have been submitted and was not retried (${ack.reason ?? "no acknowledgement"}).`,
          undefined,
          { submissionState: "unknown" }
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
      const reply = await this.collectReply(
        {
          page,
          adapter,
          request,
          expectFiles: request.expectFiles !== false,
          handle: conversation.handle,
          deadline: () => deadline,
          report,
          assertContext: assertPostSubmitContext,
          onExtracting: () => tracker.transition("EXTRACTING")
        },
        responseMarker
      );
      if (!reply.complete)
        throw new BrowserTransportError(
          "RESPONSE_TIMEOUT",
          "The Microsoft 365 agent response did not complete before the timeout.",
          undefined,
          {
            submissionState: "sent",
            partialResponse: reply.partialResponse,
            // Metadata only: why the wait ended, whether the page ever showed a streaming signal,
            // and how long the last observed text was. Never the text itself.
            completion: reply.completion
          }
        );
      tracker.complete();
      if (entered) Object.assign(entered, { state: "sent", settledAt: Date.now() });
      report("done", "The agent response is complete");
      return {
        agent: agent.alias,
        conversationHandle: conversation.handle,
        ...reply.response,
        attachments: reply.attachments,
        elapsedMs: Date.now() - started,
        submissionState: "sent",
        sourceType: "m365-agent"
      };
    } catch (error) {
      tracker.fail();
      // Every failure says whether the message was sent; one that does not yet takes the state the
      // submission reached (SubmissionTracker).
      let failure = withSubmissionState(error, tracker.state);
      // Not sent by this request, but the conversation gained a user message after typing began:
      // the message may have gone out some other way, such as a key the editor takes as "send".
      if (userMessagesBeforeTyping !== undefined && submissionStateOf(failure) === "not-sent") {
        const now = await adapter.captureConversationMarker(page).catch(() => undefined);
        if (now && now.userCount > userMessagesBeforeTyping) failure = sentMeanwhile();
      }
      // A later read of the conversation judges the message by how far its submission got.
      if (entered)
        Object.assign(entered, {
          state: (submissionStateOf(failure) as SubmissionState | undefined) ?? tracker.state,
          settledAt: Date.now()
        });
      throw failure;
    } finally {
      stopWatching();
    }
  }

  /**
   * Reads the conversation without sending anything (m365_agent_session action=read): whether the
   * last message entered in it (`request.entered`) is shown there, and the reply to the latest user
   * message, waiting for it to start (responseStartTimeoutMs) and to finish within the request's
   * budget, then collected like an invocation's reply. The context checks of a submission apply:
   * the page must still show the agent the conversation was opened with. A message whose submission
   * was uncertain gets the acknowledgement time once more, counted from the end of its request, to
   * appear, so that a slow page is not mistaken for a message that never left; a read long after
   * that does not wait again. Anything short of the message itself being shown is decided only by
   * looks that agree (see enteredMessageState for what each answer needs).
   */
  async read(
    page: PageLike,
    conversation: BrowserPageConversation,
    agent: BrowserAgentDefinition,
    adapter: ChatUiAdapter,
    request: BrowserReadRequest
  ): Promise<ConversationReading> {
    const started = Date.now();
    const deadline = started + (request.timeoutMs ?? 300_000);
    const report = this.reporter(request.onProgress, started);
    const { assertPostSubmitContext } = this.contextChecks(page, agent, adapter, {
      signal: request.signal,
      phase: () => "READING",
      deadline: () => deadline,
      during: "read"
    });
    const captureExchange = adapter.captureExchange?.bind(adapter);
    if (!captureExchange)
      throw new BrowserTransportError(
        "UNSUPPORTED_UI",
        "This chat page cannot be read without sending a message."
      );
    const capture = () => captureExchange(page);
    const cancelled = () =>
      new BrowserTransportError("RESPONSE_TIMEOUT", "Reading the conversation was cancelled.");
    /** Polls `capture` (as often as the acknowledgement wait does) until `done` holds or `untilMs`
     * passes, and returns the last exchange observed. A cancellation ends the wait at once. */
    const watch = async (
      first: ConversationExchange,
      done: (exchange: ConversationExchange) => boolean,
      untilMs: number
    ) => {
      let exchange = first;
      const until = Math.min(deadline, Date.now() + untilMs);
      while (!done(exchange) && Date.now() < until) {
        if (request.signal?.aborted) throw cancelled();
        await abortableDelay(Math.min(100, Math.max(1, until - Date.now())), request.signal);
        if (request.signal?.aborted) throw cancelled();
        exchange = await capture();
      }
      return exchange;
    };
    const stopWatching = this.navigator.watch(page, "app");
    try {
      report("asserting-identity", "Verifying the active agent identity");
      await assertPostSubmitContext();
      const entered = request.entered;
      if (!entered) {
        report("done", "The conversation was read");
        return { message: "none", reply: "none" };
      }
      const about = entered.requestId === undefined ? {} : { messageRequestId: entered.requestId };
      report("checking-message", "Checking whether the message is in the conversation");
      const judge = (exchange: ConversationExchange) => enteredMessageState(exchange, entered);
      const shown = (judgement: ReturnType<typeof judge>) => judgement === "shown" || judgement === "differs";
      let exchange = await capture();
      let judgement = judge(exchange);
      if (entered.state !== "not-sent" && !shown(judgement)) {
        exchange = await watch(
          exchange,
          (current) => shown(judge(current)),
          entered.settledAt === undefined
            ? this.ackTimeoutMs
            : Math.max(0, entered.settledAt + this.ackTimeoutMs - Date.now())
        );
        judgement = judge(exchange);
        // One look decides nothing short of the message itself: a page that is re-rendering or
        // reloading can show fewer messages, or none, for a moment. Look again, with the context
        // checked again, until two looks in a row agree.
        let agreed = shown(judgement);
        for (let look = 0; look < READ_LOOKS && !agreed; look++) {
          await abortableDelay(READ_LOOK_INTERVAL_MS, request.signal);
          if (request.signal?.aborted) throw cancelled();
          await assertPostSubmitContext();
          exchange = await capture();
          const next = judge(exchange);
          agreed = next === judgement || shown(next);
          judgement = next;
        }
        // Not shown is a licence to send again: looks that never agreed do not give it.
        if (!agreed && judgement === "not-shown") judgement = "unconfirmed";
      }
      if (judgement === "unreadable")
        throw new BrowserTransportError(
          "UI_CHANGED",
          "The conversation could not be read: the page did not show its messages. Nothing was sent; read the conversation again."
        );
      const message = judgement;
      if (!shown(message)) {
        report("done", "The conversation was read");
        return { message, ...about, reply: "none" };
      }
      await assertPostSubmitContext();
      if (!exchange.replyStarted) {
        report("waiting-response", "Waiting for the agent to start responding");
        exchange = await watch(exchange, (current) => current.replyStarted, this.responseStartTimeoutMs);
        if (!exchange.replyStarted) {
          report("done", "The conversation was read");
          return { message, ...about, reply: "none" };
        }
        await assertPostSubmitContext();
      }
      const reply = await this.collectReply(
        {
          page,
          adapter,
          request,
          expectFiles: true,
          handle: conversation.handle,
          deadline: () => deadline,
          report,
          assertContext: assertPostSubmitContext,
          during: "read"
        },
        { assistantCount: exchange.assistantCount, digest: exchange.digest }
      );
      if (!reply.complete) {
        // A cancelled read reports the cancellation, not a reply that merely did not finish.
        if (request.signal?.aborted) throw cancelled();
        return {
          message,
          ...about,
          reply: "incomplete",
          ...(reply.partialResponse ? { partialResponse: reply.partialResponse } : {})
        };
      }
      report("done", "The agent response is complete");
      return {
        message,
        ...about,
        reply: "complete",
        response: { ...reply.response, attachments: reply.attachments }
      };
    } finally {
      stopWatching();
    }
  }

  /**
   * Waits for the reply that `responseMarker` started to finish and collects it: its text, then --
   * unless the request asked for text only -- files that can appear after it, then the files
   * themselves. A reply that does not finish within the budget is returned incomplete, with what it
   * showed so far. The context checks after a submission apply throughout.
   */
  private async collectReply(context: ReplyContext, responseMarker: ResponseMarker): Promise<CollectedReply> {
    const { page, adapter, request, report } = context;
    const signal = request.signal;
    const stopStreamingProgress = this.reportStreaming(page, report, !!request.onProgress);
    let completion;
    try {
      completion = await adapter.waitForResponseComplete(
        page,
        responseMarker,
        Math.max(1, context.deadline() - Date.now()),
        signal,
        () => report("confirming-response", "Confirming the answer is complete")
      );
    } finally {
      stopStreamingProgress();
    }
    if (!completion.complete) {
      let partialResponse: PartialResponse | undefined;
      try {
        const partial = await adapter.extractLatestResponse(page, responseMarker);
        if (partial.text) partialResponse = { text: partial.text, citations: partial.citations };
      } catch {
        /* conservative partial only */
      }
      return {
        complete: false,
        ...(partialResponse ? { partialResponse } : {}),
        completion: {
          reason: completion.reason ?? (completion.cancelled ? "cancelled" : "timeout"),
          sawStreamingSignal: completion.sawStreamingSignal ?? false,
          finalChars: completion.finalChars ?? completion.partial?.length ?? 0
        }
      };
    }
    await context.assertContext();
    context.onExtracting?.();
    report("extracting", "Extracting the response");
    const extracted = await adapter.extractLatestResponse(page, responseMarker);
    const { attachmentCandidates: initialCandidates, ...response } = extracted;
    const candidates = new Map<string, AttachmentCandidate>();
    const collect = (items: AttachmentCandidate[]) => {
      // Keep the latest locator indices, while retaining links seen in earlier passes.
      for (const item of items) candidates.set(attachmentKey(item), item);
      return JSON.stringify([...new Set(items.map(attachmentKey))].sort());
    };
    let observedSet = collect(initialCandidates ?? []);
    // Microsoft 365 can render a generated file's card a moment after the answer's text settles:
    // watch the candidates until they hold still -- unless the request asked for text only.
    if (context.expectFiles && this.attachmentSettleMs > 0) {
      report("checking-attachments", "Checking for files that arrive after the answer");
      let stableSince = Date.now();
      // At most attachmentMaxWaitMs for a set that keeps changing -- or long enough to honour a
      // longer configured settle time.
      const maxWait = Math.max(
        this.attachmentMaxWaitMs,
        this.attachmentSettleMs + this.attachmentPollIntervalMs
      );
      const settleDeadline = Math.min(context.deadline(), stableSince + maxWait);
      while (Date.now() < settleDeadline && !signal?.aborted) {
        await delay(Math.min(this.attachmentPollIntervalMs, settleDeadline - Date.now()), page);
        if (signal?.aborted) break;
        // A delayed scan must obey the same context checks as the first extraction.
        await context.assertContext();
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
    }
    // The text only: never the internal attachment candidates (URLs, names) in a public partial.
    const cancelledWhileCollecting = () =>
      new BrowserTransportError(
        "RESPONSE_TIMEOUT",
        "The request was cancelled while collecting attachments.",
        undefined,
        {
          ...(context.during === "read" ? {} : { submissionState: "sent" }),
          partialResponse: { text: response.text, citations: response.citations }
        }
      );
    if (signal?.aborted) throw cancelledWhileCollecting();
    await context.assertContext();
    const attachmentCandidates = [...candidates.values()];
    if (attachmentCandidates.length) report("saving-attachments", "Saving returned files");
    const attachments = await this.attachmentSaver.save(page, attachmentCandidates, {
      workspaceKey: request.workspaceKey ?? "workspace",
      workspaceRoot: request.workspaceRoot,
      requestId: request.requestId ?? context.handle,
      signal
    });
    // The saver stops at its next safe point once cancelled; if that cut any file short, report it
    // like a cancel above. A cancel arriving after every file was handled changes nothing.
    if (attachments.some((item) => item.stage === "cancelled")) throw cancelledWhileCollecting();
    return { complete: true, response, attachments };
  }

  /**
   * The identity and context checks of one request. `identity` asserts the agent the page shows,
   * waiting up to `waitForNameMs` (within `deadline`) for a visible name that is merely still
   * missing; `assertPostSubmitContext` is the check after a submission -- or while reading a
   * conversation -- where any change of the agent or the page means AGENT_CONTEXT_CHANGED. `phase`
   * names where the request is, for a failure's message.
   */
  private contextChecks(
    page: PageLike,
    agent: BrowserAgentDefinition,
    adapter: ChatUiAdapter,
    options: {
      signal?: AbortSignal;
      phase: () => string;
      deadline: () => number;
      during: "submission" | "read";
    }
  ) {
    // Only the post-submit identity wait can be cut short by a cancel (see identity() below).
    const cancelledWhileVerifying =
      options.during === "read"
        ? new BrowserTransportError("RESPONSE_TIMEOUT", "Reading the conversation was cancelled.")
        : new BrowserTransportError(
            "RESPONSE_TIMEOUT",
            "Waiting was cancelled after the message was submitted.",
            undefined,
            { submissionState: "sent" }
          );
    const identity = async (
      fallback: "AGENT_IDENTITY_UNVERIFIED" | "AGENT_IDENTITY_MISMATCH" | "AGENT_CONTEXT_CHANGED",
      forceFallback = false,
      waitForNameMs = 0
    ) => {
      let result = await adapter.assertAgentIdentity(page, agent.verification);
      const nameDeadline = Math.min(options.deadline(), Date.now() + waitForNameMs);
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
        // The name is merely still missing and nothing conflicts: a cancel ends only the wait.
        if (options.signal?.aborted) throw cancelledWhileVerifying;
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
            `The active Microsoft 365 agent identity could not be verified during ${options.phase()}.`,
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
        await identity(
          "AGENT_CONTEXT_CHANGED",
          true,
          Math.min(this.responseStartTimeoutMs, Math.max(1, options.deadline() - Date.now()))
        );
      } catch (error) {
        // A cancel that ended the wait for a still-missing name is a cancellation, not evidence
        // that the context changed; a conflict or policy violation stays one.
        if (error === cancelledWhileVerifying) throw error;
        const diagnostic = error instanceof BrowserTransportError ? ` ${error.message}` : "";
        throw options.during === "read"
          ? new BrowserTransportError(
              "AGENT_CONTEXT_CHANGED",
              `The agent context changed, so the conversation was not read.${diagnostic}`
            )
          : new BrowserTransportError(
              "AGENT_CONTEXT_CHANGED",
              `The agent context changed after submission.${diagnostic}`,
              undefined,
              { submissionState: "sent" }
            );
      }
    };
    return { identity, assertPostSubmitContext };
  }

  /** The request's progress sink. Metadata only: a phase, the elapsed time and a character count,
   * never message text. A failing sink must never fail the request, least of all after the message
   * was pressed. The same phase reported twice in a row is sent once, except `streaming`, which
   * carries a changing count. */
  private reporter(onProgress: ProgressSink | undefined, started: number): Reporter {
    let last: ProgressPhase | undefined;
    return (phase, message, responseChars) => {
      if (phase === last && phase !== "streaming") return;
      last = phase;
      try {
        onProgress?.({
          phase,
          message,
          elapsedMs: Date.now() - started,
          ...(responseChars === undefined ? {} : { responseChars })
        });
      } catch {
        /* progress is best effort */
      }
    };
  }

  /** Emits a `streaming` event (elapsed time + response length) whenever the response grew since
   * the previous check, every streamingProgressIntervalMs. The length when the wait starts is only
   * the baseline: a reply that is already complete, or that holds still, is left to the
   * `confirming-response` phase instead of being reported as streaming. Only the character count is
   * reported; the response text itself never leaves the page. */
  private reportStreaming(page: PageLike, report: Reporter, enabled: boolean): () => void {
    if (!enabled) return () => undefined;
    let stopped = false;
    let inFlight = false;
    let previous: number | undefined;
    const tick = async (baseline: boolean) => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const responseChars = await responseLength(page);
        if (stopped || responseChars === undefined) return;
        if (!baseline && previous !== undefined && responseChars > previous)
          report("streaming", undefined, responseChars);
        previous = responseChars;
      } finally {
        inFlight = false;
      }
    };
    void tick(true);
    const timer = setInterval(() => void tick(false), this.streamingProgressIntervalMs);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}

type Reporter = (phase: ProgressPhase, message?: string, responseChars?: number) => void;

/** What collecting one reply works with (see ConversationDriver.collectReply). */
type ReplyContext = {
  page: PageLike;
  adapter: ChatUiAdapter;
  request: Pick<
    BrowserInvokeRequest,
    "signal" | "onProgress" | "requestId" | "workspaceKey" | "workspaceRoot"
  >;
  /** False for a text-only question: no wait for files that can appear after the answer. */
  expectFiles: boolean;
  /** The conversation's handle, naming the saved files' directory when the request has no id. */
  handle: string;
  /** The end of the request's budget for the reply. */
  deadline: () => number;
  report: Reporter;
  /** The context check after a submission (or while reading), run before each extraction. */
  assertContext: () => Promise<void>;
  onExtracting?: () => void;
  /** A read's cancellation is not a sent message's: it carries no submission state. */
  during?: "submission" | "read";
};
type CollectedReply =
  | {
      complete: true;
      response: Omit<ExtractedResponse, "attachmentCandidates">;
      attachments: AgentAttachment[];
    }
  | {
      complete: false;
      partialResponse?: PartialResponse;
      completion: { reason: string; sawStreamingSignal: boolean; finalChars: number };
    };

/** The digest a conversation's last entered message is remembered by: its text with line endings
 * and no-break spaces folded the way the acknowledgement compares the user's bubble. */
export function enteredMessageDigest(message: string): string {
  return createHash("sha256")
    .update(foldComposerWhitespace(normalizeComposerText(message)))
    .digest("hex");
}

/** A fresh record of a message about to be entered by request `requestId` (see EnteredMessage). */
export function enteredMessage(message: string, requestId?: string): EnteredMessage {
  return {
    digest: enteredMessageDigest(message),
    ...(requestId === undefined ? {} : { requestId }),
    state: "not-sent"
  };
}

/** What one look at the conversation says about the entered message (ConversationReading's
 * `message`), or `unreadable` when the look cannot be judged.
 *
 * Only certainty may say "not shown", since that tells the caller it can send the message again:
 * the send control was never pressed, or -- for a message that may have been sent -- the page kept
 * it in the composer and shows no user message added since typing began. A message the page
 * acknowledged is never "not shown". The latest user message being this message counts as shown
 * when the conversation gained a user message since typing began; without that, it may be an
 * earlier message with the same text, so only an acknowledged message is taken as shown then. */
function enteredMessageState(
  exchange: ConversationExchange,
  entered: EnteredMessage
): ConversationReading["message"] | "unreadable" {
  if (entered.state === "not-sent") return "not-shown";
  if (exchange.readable === false) return "unreadable";
  const added =
    entered.userCountBefore === undefined ? undefined : exchange.userCount > entered.userCountBefore;
  const latest =
    exchange.latestUserText !== undefined && enteredMessageDigest(exchange.latestUserText) === entered.digest;
  if (latest && (added !== false || entered.state === "sent")) return "shown";
  if (added === true) return "differs";
  if (entered.state === "sent") return "unconfirmed";
  // May have been sent, and the conversation shows no user message added since typing began (the
  // latest may be an earlier one with the same text), or there is no count to tell.
  const kept =
    exchange.composerText !== undefined && enteredMessageDigest(exchange.composerText) === entered.digest;
  return kept && added === false ? "not-shown" : "unconfirmed";
}

async function delay(ms: number, page: PageLike): Promise<void> {
  if (page.waitForTimeout) await page.waitForTimeout(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}

/** `ms` of waiting that a cancellation ends early. */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

/** A user message appeared before the send control was pressed: something else sent a message,
 * possibly this one, so it is neither pressed nor reported as not sent. */
function sentMeanwhile(): BrowserTransportError {
  return new BrowserTransportError(
    "SUBMIT_STATE_UNKNOWN",
    "A new user message appeared in the conversation before the send control was pressed, so the message may have been sent another way. It was not sent again.",
    undefined,
    { submissionState: "unknown" }
  );
}

/** Whether the composer is still on the page and holds nothing at all. */
async function composerEmptied(adapter: ChatUiAdapter, page: PageLike): Promise<boolean> {
  try {
    return (await readComposerPlainText(await adapter.findComposer(page))) === "";
  } catch {
    return false;
  }
}

function submissionStateOf(error: unknown): unknown {
  if (error instanceof BrowserTransportError) return error.details?.submissionState;
  return error instanceof DomainError ? error.options.submissionState : undefined;
}

/** The page address without query or fragment: the agent and the conversation are in the path. */
function routeOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

/** The failure, saying whether the message was sent. One that says so already is kept as it is;
 * a transport or domain error otherwise keeps its code and message. Any other error is the page or
 * the browser failing under an operation: it keeps a navigation-policy code if it carries one and
 * is otherwise an internal error, as BrowserTransport would report it. A domain error that may
 * have submitted the message is no longer retryable. */
function withSubmissionState(error: unknown, state: SubmissionState): unknown {
  if (error instanceof BrowserTransportError) {
    if (!error.details?.submissionState) error.details = { ...error.details, submissionState: state };
    return error;
  }
  if (error instanceof DomainError)
    return error.options.submissionState
      ? error
      : new DomainError(error.code, error.message, error.retryable && state === "not-sent", {
          ...error.options,
          submissionState: state
        });
  const code = (error as { code?: unknown } | undefined)?.code;
  return new BrowserTransportError(
    typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)
      ? (code as ErrorCode)
      : "INTERNAL_ERROR",
    error instanceof Error ? error.message : "The browser conversation failed.",
    undefined,
    { submissionState: state }
  );
}

/** A check that failed before the send control was pressed: whatever it was, nothing was sent.
 * Keeps the code of a transport or navigation-policy error; anything else is a page that could not
 * be read, reported without its message, which can describe page content. */
function notSentBeforePress(error: unknown): BrowserTransportError {
  if (error instanceof BrowserTransportError)
    return new BrowserTransportError(error.code, error.message, error.remediation, {
      ...error.details,
      submissionState: "not-sent"
    });
  const code = (error as { code?: unknown } | undefined)?.code;
  if (error instanceof Error && typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code))
    return new BrowserTransportError(code as ErrorCode, error.message, undefined, {
      submissionState: "not-sent"
    });
  return new BrowserTransportError(
    "UI_CHANGED",
    "The page could not be verified before the send control was pressed, so the message was not sent.",
    undefined,
    { submissionState: "not-sent" }
  );
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
