/**
 * Metadata-only records of the browser transport's turn-correlation decisions.
 *
 * A record carries counts and 16-hex-character hashes of message anchors and nothing else: never
 * message, prompt or response text, never a raw DOM identifier, URL, cookie or credential. Values
 * reaching this module from outside it (a transport's `healthCheck()`, an older broker's JSON) are
 * untrusted, so every entry passes through the same whitelist before it is stored or reported.
 * Nothing here logs to the console.
 */

/** One correlation decision: `phase` is the operation that asked for it, `decision` the reported
 * submission state, `reason` a tag from {@link CORRELATION_REASON_TAGS}. */
export type CorrelationDiagnostic = {
  /** ISO timestamp, stamped by the log; a caller never supplies it. */
  at: string;
  phase: "invoke" | "read";
  decision: "shown" | "differs" | "not-shown" | "unconfirmed" | "none" | "unreadable";
  /** Restricted at runtime to the static tags below; unknown values become `unknown-reason`. */
  reason: string;
  usersBefore: number | null;
  usersNow: number;
  baselineTail: string | null;
  latestUser: string | null;
  user: string | null;
  response: string | null;
  requestHash?: string;
};

/** The only reason tags that ever leave this module; anything else is reported as
 * `unknown-reason`. Keep in step with `correlateTurn()` and the driver's own reasons. */
export const CORRELATION_REASON_TAGS = [
  "missing-baseline",
  "ambiguous-anchors",
  "document-changed",
  "confirmed-user-missing",
  "empty-baseline-ambiguous",
  "empty-baseline-unverified",
  "baseline-tail-missing",
  "baseline-reordered",
  "no-unique-appended-user",
  "confirmed-user-anchor",
  "appended-after-tail",
  "unstable-message-identity",
  "response-reassigned"
] as const;

/** Stand-in for any reason this build does not know, so an unexpected string never reaches output. */
export const UNKNOWN_CORRELATION_REASON = "unknown-reason";

/** Entries a log keeps, and entries one report may carry, whichever list is longer. */
export const CORRELATION_DIAGNOSTIC_LIMIT = 20;

const REASON_TAGS: ReadonlySet<string> = new Set<string>([
  ...CORRELATION_REASON_TAGS,
  UNKNOWN_CORRELATION_REASON
]);
const PHASES: readonly string[] = ["invoke", "read"];
const DECISIONS: readonly string[] = ["shown", "differs", "not-shown", "unconfirmed", "none", "unreadable"];
const HASH_PATTERN = /^[0-9a-f]{16}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const INVALID = Symbol("invalid");

/** A hash, or `null`/`undefined` where the field allows it; anything else is {@link INVALID}. */
function hashField(value: unknown, nullable: boolean): unknown {
  if (value === undefined) return nullable ? null : undefined;
  if (value === null) return nullable ? null : INVALID;
  return typeof value === "string" && HASH_PATTERN.test(value) ? value : INVALID;
}

/** A non-negative safe-integer count, or `null` where the field allows it. */
function countField(value: unknown, nullable: boolean): unknown {
  if (value === null) return nullable ? null : INVALID;
  if (value === undefined) return nullable ? null : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : INVALID;
}

/** Whitelists and validates one untrusted entry, returning a fresh object or `undefined`. */
function normalize(input: unknown, stamped: string | undefined): CorrelationDiagnostic | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const entry = input as Record<string, unknown>;
  if (!PHASES.includes(entry.phase as string) || !DECISIONS.includes(entry.decision as string))
    return undefined;
  const reason =
    typeof entry.reason === "string" && REASON_TAGS.has(entry.reason)
      ? entry.reason
      : UNKNOWN_CORRELATION_REASON;
  const usersBefore = countField(entry.usersBefore, true);
  const usersNow = countField(entry.usersNow, false);
  const baselineTail = hashField(entry.baselineTail, true);
  const latestUser = hashField(entry.latestUser, true);
  const user = hashField(entry.user, true);
  const response = hashField(entry.response, true);
  const requestHash = hashField(entry.requestHash, false);
  if (
    typeof usersNow !== "number" ||
    usersBefore === INVALID ||
    baselineTail === INVALID ||
    latestUser === INVALID ||
    user === INVALID ||
    response === INVALID ||
    requestHash === INVALID
  )
    return undefined;
  const reported =
    typeof entry.at === "string" && ISO_PATTERN.test(entry.at) && Number.isFinite(Date.parse(entry.at))
      ? entry.at
      : undefined;
  const at = stamped ?? reported;
  if (at === undefined) return undefined;
  return {
    at,
    phase: entry.phase as CorrelationDiagnostic["phase"],
    decision: entry.decision as CorrelationDiagnostic["decision"],
    reason,
    usersBefore: usersBefore as number | null,
    usersNow,
    baselineTail: baselineTail as string | null,
    latestUser: latestUser as string | null,
    user: user as string | null,
    response: response as string | null,
    ...(requestHash !== undefined ? { requestHash: requestHash as string } : {})
  };
}

/** Two observations of the same request and phase that differ in nothing but their timestamp. */
function isRepeat(previous: CorrelationDiagnostic, next: CorrelationDiagnostic): boolean {
  return (
    previous.phase === next.phase &&
    previous.decision === next.decision &&
    previous.reason === next.reason &&
    previous.usersBefore === next.usersBefore &&
    previous.usersNow === next.usersNow &&
    previous.baselineTail === next.baselineTail &&
    previous.latestUser === next.latestUser &&
    previous.user === next.user &&
    previous.response === next.response &&
    (previous.requestHash ?? "") === (next.requestHash ?? "")
  );
}

/**
 * A bounded ring of correlation records, newest last. `record()` stamps the time itself, drops
 * malformed input and repeats of the previous observation, and evicts the oldest entry at capacity.
 * `list()` hands out copies, so a caller can never mutate or retain a stored object.
 */
export class CorrelationDiagnosticLog {
  private readonly capacity: number;
  private entries: CorrelationDiagnostic[] = [];

  constructor(max: number = CORRELATION_DIAGNOSTIC_LIMIT) {
    this.capacity =
      typeof max === "number" && Number.isFinite(max) && max >= 1
        ? Math.min(Math.floor(max), CORRELATION_DIAGNOSTIC_LIMIT)
        : CORRELATION_DIAGNOSTIC_LIMIT;
  }

  record(input: Omit<CorrelationDiagnostic, "at">): void {
    const entry = normalize(input, new Date().toISOString());
    if (!entry) return;
    const previous = this.entries[this.entries.length - 1];
    if (previous && isRepeat(previous, entry)) return;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  list(): CorrelationDiagnostic[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * Validates an untrusted value as a list of records: non-arrays become empty, malformed entries are
 * dropped, unknown reasons become `unknown-reason`, at most {@link CORRELATION_DIAGNOSTIC_LIMIT}
 * (the most recent) entries survive, and every returned object is a copy.
 */
export function sanitizeCorrelationDiagnostics(value: unknown): CorrelationDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const kept: CorrelationDiagnostic[] = [];
  for (const candidate of value) {
    const entry = normalize(candidate, undefined);
    if (entry) kept.push(entry);
  }
  return kept.slice(-CORRELATION_DIAGNOSTIC_LIMIT);
}
