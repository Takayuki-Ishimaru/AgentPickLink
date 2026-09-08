import { createHash } from "node:crypto";
import { AuthDetector } from "../auth-detector.js";
import { CompletionDetector } from "../completion-detector.js";
import { identityDigest, assertIdentity, directAgentIdFromUrl } from "../identity.js";
import { ResponseExtractor } from "../response-extractor.js";
import {
  ASSISTANT_MESSAGE_SELECTORS,
  COMPOSER_SELECTORS,
  CONVERSATION_ID_SELECTOR,
  CONVERSATION_REGION_SELECTORS,
  IDENTITY_HEADING_SELECTOR,
  IDENTITY_LABEL_SELECTOR,
  IDENTITY_ROOT_SELECTOR,
  MAIN_REGION_SELECTOR,
  M365_ASSISTANT_ARTICLE_SELECTOR,
  M365_ASSISTANT_AUTHOR_SELECTOR,
  M365_ASSISTANT_CONTENT_SELECTOR,
  RESPONSE_SELECTORS,
  SEND_SELECTORS,
  USER_MESSAGE_SELECTORS,
  combinedPattern
} from "../selectors/common.js";
import { EN_TEXT } from "../selectors/en.js";
import { JA_TEXT } from "../selectors/ja.js";
import {
  BrowserTransportError,
  type BrowserAgentVerification,
  type CompletionResult,
  type ConversationMarker,
  type ExtractedResponse,
  type LocatorLike,
  type PageLike,
  type ResponseMarker,
  type SubmissionAck,
  type SubmissionMarker,
  type UiFingerprint
} from "../types.js";
import type { AdapterMatch, ChatUiAdapter, DetectedAgentIdentity, IdentityAssertion } from "../ui-adapter.js";

export interface BaseAdapterOptions {
  id: string;
  hostnames: string[];
  surface: "m365-copilot" | "teams-web";
  diagnosticOnly?: boolean;
  stabilityWindowMs?: number;
  pollIntervalMs?: number;
  /** Extra quiet time required before an unchanged response counts as complete when no streaming
   * signal was ever observed (see CompletionDetector). */
  quietStreamingGraceMs?: number;
  /** Per-character delay used when typing into a rich-text composer. */
  typingDelayMs?: number;
  attachmentHosts?: string[];
}

/** What a surface adapter accepts from the registry: everything BaseAdapterOptions takes except
 * the identity fields (id/surface/diagnosticOnly) each adapter fixes for itself. One definition,
 * so a new knob reaches every adapter without four parallel edits. */
export type SurfaceChatAdapterOptions = Omit<
  BaseAdapterOptions,
  "id" | "surface" | "hostnames" | "diagnosticOnly"
> & { hostnames?: string[] };

