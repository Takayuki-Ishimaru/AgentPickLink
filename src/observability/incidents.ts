import type { ErrorCode } from "../domain/errors.js";

/** Structural copy of src/transports/browser/types.ts's `UiFingerprint`. Re-declared rather than
 * imported so this observability module never depends on the browser transport layer (which
 * transitively imports playwright-core): the two shapes are kept in sync by inspection, the same
 * discipline src/services/setup-service.ts already uses for its own duplicated browser-shaped
 * types. Metadata only -- structural booleans and a count, never DOM text. */
export type IncidentUiFingerprint = {
  adapterId: string;
  hasMainRegion: boolean;
  hasComposer: boolean;
  hasSendButton: boolean;
  hasConversationRegion: boolean;
  identitySignalCount: number;
};

/** Metadata-only description of why a response wait ended (see CompletionResult in
 * src/transports/browser/types.ts): a reason tag, whether any streaming signal was ever observed,
 * and the length of the last observed text. Never the response text itself. */
export type IncidentCompletion = {
  reason: string;
  sawStreamingSignal: boolean;
  finalChars: number;
};

/** Metadata-only description of the browser a transport launches (see TransportBrowserDescription
 * in src/transports/transport.ts): channel, headless flag, and viewport size. Never a profile
 * path, a hostname, or page content. */
export type IncidentBrowser = {
  channel: string;
  headless: boolean;
  viewport: { width: number; height: number };
};

/**
 * A single, metadata-only record of a broker-side incident (see docs/ux-redesign.md §2.2 item 7).
 * `message` is the DomainError's own message text, never prompt/response content -- callers that
 * record an incident from a caught error must never pass along user-authored text. The optional
 * fields below are the same discipline applied to richer diagnostics: `fingerprint` is structure
 * (which regions/controls were detected), `hosts` is hostnames only (never a path or query),
 * `completion` is counts/flags about a response wait, and `browser` describes what was launched.
 */
export type Incident = {
  at: string;
  code: ErrorCode;
  phase?: string;
  adapterId?: string;
  message: string;
  fingerprint?: IncidentUiFingerprint;
  /** Hostnames only (never a URL with a path or query), bounded to 8 entries by `record()`. */
  hosts?: string[];
  completion?: IncidentCompletion;
  browser?: IncidentBrowser;
};

/** A bare hostname: letters, digits, dots and hyphens only -- never a scheme, path, query, or
 * port. Used by `IncidentLog.record` to strip anything that is not plainly a hostname before it
 * is ever held in memory. */
const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/i;
/** Upper bound on how many hostnames one incident may carry. */
const MAX_INCIDENT_HOSTS = 8;

/** The subset of `Incident` fields that can be attached to an in-flight error before it becomes an
 * incident record (see attachDiagnostics/diagnosticsOf below). Typed as a precise partial, rather
 * than a bare `Record<string, unknown>`, so a caller building an `Omit<Incident, "at">` by
 * spreading this in gets a structurally sound object, not an index-signature escape hatch. */
export type IncidentDiagnostics = Partial<Pick<Incident, "fingerprint" | "hosts" | "completion">>;

/**
 * Attaches metadata-only diagnostics (fingerprint/hosts/completion) to a `DomainError` instance
 * without adding a field to `DomainError.options` (src/domain/errors.ts is not owned by this
 * layer). Keyed by object identity via a `WeakMap`, so the diagnostics are garbage-collected along
 * with the error and never leak into `DomainError.toResult()`'s wire shape -- they exist purely
 * for `InvocationService`/`BrokerServer` to read back when recording an incident.
 */
const diagnosticsByError = new WeakMap<object, IncidentDiagnostics>();

/** Records (or merges into) the diagnostics held for `error`. Never throws. */
export function attachDiagnostics(error: object, diagnostics: IncidentDiagnostics): void {
  if (!diagnostics || !Object.keys(diagnostics).length) return;
  diagnosticsByError.set(error, { ...diagnosticsByError.get(error), ...diagnostics });
}

