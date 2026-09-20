/**
 * Moved to `src/services/localize.ts` (host-agnostic; no `vscode` import) so the CLI can reuse it.
 * Re-exported here so the extension and its tests keep importing from this path.
 */
export * from "../services/localize.js";