export class BaseChatUiAdapter implements ChatUiAdapter {
  readonly id: string;
  readonly canSubmit: boolean;
  protected readonly hostnames: Set<string>;
  protected readonly surface: BaseAdapterOptions["surface"];
  protected readonly auth = new AuthDetector();
  protected readonly completion: CompletionDetector;
  protected readonly extractor: ResponseExtractor;
  private readonly composerStabilityWindowMs: number;
  private readonly typingDelayMs: number;
  constructor(options: BaseAdapterOptions) {
    this.id = options.id;
    this.hostnames = new Set(options.hostnames.map((h) => h.toLowerCase()));
    this.surface = options.surface;
    this.canSubmit = !options.diagnosticOnly;
    this.extractor = new ResponseExtractor({ attachmentHosts: options.attachmentHosts });
    this.composerStabilityWindowMs = options.stabilityWindowMs ?? 2_500;
    this.typingDelayMs = options.typingDelayMs ?? 20;
    this.completion = new CompletionDetector({
      stabilityWindowMs: options.stabilityWindowMs,
      pollIntervalMs: options.pollIntervalMs,
      quietStreamingGraceMs: options.quietStreamingGraceMs
    });
  }
  async canHandle(page: PageLike): Promise<AdapterMatch> {
    let u: URL;
    try {
      u = new URL(page.url());
    } catch {
      return { matched: false, confidence: "none", reason: "invalid URL" };
    }
    if (this.hostnames.size && !this.hostnames.has(u.hostname.toLowerCase()))
      return { matched: false, confidence: "none", reason: "unsupported host" };
    const identity = await this.detectAgentIdentity(page);
    if (identity?.surface && identity.surface !== this.surface)
      return { matched: false, confidence: "none", reason: "unsupported surface" };
    const composer = await this.findComposerSafe(page);
    const fingerprint = await this.captureUiFingerprint(page, !!composer, identity?.evidence.length ?? 0);
    const routeAgentId = directAgentIdFromUrl(u);
    const verifiedDirectAgentLanding =
      this.surface === "m365-copilot" &&
      !!routeAgentId &&
      identity?.stableAgentId === routeAgentId &&
      identity.evidence.includes("visible-name") &&
      identity.evidence.includes("stable-id");
    if (
      identity &&
      composer &&
      fingerprint.hasMainRegion &&
      ((fingerprint.hasSendButton && fingerprint.hasConversationRegion) || verifiedDirectAgentLanding)
    )
      return { matched: true, confidence: "strong" };
    if (composer) return { matched: true, confidence: "weak", reason: "identity signal unavailable" };
    return { matched: false, confidence: "none", reason: "chat structure not found" };
  }
  async captureUiFingerprint(
    page: PageLike,
    hasComposer?: boolean,
    identitySignalCount?: number
  ): Promise<UiFingerprint> {
    let structure = { hasMainRegion: false, hasSendButton: false, hasConversationRegion: false };
    try {
      if (page.evaluate)
        structure = await page.evaluate(
          (sel: { main: string; send: string; conversation: string }) => ({
            hasMainRegion: !!document.querySelector(sel.main),
            hasSendButton: !!document.querySelector(sel.send),
            hasConversationRegion: !!document.querySelector(sel.conversation)
          }),
          {
            main: MAIN_REGION_SELECTOR,
            send: SEND_SELECTORS.join(", "),
            conversation: CONVERSATION_REGION_SELECTORS
          }
        );
    } catch {
      /* unknown remains false */
    }
    return {
      adapterId: this.id,
      ...structure,
      hasComposer: hasComposer ?? (await this.findComposerSafe(page)),
      identitySignalCount: identitySignalCount ?? (await this.detectAgentIdentity(page))?.evidence.length ?? 0
    };
  }
  detectAuthState(page: PageLike) {
    return this.auth.detect(page);
  }
  async detectAgentIdentity(
    page: PageLike,
    expectedDisplayName?: string
  ): Promise<DetectedAgentIdentity | null> {
    let raw: any;
    const routeAgentId = directAgentIdFromUrl(page.url());
    try {
      raw = page.evaluate
        ? await page.evaluate(
            (sel: {
              root: string;
              main: string;
              heading: string;
              label: string;
              composer: string;
              message: string;
              assistantArticle: string;
              assistantAuthor: string;
              assistantContent: string;
              routeAgentId?: string;
              expectedDisplayName?: string;
            }) => {
              const isVisible = (element: HTMLElement) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return (
                  style.visibility !== "hidden" &&
                  style.display !== "none" &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              };
              const routeRoot = sel.routeAgentId
                ? ([...document.querySelectorAll("[data-agent-id]")] as HTMLElement[]).find(
                    (element) =>
                      element.getAttribute("data-agent-id") === sel.routeAgentId &&
                      !element.closest(
                        `nav, article, [role='navigation'], [role='log'], [role='feed'], [role='article'], [data-message-id], ${sel.message}`
                      )
                  )
                : undefined;
              const composer = [...document.querySelectorAll(sel.composer)].find((element) =>
                isVisible(element as HTMLElement)
              ) as HTMLElement | undefined;
              const composerLabel =
                composer?.getAttribute("placeholder") ||
                composer?.getAttribute("aria-label") ||
                composer?.getAttribute("title") ||
                "";
              const isComposerInstruction = (value: string) =>
                /^.{1,160}?\s*(?:に|へ)メッセージを送信(?:してください|する)?$/u.test(value.trim()) ||
                /^(?:send a message to|message)\s+.{1,160}$/iu.test(value.trim());
              const composerRelated = (element: Element) =>
                !!composer &&
                (element === composer || element.contains(composer) || composer.contains(element));
              const identityCandidate = (element: Element) =>
                !composerRelated(element) &&
                !element.closest(
                  `nav, article, [role='navigation'], [role='log'], [role='feed'], [role='article'], [data-message-id], ${sel.message}`
                );
              const main = document.querySelector(sel.main) as HTMLElement | null;
              const normalizedExpectedName = sel.expectedDisplayName
                ?.normalize("NFKC")
                .trim()
                .toLocaleLowerCase();
              // Filling a contenteditable composer can temporarily remove or replace its
              // placeholder. During an assertion we already know the registered display
              // name, so an exact visible heading plus the stable route id remains two
              // independent identity signals without trusting arbitrary application text.
              const expectedHeading =
                sel.routeAgentId && normalizedExpectedName
                  ? ([...document.querySelectorAll(sel.heading)] as HTMLElement[]).find((element) => {
                      if (!isVisible(element) || !identityCandidate(element)) return false;
                      const heading = element.textContent?.normalize("NFKC").trim().toLocaleLowerCase();
                      return (
                        !!heading && !isComposerInstruction(heading) && heading === normalizedExpectedName
                      );
                    })
                  : undefined;
              const expectedVisibleName =
                sel.routeAgentId && normalizedExpectedName
                  ? (
                      [
                        ...document.querySelectorAll(
                          `${sel.heading}, button, [role="button"], [data-agent-name], [data-agent-id]`
                        )
                      ] as HTMLElement[]
                    ).find((element) => {
                      if (!isVisible(element) || !identityCandidate(element)) return false;
                      const text = element.textContent?.normalize("NFKC").trim().toLocaleLowerCase();
                      return !!text && !isComposerInstruction(text) && text === normalizedExpectedName;
                    })
                  : undefined;
              const corroboratedHeading =
                expectedHeading ??
                (sel.routeAgentId && composerLabel
                  ? ([...document.querySelectorAll(sel.heading)] as HTMLElement[]).find((element) => {
                      if (!isVisible(element) || !identityCandidate(element)) return false;
                      const heading = element.textContent?.trim();
                      return !!heading && !isComposerInstruction(heading) && composerLabel.includes(heading);
                    })
                  : undefined);
              const corroboratedLabel =
                sel.routeAgentId && !corroboratedHeading && composerLabel
                  ? ([...document.querySelectorAll(sel.label)] as HTMLElement[])
                      .filter((element) => {
                        if (!identityCandidate(element) || !isVisible(element)) return false;
                        const label = element.getAttribute("aria-label")?.trim() ?? "";
                        return (
                          label.length >= 3 &&
                          label.length <= 160 &&
                          !isComposerInstruction(label) &&
                          composerLabel.includes(label)
                        );
                      })
                      .sort(
                        (left, right) =>
                          (right.getAttribute("aria-label")?.trim().length ?? 0) -
                          (left.getAttribute("aria-label")?.trim().length ?? 0)
                      )[0]
                  : undefined;
              const corroboratedVisibleName =
                sel.routeAgentId && !corroboratedHeading && !corroboratedLabel && composerLabel && main
                  ? ([...main.querySelectorAll("*")] as HTMLElement[])
                      .filter((element) => {
                        if (!identityCandidate(element) || !isVisible(element)) return false;
                        const text = element.textContent?.trim() ?? "";
                        return (
                          text.length >= 3 &&
                          text.length <= 160 &&
                          !isComposerInstruction(text) &&
                          composerLabel.includes(text)
                        );
                      })
                      .sort(
                        (left, right) =>
                          (right.textContent?.trim().length ?? 0) - (left.textContent?.trim().length ?? 0)
                      )[0]
                  : undefined;
              const corroboratedIdentityRoot =
                corroboratedHeading ?? expectedVisibleName ?? corroboratedLabel ?? corroboratedVisibleName;
              // After submission M365 replaces the welcome heading with a message author
              // label. Read only the UI-owned header of the latest assistant article,
              // never response content, a nested article, or an older matching author.
              // Its name must also match the composer's independently rendered recipient.
              const normalizedComposerLabel = composerLabel.normalize("NFKC").trim().toLocaleLowerCase();
              const composerRecipient =
                /^(.+?)\s*(?:に|へ)メッセージを送信(?:してください|する)?$/u
                  .exec(normalizedComposerLabel)?.[1]
                  ?.trim() ??
                /^(?:send a message to|message)\s+(.+)$/iu.exec(normalizedComposerLabel)?.[1]?.trim();
              const latestAssistantArticle = sel.routeAgentId
                ? ([...document.querySelectorAll(sel.assistantArticle)] as HTMLElement[])
                    .filter(
                      (element) =>
                        !!main?.contains(element) &&
                        isVisible(element) &&
                        !element.parentElement?.closest(
                          `nav, [role='navigation'], article, [role='article'], ${sel.message}`
                        )
                    )
                    .at(-1)
                : undefined;
              const authorHeader = latestAssistantArticle?.firstElementChild;
              const authorLabel =
                authorHeader && !authorHeader.matches(sel.assistantContent)
                  ? ([...authorHeader.children] as HTMLElement[]).find(
                      (element) => element.matches(sel.assistantAuthor) && isVisible(element)
                    )
                  : undefined;
              const normalizedAuthor = authorLabel?.textContent?.normalize("NFKC").trim().toLocaleLowerCase();
              const corroboratedAuthor =
                normalizedAuthor &&
                !isComposerInstruction(normalizedAuthor) &&
                normalizedAuthor === composerRecipient &&
                (!normalizedExpectedName || normalizedAuthor === normalizedExpectedName)
                  ? authorLabel
                  : undefined;
              const routeRootText = routeRoot?.textContent?.trim() ?? "";
              const routeRootLabel = routeRoot?.getAttribute("aria-label");
              const routeRootName =
                routeRoot?.getAttribute("data-agent-name") ||
                (routeRootLabel && !isComposerInstruction(routeRootLabel) ? routeRootLabel : undefined) ||
                (routeRootText.length >= 3 &&
                routeRootText.length <= 160 &&
                !isComposerInstruction(routeRootText) &&
                composerLabel.includes(routeRootText)
                  ? routeRootText
                  : undefined);
              const genericRoot = document.querySelector(sel.root) as HTMLElement | null;
              // Current M365 pages can put data-agent-id on a large application shell.  Its
              // textContent contains the sidebar, chats, and agent page, so it is not a display
              // name. Prefer the independently corroborated heading/composer pair; on a direct
              // route, never fall back to arbitrary shell text.
              const root =
                corroboratedIdentityRoot ??
                corroboratedAuthor ??
                (routeRootName ? routeRoot : undefined) ??
                (!sel.routeAgentId ? genericRoot : undefined);
              const name =
                corroboratedHeading?.textContent?.trim() ||
                expectedVisibleName?.textContent?.trim() ||
                corroboratedLabel?.getAttribute("aria-label")?.trim() ||
                corroboratedVisibleName?.textContent?.trim() ||
                corroboratedAuthor?.textContent?.trim() ||
                routeRootName ||
                root?.getAttribute("data-agent-name") ||
                root?.getAttribute("aria-label") ||
                root?.textContent?.trim();
              const id =
                routeRoot?.getAttribute("data-agent-id") ||
                root?.getAttribute("data-agent-id") ||
                root?.getAttribute("data-application-id") ||
                (corroboratedIdentityRoot || corroboratedAuthor ? sel.routeAgentId : undefined) ||
                undefined;
              return {
                displayName: name || undefined,
                stableAgentId: id,
                surface: main?.getAttribute("data-surface") || undefined,
                evidence: [name ? "visible-name" : "", id ? "stable-id" : ""].filter(Boolean),
                composerLabel
              };
            },
            {
              root: IDENTITY_ROOT_SELECTOR,
              main: MAIN_REGION_SELECTOR,
              heading: IDENTITY_HEADING_SELECTOR,
              label: IDENTITY_LABEL_SELECTOR,
              composer: COMPOSER_SELECTORS.join(", "),
              message: `${USER_MESSAGE_SELECTORS}, ${ASSISTANT_MESSAGE_SELECTORS}`,
              assistantArticle: M365_ASSISTANT_ARTICLE_SELECTOR,
              assistantAuthor: M365_ASSISTANT_AUTHOR_SELECTOR,
              assistantContent: M365_ASSISTANT_CONTENT_SELECTOR,
              routeAgentId,
              expectedDisplayName
            }
          )
        : undefined;
    } catch {
      raw = undefined;
    }
    if (!raw?.displayName && !raw?.stableAgentId) return null;
    const rawDisplayName = typeof raw.displayName === "string" ? raw.displayName.trim() : undefined;
    const displayName =
      routeAgentId && rawDisplayName && isGenericCopilotName(rawDisplayName) ? undefined : rawDisplayName;
    const stableAgentId = typeof raw.stableAgentId === "string" ? raw.stableAgentId.trim() : undefined;
    const digest = identityDigest({ adapterId: this.id, surface: this.surface, displayName, stableAgentId });
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence.filter((item: unknown) => item !== "visible-name" || !!displayName)
      : [];
    if (displayName && !evidence.includes("visible-name")) evidence.push("visible-name");
    return {
      displayName,
      stableAgentId,
      surface: raw.surface || this.surface,
      digest,
      evidence
    };
  }
  async assertAgentIdentity(page: PageLike, expected: BrowserAgentVerification): Promise<IdentityAssertion> {
    return assertIdentity(page, expected, this.surface, (p) =>
      this.detectAgentIdentity(p, expected.expectedDisplayName)
    );
  }
  async findComposer(page: PageLike): Promise<LocatorLike> {
    if (!this.canSubmit) throw new Error("GENERIC_ADAPTER_CANNOT_SUBMIT");
    const candidates: LocatorLike[] = [];
    for (const selector of COMPOSER_SELECTORS) {
      const l = page.locator?.(selector);
      if (!l) continue;
      const count = (await l.count?.()) ?? 1;
      for (let i = 0; i < count; i++) {
        const item = count > 1 ? l.nth?.(i) : l;
        if (item && ((await item.isVisible?.()) ?? true) && ((await item.isEnabled?.()) ?? true))
          candidates.push(item);
      }
    }
    if (candidates.length !== 1)
      throw new BrowserTransportError(
        candidates.length ? "CHAT_INPUT_AMBIGUOUS" : "CHAT_INPUT_NOT_FOUND",
        candidates.length
          ? "More than one eligible chat composer was visible."
          : "No eligible chat composer was visible."
      );
    return candidates[0];
  }
  protected async findComposerSafe(page: PageLike): Promise<boolean> {
    try {
      await this.findComposer(page);
      return true;
    } catch {
      return false;
    }
  }
  async captureConversationMarker(page: PageLike): Promise<ConversationMarker> {
    const value = await this.markerData(page);
    return {
      id: value.id,
      userCount: value.userCount,
      assistantCount: value.assistantCount,
      digest: hash(JSON.stringify(value))
    };
  }
  async startNewConversation(page: PageLike): Promise<void> {
    const button = page.getByRole?.("button", {
      name: combinedPattern([...JA_TEXT.newChat, ...EN_TEXT.newChat])
    });
    if (!button || ((await button.count?.()) ?? 1) !== 1)
      throw new BrowserTransportError(
        "NEW_CONVERSATION_UNVERIFIED",
        "A unique new-conversation control was not available."
      );
    if (!((await button.isVisible?.()) ?? true) || !((await button.isEnabled?.()) ?? true) || !button.click)
      throw new BrowserTransportError(
        "NEW_CONVERSATION_UNVERIFIED",
        "The new-conversation control was not usable."
      );
    await button.click();
  }
  async verifyNewConversation(
    page: PageLike,
    before: ConversationMarker
  ): Promise<{ verified: boolean; reason?: string }> {
    const after = await this.captureConversationMarker(page);
    if (after.id && before.id && after.id !== before.id) return { verified: true };
    if (
      after.userCount === 0 &&
      after.assistantCount === 0 &&
      (before.userCount > 0 || before.assistantCount > 0)
    )
      return { verified: true };
    return { verified: false, reason: "fresh conversation postcondition was not observable" };
  }
  async captureSubmissionMarker(page: PageLike, verifiedIdentityDigest?: string): Promise<SubmissionMarker> {
    const marker = await this.captureConversationMarker(page);
    const identity = verifiedIdentityDigest ? undefined : await this.detectAgentIdentity(page);
    return {
      ...marker,
      url: page.url(),
      identityDigest: verifiedIdentityDigest || identity?.digest || "",
      composerValue: await this.composerValue(page),
      capturedAt: Date.now()
    };
  }
  async fillComposer(page: PageLike, message: string): Promise<void> {
    if (!this.canSubmit) throw new Error("GENERIC_ADAPTER_CANNOT_SUBMIT");
    const composer = await this.findComposer(page);
    const contentEditable = (await composer.getAttribute?.("contenteditable")) === "true";
    if (contentEditable && composer.pressSequentially && composer.press) {
      // M365's Lexical editor is controlled by keyboard/beforeinput handlers.
      // Playwright fill("") can desynchronise Lexical's internal state and make
      // the UI submit a literal <br>, so clear and type exclusively with keys.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!(await this.clearRichTextComposer(page, composer))) break;
        await composer.click?.();
        await composer.pressSequentially(message, { delay: this.typingDelayMs });
        if (await this.composerTextStayedExact(page, composer, message)) return;
        await this.clearRichTextComposer(page, composer);
        await delay(500, page);
      }
      throw new BrowserTransportError(
        "UI_CHANGED",
        "The rich-text composer did not retain the exact requested message.",
        undefined,
        { submissionState: "not-sent" }
      );
    }
    if (!composer.fill)
      throw new BrowserTransportError(
        "UI_CHANGED",
        "The verified composer cannot be filled safely.",
        undefined,
        { submissionState: "not-sent" }
      );
    await composer.fill(message);
  }
  async clearComposer(page: PageLike): Promise<void> {
    try {
      const composer = await this.findComposer(page);
      const contentEditable = (await composer.getAttribute?.("contenteditable")) === "true";
      if (contentEditable && composer.press) await this.clearRichTextComposer(page, composer);
      else await composer.fill?.("");
    } catch {
      /* best effort: do not submit */
    }
  }
  async submitComposer(page: PageLike): Promise<void> {
    if (!this.canSubmit) throw new Error("GENERIC_ADAPTER_CANNOT_SUBMIT");
    const deadline = Date.now() + 2_000;
    let candidates: LocatorLike[];
    do {
      const accessible = page.getByRole?.("button", {
        name: combinedPattern([...JA_TEXT.send, ...EN_TEXT.send])
      });
      const accessibleCandidates = await usableCandidates(accessible);
      if (accessibleCandidates.length > 1) {
        throw new BrowserTransportError(
          "UI_CHANGED",
          "A unique enabled send control was not available.",
          undefined,
          { submissionState: "not-sent" }
        );
      }
      const structuralCandidates =
        accessibleCandidates.length === 0
          ? await usableCandidates(page.locator?.(SEND_SELECTORS.join(", ")))
          : [];
      candidates = accessibleCandidates.length ? accessibleCandidates : structuralCandidates;
      if (candidates.length === 1 || candidates.length > 1 || Date.now() >= deadline) break;
      await page.waitForTimeout?.(100);
    } while (Date.now() < deadline);
    const send = candidates[0];
    if (candidates.length !== 1 || !send?.click) {
      const sendDiagnostics = await this.sendControlDiagnostics(page);
      throw new BrowserTransportError(
        "UI_CHANGED",
        `A unique enabled send control was not available. Visible nearby controls=${JSON.stringify(sendDiagnostics)}.`,
        undefined,
        { submissionState: "not-sent", sendDiagnostics }
      );
    }
    try {
      await send.click();
    } catch {
      throw new BrowserTransportError(
        "SUBMIT_STATE_UNKNOWN",
        "The send control was activated, but submission acknowledgement could not be established.",
        "Inspect the existing conversation before deciding whether to send again.",
        { submissionState: "unknown" }
      );
    }
  }
  async waitForUserMessageAck(
    page: PageLike,
    marker: SubmissionMarker,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<SubmissionAck> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (signal?.aborted)
        return { state: "unknown", reason: "cancelled while waiting for submission acknowledgement" };
      const now = await this.captureConversationMarker(page);
      if (now.userCount === marker.userCount + 1) {
        const latest = await this.latestUserMessage(page);
        if (latest !== undefined && normalizeMessage(latest) === normalizeMessage(marker.composerValue))
          return { state: "sent" };
        return {
          state: "unknown",
          reason: "a new user message appeared but its content could not be correlated"
        };
      }
      if (now.userCount > marker.userCount + 1)
        return { state: "unknown", reason: "more than one new user message observed" };
      await delay(100, page);
    }
    // The send control was already activated by the time this wait started, so a timeout is not
    // evidence that nothing was sent: Microsoft 365 may simply not have rendered the user message
    // yet. Only a positive not-sent signal -- the composer still holding the exact text that was
    // submitted -- may report "not-sent"; everything else is "unknown" and is never retried.
    const now = await this.captureConversationMarker(page);
    if (now.userCount > marker.userCount)
      return { state: "unknown", reason: "acknowledgement timeout after the send control was activated" };
    if (marker.composerValue) {
      const composerNow = await this.composerValue(page);
      if (normalizeMessage(composerNow) === normalizeMessage(marker.composerValue))
        return { state: "not-sent", reason: "the composer still holds the submitted text unchanged" };
    }
    return { state: "unknown", reason: "acknowledgement timeout after the send control was activated" };
  }
  async waitForResponseStart(
    page: PageLike,
    marker: SubmissionMarker,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ResponseMarker> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (signal?.aborted)
        throw new BrowserTransportError(
          "RESPONSE_TIMEOUT",
          "Waiting was cancelled after the message was submitted.",
          undefined,
          { submissionState: "sent" }
        );
      const now = await this.captureConversationMarker(page);
      if (now.assistantCount > marker.assistantCount)
        return { assistantCount: now.assistantCount, digest: now.digest };
      await delay(100, page);
    }
    throw new BrowserTransportError(
      "RESPONSE_TIMEOUT",
      "The Microsoft 365 agent response did not start before the timeout.",
      undefined,
      { submissionState: "sent" }
    );
  }
  async waitForResponseComplete(
    page: PageLike,
    marker: ResponseMarker,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    return this.completion.wait(page, marker, timeoutMs, signal);
  }
  async extractLatestResponse(page: PageLike, marker: ResponseMarker): Promise<ExtractedResponse> {
    return this.extractor.extract(page, marker, this.surface);
  }
  protected async markerData(
    page: PageLike
  ): Promise<{ id?: string; userCount: number; assistantCount: number }> {
    try {
      if (page.evaluate) {
        const marker = await page.evaluate<{
          id?: string;
          userCount: number;
          assistantCount: number;
        }>(
          (sel: { user: string; assistant: string; conversation: string }) => {
            const all = (s: string) => Array.from(document.querySelectorAll(s));
            const users = all(sel.user);
            const assistants = all(sel.assistant);
            const root = document.querySelector(sel.conversation) as HTMLElement | null;
            return {
              id:
                root?.getAttribute("data-conversation-id") ||
                root?.getAttribute("data-thread-id") ||
                undefined,
              userCount: users.length,
              assistantCount: assistants.length
            };
          },
          {
            user: USER_MESSAGE_SELECTORS,
            assistant: ASSISTANT_MESSAGE_SELECTORS,
            conversation: CONVERSATION_ID_SELECTOR
          }
        );
        return { ...marker, id: marker.id ?? conversationIdFromUrl(page.url()) };
      }
    } catch {
      /* fallback */
    }
    const body = (await page.locator?.("body")?.textContent?.()) ?? "";
    return { id: conversationIdFromUrl(page.url()), userCount: 0, assistantCount: body ? 1 : 0 };
  }
  private async composerValue(page: PageLike): Promise<string> {
    try {
      const composer = await this.findComposer(page);
      try {
        const value = await composer.inputValue?.();
        if (value !== undefined) return value;
      } catch {
        /* contenteditable */
      }
      return (await composer.textContent?.()) ?? "";
    } catch {
      return "";
    }
  }
  private async latestUserMessage(page: PageLike): Promise<string | undefined> {
    try {
      if (page.evaluate)
        return await page.evaluate((selector: string) => {
          const nodes = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
          const latest = nodes.at(-1);
          const output = latest?.querySelector('[data-testid="chatOutput"]') as HTMLElement | null;
          return output?.innerText ?? latest?.innerText;
        }, USER_MESSAGE_SELECTORS);
    } catch {
      /* fail closed */
    }
    return undefined;
  }

  private async clearRichTextComposer(page: PageLike, composer: LocatorLike): Promise<boolean> {
    const current = normalizeComposerText((await composer.textContent?.()) ?? "");
    if (!current) return true;
    if (!composer.press) return false;
    await composer.click?.();
    await composer.press("ControlOrMeta+A");
    await composer.press("Backspace");
    const deadline = Date.now() + 1_000;
    do {
      if (!normalizeComposerText((await composer.textContent?.()) ?? "")) return true;
      await delay(50, page);
    } while (Date.now() < deadline);
    return false;
  }

  private async composerTextStayedExact(
    page: PageLike,
    composer: LocatorLike,
    expected: string
  ): Promise<boolean> {
    const expectedText = normalizeComposerText(expected);
    const appearedBy = Date.now() + 750;
    while (Date.now() < appearedBy) {
      if (normalizeComposerText((await composer.textContent?.()) ?? "") === expectedText) break;
      await delay(50, page);
    }
    if (normalizeComposerText((await composer.textContent?.()) ?? "") !== expectedText) return false;
    const stableUntil = Date.now() + this.composerStabilityWindowMs;
    while (Date.now() < stableUntil) {
      await delay(Math.min(250, Math.max(1, stableUntil - Date.now())), page);
      if (normalizeComposerText((await composer.textContent?.()) ?? "") !== expectedText) return false;
    }
    return true;
  }
  protected responseSelectors = RESPONSE_SELECTORS;

  /**
   * Metadata-only description of the composer's surroundings, used when no unique send control can
   * be found. It reports structure (tags, roles, accessible labels, class names) so a UI change can
   * be diagnosed, and deliberately carries no composer text, HTML or value: that content is the
   * user's prompt. Public so security tests can assert the shape directly.
   */
  async sendControlDiagnostics(page: PageLike): Promise<unknown> {
    try {
      if (!page.evaluate) return {};
      return await page.evaluate((composerSelector: string) => {
        const visible = (element: HTMLElement) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
          );
        };
        const composer = [...document.querySelectorAll(composerSelector)].find((element) =>
          visible(element as HTMLElement)
        ) as HTMLElement | undefined;
        const root =
          composer?.closest("form") ??
          composer?.parentElement?.parentElement?.parentElement ??
          document.querySelector("main, [role=main]");
        return {
          composer: composer
            ? {
                tag: composer.tagName.toLowerCase(),
                role: composer.getAttribute("role"),
                contentEditable: composer.getAttribute("contenteditable"),
                ariaLabel: composer.getAttribute("aria-label"),
                placeholder: composer.getAttribute("placeholder"),
                // Structure only. The composer's text/HTML/value is the prompt the user typed and
                // must never reach an error message, an incident, or a copied diagnostic.
                className: (composer.getAttribute("class") ?? "").slice(0, 160)
              }
            : null,
          controls: [...(root?.querySelectorAll("button, [role=button]") ?? [])]
            .filter((element) => visible(element as HTMLElement))
            .slice(0, 20)
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              ariaLabel: element.getAttribute("aria-label"),
              title: element.getAttribute("title"),
              type: element.getAttribute("type"),
              testId: element.getAttribute("data-testid"),
              iconName: element.getAttribute("data-icon-name"),
              disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
              className: (element.getAttribute("class") ?? "").slice(0, 160)
            }))
        };
      }, COMPOSER_SELECTORS.join(", "));
    } catch {
      return {};
    }
  }
}