/** Reads back whatever diagnostics `attachDiagnostics` recorded for `error`, if any. */
export function diagnosticsOf(error: unknown): IncidentDiagnostics | undefined {
  if (!error || typeof error !== "object") return undefined;
  return diagnosticsByError.get(error);
}

/** Error codes that indicate the kind of drift/failure worth surfacing as an incident (UI
 * structure changes, identity mismatches, auth failures, browser crashes/start failures,
 * extraction failures, and response timeouts) rather than every possible ErrorCode.
 * RESPONSE_TIMEOUT carries its own `completion` diagnostic (see IncidentCompletion above,
 * populated in src/transports/browser/conversation-driver.ts) describing why the wait ended
 * without ever including the response text itself. */
export const INCIDENT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "UI_CHANGED",
  "UNSUPPORTED_UI",
  "CHAT_INPUT_NOT_FOUND",
  "CHAT_INPUT_AMBIGUOUS",
  "NEW_CONVERSATION_UNVERIFIED",
  "AGENT_IDENTITY_UNVERIFIED",
  "AGENT_IDENTITY_MISMATCH",
  "AGENT_CONTEXT_CHANGED",
  "AUTH_REQUIRED",
  "AUTH_FAILED",
  "BROWSER_CRASHED",
  "BROWSER_START_FAILED",
  "RESPONSE_EXTRACTION_FAILED",
  "RESPONSE_TIMEOUT"
]);

export function isIncidentCode(code: ErrorCode): boolean {
  return INCIDENT_CODES.has(code);
}

/** The subset of incident codes that indicate the Microsoft 365 page structure differs from what
 * this version expects (and therefore warrants the "check with the developer" banner). Sign-in and
 * browser-process failures are incidents too, but they are operational, not UI drift. */
export const UI_DRIFT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "UI_CHANGED",
  "UNSUPPORTED_UI",
  "CHAT_INPUT_NOT_FOUND",
  "CHAT_INPUT_AMBIGUOUS",
  "NEW_CONVERSATION_UNVERIFIED",
  "AGENT_IDENTITY_UNVERIFIED",
  "AGENT_IDENTITY_MISMATCH",
  "AGENT_CONTEXT_CHANGED",
  "RESPONSE_EXTRACTION_FAILED"
]);

export function isUiDriftCode(code: ErrorCode): boolean {
  return UI_DRIFT_CODES.has(code);
}

/**
 * A bounded, in-memory, metadata-only log of recent incidents, owned by BrokerServer and
 * surfaced through `broker.health` (see src/broker/broker-server.ts) so the VS Code panel/CLI can
 * show a "Microsoft 365 UI changed" warning (or similar) without a browser round trip. Never
 * persisted to disk and never holds prompt/response text -- only what DomainError already
 * exposes (code, message, and call-site metadata).
 */
export class IncidentLog {
  private readonly entries: Incident[] = [];

  constructor(private readonly max = 20) {}

  /** Appends one incident, stamping `at` with the current time, and drops the oldest entries
   * once more than `max` are held (a simple ring buffer, not a persistent history). `hosts` is
   * clamped to at most `MAX_INCIDENT_HOSTS` entries and anything that is not a plain hostname
   * (see HOSTNAME_PATTERN) is stripped, so a malformed or over-long value can never reach the
   * in-memory log or `broker.health`. */
  record(incident: Omit<Incident, "at">): void {
    const entry: Incident = { ...incident, at: new Date().toISOString() };
    if (entry.hosts)
      entry.hosts = entry.hosts.filter((host) => HOSTNAME_PATTERN.test(host)).slice(0, MAX_INCIDENT_HOSTS);
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  /** A defensive copy, oldest first, so callers can never mutate the log's internal state. */
  list(): Incident[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}
