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
      };
    };
