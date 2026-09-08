import type {
  BrowserAgentVerification,
  CompletionResult,
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
  fillComposer(page: PageLike, message: string): Promise<void>;
  clearComposer(page: PageLike): Promise<void>;
  submitComposer(page: PageLike): Promise<void>;
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
  waitForResponseComplete(
    page: PageLike,
    marker: ResponseMarker,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<CompletionResult>;
  extractLatestResponse(page: PageLike, marker: ResponseMarker): Promise<ExtractedResponse>;
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
