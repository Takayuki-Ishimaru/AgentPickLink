/**
 * Moved to `src/services/setup-status.ts` (host-agnostic; no `vscode` import) so `SetupController`
 * and the CLI can reuse it. Re-exported here so the extension and its tests keep importing from
 * this path.
 */
export * from "../services/setup-status.js";
