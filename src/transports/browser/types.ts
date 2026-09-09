/** Small, dependency-free browser contracts.  The broker can adapt these to
 * Playwright without allowing Playwright objects to escape the transport.
 *
 * Domain- and transport-boundary-shaped types are imported from
 * src/domain/agent.ts, src/domain/response.ts and src/transports/transport.ts
 * rather than redeclared here, so there is exactly one definition of each.
 * Only the Playwright-isolation layer (PageLike/LocatorLike/BrowserContextLike)
 * and the marker/extraction types that are private to the browser transport's
 * internal bookkeeping are defined in this module. */
import type { BrowserAgentDefinition } from "../../domain/agent.js";
import type { ErrorCode } from "../../domain/errors.js";
import type { ProgressSink } from "../../domain/progress.js";

export type { AgentKind, BrowserAgentDefinition } from "../../domain/agent.js";
export type { InvocationContext, TransportHealth, ValidationResult } from "../transport.js";
export type { AgentResponse } from "../../domain/response.js";

export type AuthState =
  "authenticated" | "sign-in-required" | "interactive-auth" | "access-denied" | "unknown";
export type Surface = "m365-copilot" | "teams-web";

export type BrowserAgentVerification = BrowserAgentDefinition["verification"];

export interface PageLike {
  url(): string;
  goto?(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  locator?(selector: string): LocatorLike;
  getByRole?(role: string, options?: { name?: string | RegExp; exact?: boolean }): LocatorLike;
  getByText?(text: string | RegExp, options?: { exact?: boolean }): LocatorLike;
  evaluate?<T>(fn: unknown, arg?: unknown): Promise<T>;
  waitForTimeout?(ms: number): Promise<void>;
  waitForEvent?(event: "download", options?: { timeout?: number }): Promise<BrowserDownloadLike>;
  on?(event: string, listener: (...args: any[]) => void): void;
  off?(event: string, listener: (...args: any[]) => void): void;
  isClosed?(): boolean;
  close?(): Promise<void>;
  mainFrame?(): unknown;
  context?(): BrowserRequestContextLike;
  /** Playwright frames are evaluation-capable document scopes. M365 renders Office previews in
   * a child frame, so attachment discovery must inspect these scopes without assuming same-origin
   * DOM access from the top-level page. */
  frames?(): BrowserDocumentLike[];
}
export interface BrowserDocumentLike {
  url(): string;
  evaluate?<T>(fn: unknown, arg?: unknown): Promise<T>;
}
export interface ApiResponseLike {
  ok(): boolean;
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
  /** Playwright APIResponse exposes the final URL after redirects. */
  url?(): string;
}
export interface ApiRequestLike {
  get(
    url: string,
    options?: { timeout?: number; failOnStatusCode?: boolean; maxRedirects?: number }
  ): Promise<ApiResponseLike>;
}
export interface BrowserRequestContextLike {
  request: ApiRequestLike;
  /** Available on Playwright BrowserContext. Attachment saving uses a short-lived page only to
   * establish passive SSO cookies on an allowlisted file host before one HTTP retry. */
  newPage?(): Promise<PageLike>;
  pages?(): PageLike[];
}
export interface BrowserDownloadLike {
  url(): string;
  suggestedFilename(): string;
  path(): Promise<string | null>;
  failure?(): Promise<string | null>;
  cancel?(): Promise<void>;
}
export interface LocatorLike {
  count?(): Promise<number>;
  first?(): LocatorLike;
  nth?(index: number): LocatorLike;
  isVisible?(): Promise<boolean>;
  isEnabled?(): Promise<boolean>;
  inputValue?(): Promise<string>;
  fill?(value: string): Promise<void>;
  pressSequentially?(text: string, options?: { delay?: number }): Promise<void>;
  press?(key: string, options?: { timeout?: number }): Promise<void>;
  click?(options?: { timeout?: number }): Promise<void>;
  textContent?(): Promise<string | null>;
  getAttribute?(name: string): Promise<string | null>;
  locator?(selector: string): LocatorLike;
  allTextContents?(): Promise<string[]>;
}

export interface BrowserContextLike {
  pages(): PageLike[];
  newPage?(): Promise<PageLike>;
  close(): Promise<void>;
  on?(event: string, cb: (...args: any[]) => void): void;
  /** Optional native-background handoff. Resolves only after login pages are retired and the
   * same browser is ready for automation with the configured visibility/download policy. */
  completeInteractiveLogin?(): Promise<void>;
}
export interface PageHandle {
  key: string;
  page: PageLike;
}

export interface ConversationMarker {
  id?: string;
  userCount: number;
  assistantCount: number;
  digest?: string;
}
export interface SubmissionMarker extends ConversationMarker {
  url: string;
  identityDigest: string;
  composerValue: string;
  capturedAt: number;
}
export interface ResponseMarker {
  assistantCount: number;
  responseId?: string;
  digest?: string;
}
export type SubmissionState = "not-sent" | "sent" | "unknown";
export interface SubmissionAck {
  state: SubmissionState;
  reason?: string;
}
export interface CompletionResult {
  complete: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  partial?: string;
  /** Why the wait ended. Metadata only; every field below is a count or a flag, never page text.
   * Optional so any other CompletionResult producer (a test fixture, a future adapter) keeps
   * compiling. */
  reason?: "stable" | "timeout" | "cancelled";
  /** True when a stop-generating control or a streaming attribute was seen at least once. */
  sawStreamingSignal?: boolean;
  /** Length of the last observed response text. The text itself never leaves the page. */
  finalChars?: number;
}
export interface ExtractedResponse {
  text: string;
  citations: AgentCitation[];
  attachmentCandidates?: AttachmentCandidate[];
  actionRequired: boolean;
  truncated: boolean;
}
export interface AttachmentCandidate {
  index: number;
  name: string;
  /** Original name found next to the selected control; `name` still identifies that control. */
  sourceFilename?: string;
  url?: string;
  downloadControlIndex?: number;
  fileCardIndex?: number;
}
export interface AgentCitation {
  index?: number;
  marker?: string;
  title?: string;
  url?: string;
  source?: string;
}
export interface UiFingerprint {
  adapterId: string;
  hasMainRegion: boolean;
  hasComposer: boolean;
  hasSendButton: boolean;
  hasConversationRegion: boolean;
  identitySignalCount: number;
}

/** The browser transport's own internal page-conversation bookkeeping. This is
 * deliberately a distinct shape (and name) from transport.ts's TransportConversation
 * (which is the public AgentTransport-boundary value): this one additionally
 * tracks the binding fingerprint, agent alias, and lifecycle state that only
 * the browser transport itself needs between createConversation() and invoke(). */
export interface BrowserPageConversation {
  handle: string;
  agentAlias: string;
  bindingFingerprint: string;
  pageKey: string;
  state: string;
}

/** The request shape ConversationDriver actually consumes: it always carries a
 * resolved timeoutMs, unlike transport.ts's public AgentInvokeRequest (where
 * BrowserTransport applies its own configured responseTimeoutMs before
 * delegating). Kept distinct from that public shape for the same reason. */
export interface BrowserInvokeRequest {
  message: string;
  requestId?: string;
  workspaceKey?: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Metadata-only progress sink (see src/domain/progress.ts). Never carries message text. */
  onProgress?: ProgressSink;
}

export class BrowserTransportError extends Error {
  readonly code: ErrorCode;
  readonly remediation?: string;
  /** Not `readonly`: a caller with a page in scope (see BrowserTransport.attachFingerprint) may
   * enrich an already-constructed error with a best-effort UI fingerprint before it is mapped to
   * a DomainError, without needing to reconstruct the error from scratch. */
  details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, remediation?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BrowserTransportError";
    this.code = code;
    this.remediation = remediation;
    this.details = details;
  }
}
