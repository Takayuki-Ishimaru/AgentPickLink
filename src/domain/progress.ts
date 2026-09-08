/** Metadata-only progress events emitted by long-running broker operations (invocation, interactive
 * sign-in, agent discovery). They cross IPC as `{ id, event: "progress", data }` frames and are forwarded
 * to MCP clients as `notifications/progress`. They must never carry prompt or response text. */
export type ProgressPhase =
  | "connecting"
  | "navigating"
  | "asserting-identity"
  | "filling"
  | "submitting"
  | "submitted"
  | "waiting-response"
  | "streaming"
  | "extracting"
  | "saving-attachments"
  | "login-waiting"
  | "login-closing"
  | "discovering"
  | "verifying"
  | "done";

export type ProgressEvent = {
  phase: ProgressPhase;
  /** Short, human-readable, non-sensitive text (no prompt/response content). */
  message?: string;
  elapsedMs?: number;
  responseChars?: number;
  current?: number;
  total?: number;
};

export type ProgressSink = (event: ProgressEvent) => void;

export const PROGRESS_PHASES: readonly ProgressPhase[] = [
  "connecting",
  "navigating",
  "asserting-identity",
  "filling",
  "submitting",
  "submitted",
  "waiting-response",
  "streaming",
  "extracting",
  "saving-attachments",
  "login-waiting",
  "login-closing",
  "discovering",
  "verifying",
  "done"
];

export function isProgressEvent(value: unknown): value is ProgressEvent {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { phase?: unknown }).phase === "string" &&
    (PROGRESS_PHASES as readonly string[]).includes((value as { phase: string }).phase)
  );
}
