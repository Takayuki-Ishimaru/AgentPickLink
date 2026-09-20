/**
 * Sorts the `warnings` an agent discovery run returns into what they actually are. Everything in
 * that list is metadata-only by contract, but two kinds of line share it: short failure tags
 * (`no-sidebar`, `store-unavailable`, `sidebar-scan-failed`, `landing-not-rendered:<state>`,
 * `store-catalog-failed:<code>`, ...) that say something went wrong, and diagnostics that describe
 * what the run saw whether or not anything went wrong -- the per-strategy counts (`sidebar:…`),
 * the store catalogue tally (`store-catalog:…`) and its metadata-only shapes (`store-shapes:…`),
 * and the page-structure descriptions (`landing:…`, `route:<pathname>:…`). The panel and the CLI
 * show the two apart so a successful run does not
 * look like a warning. Dependency-free (domain) so the VS Code extension, which must never import
 * the browser transport, can share it with the CLI.
 */
const DIAGNOSTIC_LINE =
  /^(?:sidebar|store-catalog|store-shapes|description-details|description-retry|landing|route):/;

/** Whether one discovery warning line is a diagnostic summary rather than a failure tag. */
export function isDiscoveryDiagnostic(line: string): boolean {
  return DIAGNOSTIC_LINE.test(line);
}

/** The failure tags and the diagnostics of a discovery run, each in their original order. */
export function splitDiscoveryWarnings(lines: readonly string[]): {
  warnings: string[];
  diagnostics: string[];
} {
  const warnings: string[] = [];
  const diagnostics: string[] = [];
  for (const line of lines) (isDiscoveryDiagnostic(line) ? diagnostics : warnings).push(line);
  return { warnings, diagnostics };
}

/** Failure tags that, on their own (with no attached count), still mean a run did not see
 * everything it could have -- a card/list scan or the store's own re-catalogue navigation failed
 * outright, so the roster it returned may be short. */
const PARTIAL_FAILURE_TAGS =
  /^(?:store-expansion-failed|store-catalog-failed|store-return-failed|store-scroll-failed|sidebar-scroll-failed|sidebar-scan-failed|link-scan-failed):?/;

/**
 * Whether a discovery run is incomplete, and how many store candidates it could not resolve --
 * derived only from the run's own metadata-only warnings (never from anything else), so the
 * panel/CLI can tell the user the list may be short and that re-running can turn up more.
 *
 * A run counts as partial only when at least one candidate was *plausibly* lost: the store's own
 * `none`/`errors` tally on its `store-catalog:` line is non-zero (a card stayed unresolved, or
 * threw, even after its one retry -- a retry that recovered feeds neither field, see
 * agent-discovery.ts's `stats.retried`/`stats.recovered`), the store pass ran out of its own
 * budget with cards still unprocessed or a genuine expansion ("load more") failure interrupted it
 * while items were still arriving (both surface as that line's own trailing ` partial` -- a
 * "load more" click that merely timed out at the true end of the list is not one of these, see
 * `expandStore`, and never reaches this function as a loss), or one of the other
 * `PARTIAL_FAILURE_TAGS` fired.
 *
 * `failedCount` is the store's own `none + errors` tally when that is known and non-zero. A reason
 * above that carries no count of its own (the trailing ` partial` with nothing in `none`/`errors`,
 * or a bare failure tag) still means at least one candidate was plausibly lost, so `failedCount` is
 * reported as `1` -- a floor, not a real tally -- and `failedCountKnown` is `false` so a caller can
 * phrase that as "may not have been retrieved" instead of implying an exact, possibly misleading
 * number (never "(0)").
 */
export function summarizeDiscoveryCompleteness(warnings: readonly string[]): {
  partial: boolean;
  failedCount: number;
  /** `true` when `failedCount` is the store's own exact `none + errors` tally; `false` when it is
   * a floor of `1` standing in for a plausible loss whose real count is unknown. Meaningless when
   * `partial` is `false`. */
  failedCountKnown: boolean;
} {
  let partial = false;
  let knownFailed = 0;
  let unknownLoss = false;
  for (const line of warnings) {
    if (line.startsWith("store-catalog:")) {
      const none = Number(/(?:^|\s)none=(\d+)/.exec(line)?.[1] ?? 0);
      const errors = Number(/(?:^|\s)errors=(\d+)/.exec(line)?.[1] ?? 0);
      knownFailed += none + errors;
      if (none + errors > 0) partial = true;
      if (/ partial$/.test(line)) {
        partial = true;
        if (none + errors === 0) unknownLoss = true;
      }
    } else if (PARTIAL_FAILURE_TAGS.test(line)) {
      partial = true;
      unknownLoss = true;
    }
  }
  return {
    partial,
    failedCount: knownFailed > 0 ? knownFailed : unknownLoss ? 1 : 0,
    failedCountKnown: knownFailed > 0 || !unknownLoss
  };
}
