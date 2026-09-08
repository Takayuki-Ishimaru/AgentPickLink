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
