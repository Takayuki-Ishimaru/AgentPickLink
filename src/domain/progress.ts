/** Metadata-only progress events emitted by long-running broker operations (invocation, reading a
 * conversation, interactive sign-in, agent discovery). They cross IPC as `{ id, event: "progress",
 * data }` frames and are forwarded to MCP clients as `notifications/progress`. They must never carry
 * prompt or response text. While an answer is collected the phases say what is being waited for:
 * `checking-message` (whether a message is in the conversation, when reading it), `waiting-response`,
 * `streaming`, `confirming-response` (the text stopped changing; making sure the answer is
 * complete), `checking-attachments` (files that can appear after the answer) and
 * `saving-attachments`. */
export type ProgressPhase =
  | "connecting"
  | "navigating"
  | "asserting-identity"
  | "filling"
  | "submitting"
  | "submitted"
  | "checking-message"
  | "waiting-response"
  | "streaming"
  | "confirming-response"
  | "extracting"
  | "checking-attachments"
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
  "checking-message",
  "waiting-response",
  "streaming",
  "confirming-response",
  "extracting",
  "checking-attachments",
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