function conversationIdFromUrl(value: string): string | undefined {
  try {
    const match = /\/conversation\/([^/]+)\/?$/i.exec(new URL(value).pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}
export function directAgentNameFromComposerLabel(value: string): string | undefined {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return undefined;
  const japanese = /^(.{1,160}?)\s*(?:に|へ)メッセージを送信(?:してください|する)?$/u.exec(normalized)?.[1];
  const english = /^(?:send a message to|message)\s+(.{1,160})$/iu.exec(normalized)?.[1];
  const candidate = (japanese ?? english)?.trim();
  return candidate && !isGenericCopilotName(candidate) ? candidate : undefined;
}
function isGenericCopilotName(value: string): boolean {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  return ["copilot", "microsoft copilot", "microsoft 365 copilot"].includes(normalized);
}
async function usableCandidates(locator: LocatorLike | undefined): Promise<LocatorLike[]> {
  if (!locator) return [];
  const count = (await locator.count?.()) ?? 1;
  const candidates: LocatorLike[] = [];
  for (let index = 0; index < count; index++) {
    const candidate = count > 1 ? locator.nth?.(index) : locator;
    if (candidate && ((await candidate.isVisible?.()) ?? true) && ((await candidate.isEnabled?.()) ?? true))
      candidates.push(candidate);
  }
  return candidates;
}
function normalizeMessage(value: string): string {
  return normalizeComposerText(value).replace(/\s+/g, " ");
}
function normalizeComposerText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .trim();
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
async function delay(ms: number, page: PageLike): Promise<void> {
  if (page.waitForTimeout) await page.waitForTimeout(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}
