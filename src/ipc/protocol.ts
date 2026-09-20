import { assertNever } from "../domain/assert.js";
import type { ProgressEvent } from "../domain/progress.js";
export { assertNever };
/** Minor 3 adds operation-scoped discovery cancellation. Older callers keep the shared
 * non-cancellable discovery path; the server negotiates the lower minor. */
export const BROKER_PROTOCOL = { major: 1, minor: 3 } as const;
export const BROKER_CAPABILITIES = ["conversation", "workspace-policy", "interactive-setup"] as const;
export type BrokerDescriptor = {
  pid: number;
  pipeName: string;
  protocolMajor: number;
  protocolMinor: number;
  packageVersion: string;
  instanceId: string;
  authSecret: string;
  createdAt: string;
  /** Set before graceful shutdown starts so new clients wait for the owner to release the profile. */
  state?: "running" | "stopping" | "stop-failed";
  /** Identifies the code the broker was started from (entry file + its mtime), so a client
   * bundled with a newer build (e.g. after a VSIX update) can tell the running broker is stale. */
  build?: BrokerBuild;
  /** Best-effort OS pid of the automation browser process this broker last launched (or
   * relaunched), refreshed opportunistically (see BrokerServer's `broker.health` handling and its
   * shutdown transition to `state: "stopping"`). Advisory only: a restarter that stops a wedged or
   * unresponsive broker (`src/services/broker-staleness.ts`'s `waitForBrokerFullyReleased`) uses
   * this to also clean up the browser process that broker owned, independently re-verifying the
   * pid is alive and actually tied to the dedicated profile before ever force-killing it. Absent
   * whenever no browser has launched yet, or this broker predates the field.
   * (docs/validation-log-2026-09-14-windows-round3.md S2) */
  browserPid?: number;
};
export type BrokerBuild = { entry: string; mtimeMs: number };
export type BrokerHello = {
  protocolMajor: number;
  protocolMinor: number;
  packageVersion: string;
  capabilities: string[];
  instanceId: string;
};
export type IpcRequest = { id: string; method: string; params: unknown };
/** A metadata-only progress frame the server may write on a request's socket, zero or more
 * times, before that request's final IpcResponse frame (see src/domain/progress.ts). Never
 * settles the client's waiter for `id`; unknown/late frames are ignored by the client. */
export type IpcProgressFrame = { id: string; event: "progress"; data: ProgressEvent };
export type IpcResponse =
  | { id: string; ok: true; result: unknown }
  | {
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        remediation?: string;
        submissionState?: "not-sent" | "sent" | "unknown";
        partialResponse?: unknown;
        retryAfterMs?: number;
        /** item 1: see domain/errors.ts's `ApplicationError.callLog`/`.timedOut` -- forwarded
         * across this same wire shape so the CLI/extension can append the call log to their own
         * log file. Never surfaced by the frontend's MCP tool result (stripped in
         * src/frontend/tool-results.ts's `failure()`). */
        callLog?: string[];
        timedOut?: boolean;
      };
    };
