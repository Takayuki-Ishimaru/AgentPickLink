/**
 * Broker-side, general-purpose file logger (item 1, docs/security.md "Data handling" -- metadata
 * only: no prompt/response text, no URLs, no cookies; local paths are acceptable).
 *
 * Before this module existed, `BrowserManager`'s `log()`/`onLog` option -- which already carries
 * useful diagnostics (staleness/profile-process lines, redacted Playwright call logs, force-kill
 * decisions) -- reached no file in production: both broker spawn sites use `stdio: "ignore"`, and
 * nothing ever passed an `onLog` into `BrowserManager`. This gives the broker's composition root
 * (`src/broker/process.ts`) one small file logger to pass into `BrowserManager`, `SessionManager`,
 * and `BrokerServer` alike, so every line lands in one place: `<paths.logs>/broker.log`.
 *
 * Same current-user-only file convention as the other logs next to it (`src/observability/audit.ts`'s
 * `AuditLogger`, `src/cli/setup-host-terminal.ts`'s `appendCliLog`): `mkdir` 0o700, `appendFile`
 * 0o600 -- no Windows ACL machinery, matching those two exactly. Size-capped: once the live file
 * reaches `maxBytes` (default 5 MiB) it is rotated to `broker.log.1` (clobbering whatever was
 * there) before the next line is appended, so the broker never accumulates unbounded local state.
 *
 * `log()` is synchronous in signature (matching `BrowserManagerOptions.onLog`) but best-effort and
 * fire-and-forget internally: a failed write is swallowed and must never affect the caller or throw
 * an unhandled rejection. Writes are serialized through one promise chain so a rotation check can
 * never interleave with a concurrent append and corrupt the rotation decision.
 */
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

export const BROKER_LOG_FILE = "broker.log";
export const BROKER_LOG_ROTATED_SUFFIX = ".1";
/** Rotate once the live file reaches this size, so `broker.log` never grows without bound. */
export const DEFAULT_MAX_BROKER_LOG_BYTES = 5 * 1024 * 1024;
/** `doctor`/`install`'s failure report default: enough to see what led up to a failure without
 * dumping the whole file. */
export const DEFAULT_BROKER_LOG_TAIL_LINES = 20;

/** Matches anything URL- or query-string-shaped, mirroring
 * `src/transports/browser/browser-manager.ts`'s own `LAUNCH_DIAGNOSTICS_URL_PATTERN`/
 * `LAUNCH_DIAGNOSTICS_QUERY_PATTERN` (kept duplicated rather than imported: this module must stay
 * free of any dependency on the browser transport layer, the same discipline
 * `src/observability/incidents.ts` already documents for its own structural type copies). */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const QUERY_PATTERN = /\?[^\s"'<>]+/g;

/** Belt-and-braces redaction applied to every line at the sink, regardless of source: a caller
 * should already never pass a page URL or a query string carrying request-scoped identifiers, but
 * this makes that an enforced property of the log file itself rather than a convention every call
 * site has to individually uphold. */
export function redactBrokerLogLine(line: string): string {
  return line.replace(URL_PATTERN, "[redacted-url]").replace(QUERY_PATTERN, "?[redacted]");
}

export function brokerLogPath(logsDir: string): string {
  return path.join(logsDir, BROKER_LOG_FILE);
}

export interface BrokerLogger {
  /** Appends one ISO-timestamped, redacted line to `<logsDir>/broker.log`. Never throws; a failed
   * write is swallowed (best-effort, exactly like `BrowserManagerOptions.onLog`'s existing
   * default). */
  log(line: string): void;
}

/** Creates a `BrokerLogger` writing under `logsDir`. `maxBytes` is exposed for tests; production
 * callers use the default. */
export function createBrokerLogger(logsDir: string, options: { maxBytes?: number } = {}): BrokerLogger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BROKER_LOG_BYTES;
  const file = brokerLogPath(logsDir);
  const rotated = `${file}${BROKER_LOG_ROTATED_SUFFIX}`;
  // Serializes every write (rotation check + append) so two lines logged back to back can never
  // race the rotation decision or interleave their writes.
  let queue: Promise<void> = Promise.resolve();
  const append = async (line: string): Promise<void> => {
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    const info = await stat(file).catch(() => undefined);
    if (info && info.size >= maxBytes) await rename(file, rotated).catch(() => undefined);
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  };
  return {
    log(rawLine: string): void {
      const line = `${new Date().toISOString()} ${redactBrokerLogLine(rawLine)}\n`;
      queue = queue.then(() => append(line)).catch(() => undefined);
    }
  };
}

/** Reads the last `lines` (default 20) non-empty lines of the live `broker.log` file -- used by
 * `doctor` and `install`'s failure report to show what led up to a recorded `BROWSER_START_FAILED`.
 * Metadata only, same as everything else this module writes. Returns an empty array when the file
 * does not exist or cannot be read (e.g. before the broker has ever started). */
export async function readBrokerLogTail(
  logsDir: string,
  lines: number = DEFAULT_BROKER_LOG_TAIL_LINES
): Promise<string[]> {
  const content = await readFile(brokerLogPath(logsDir), "utf8").catch(() => undefined);
  if (!content) return [];
  const all = content.split("\n").filter((line) => line.length > 0);
  return all.slice(-lines);
}
