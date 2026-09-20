/**
 * Moved to `src/services/integrations.ts` (host-agnostic; no `vscode` import) so the CLI can reuse
 * it. Re-exported here so the extension and its tests keep importing from this path.
 */
export * from "../services/integrations.js";
