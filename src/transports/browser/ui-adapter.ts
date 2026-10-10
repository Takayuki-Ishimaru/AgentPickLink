import type {
  BrowserAgentVerification,
  CompletionResult,
  ConversationExchange,
  ConversationMarker,
  ExtractedResponse,
  LocatorLike,
  PageLike,
  ResponseMarker,
  SubmissionAck,
  SubmissionMarker,
  AuthState,
  UiFingerprint
} from "./types.js";

export interface AdapterMatch {
  matched: boolean;
  confidence: "strong" | "weak" | "none";
  reason?: string;
}
export interface DetectedAgentIdentity {
  displayName?: string;
  stableAgentId?: string;
  surface?: string;
  digest: string;
  evidence: string[];
}
export interface IdentityAssertion {
  valid: boolean;
  identity?: DetectedAgentIdentity;
  code?: "AGENT_IDENTITY_UNVERIFIED" | "AGENT_IDENTITY_MISMATCH" | "AGENT_CONTEXT_CHANGED";
}
/** What a submission must still match when the send control is pressed (see activateSendControl). */
export interface SubmitGuard {
  /** The requested message, which the composer must still hold. */
  message: string;
  /** The submission marker captured when the message was verified, with its page context. */
  marker: SubmissionMarker;
  /** Verifies again the agent identity, page address, conversation and composer text that were
   * verified before submission. Rejects with a BrowserTransportError when any changed. */
  verifyBeforePress(): Promise<void>;
}
export interface ChatUiAdapter {
  readonly id: string;
  readonly canSubmit: boolean;
  canHandle(page: PageLike): Promise<AdapterMatch>;
  detectAuthState(page: PageLike): Promise<AuthState>;
  detectAgentIdentity(page: PageLike): Promise<DetectedAgentIdentity | null>;
  assertAgentIdentity(page: PageLike, expected: BrowserAgentVerification): Promise<IdentityAssertion>;
  findComposer(page: PageLike): Promise<LocatorLike>;
  captureConversationMarker(page: PageLike): Promise<ConversationMarker>;
  startNewConversation(page: PageLike): Promise<void>;
  verifyNewConversation(
    page: PageLike,
    before: ConversationMarker
  ): Promise<{ verified: boolean; reason?: string }>;
  captureSubmissionMarker(page: PageLike, verifiedIdentityDigest?: string): Promise<SubmissionMarker>;
  fillComposer(page: PageLike, message: string, signal?: AbortSignal): Promise<void>;
  clearComposer(page: PageLike): Promise<void>;
  submitComposer(page: PageLike, signal?: AbortSignal, guard?: SubmitGuard): Promise<void>;
  waitForUserMessageAck(
    page: PageLike,
    marker: SubmissionMarker,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<SubmissionAck>;
  waitForResponseStart(
    page: PageLike,
    marker: SubmissionMarker,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ResponseMarker>;
  /** `onSettling` is called once per quiet period -- when the same response text has been seen on
   * two polls in a row with nothing generating, never on the poll where the text changed -- so the
   * caller can say it is confirming the answer. */
  waitForResponseComplete(
    page: PageLike,
    marker: ResponseMarker,
    timeoutMs: number,
    signal?: AbortSignal,
    onSettling?: () => void
  ): Promise<CompletionResult>;
  extractLatestResponse(page: PageLike, marker: ResponseMarker): Promise<ExtractedResponse>;
  /** The conversation's latest exchange, for reading it without sending anything. Optional so a
   * hand-built test double stays a valid adapter; every real adapter (BaseChatUiAdapter) has it. */
  captureExchange?(page: PageLike): Promise<ConversationExchange>;
  /** Best-effort, metadata-only structural snapshot (which regions/controls were detected -- see
   * UiFingerprint), used to enrich a UI-drift incident so it can be diagnosed without reading DOM
   * text. Optional so a hand-built test double that does not need it stays a valid ChatUiAdapter;
   * every real adapter (via BaseChatUiAdapter) implements it. */
  captureUiFingerprint?(
    page: PageLike,
    hasComposer?: boolean,
    identitySignalCount?: number
  ): Promise<UiFingerprint>;
}
