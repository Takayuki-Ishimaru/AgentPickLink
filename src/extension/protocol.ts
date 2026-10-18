/**
 * Moved to `src/services/setup-protocol.ts` (host-agnostic; no `vscode` import) so the CLI can
 * reuse it. Re-exported here so the extension and its tests keep importing from this path.
 */
export * from "../services/setup-protocol.js";

import {
  parseWebviewMessage as parseSetupMessage,
  type WebviewMessage as SetupMessage
} from "../services/setup-protocol.js";

export type WebviewMessage = SetupMessage | { type: "setAutoUpdate"; enabled: boolean };

/** Extension preferences never reach the standalone setup host. */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (typeof value === "object" && value !== null && "type" in value && value.type === "setAutoUpdate") {
    return "enabled" in value && typeof value.enabled === "boolean"
      ? { type: "setAutoUpdate", enabled: value.enabled }
      : undefined;
  }
  return parseSetupMessage(value);
}
