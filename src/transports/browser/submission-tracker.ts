import type { SubmissionAck, SubmissionMarker, SubmissionState } from "./types.js";

export type SubmissionPhase =
  | "VALIDATING"
  | "NAVIGATING"
  | "ASSERTING_IDENTITY_BEFORE_FILL"
  | "FILLING"
  | "ASSERTING_IDENTITY_BEFORE_SUBMIT"
  | "SUBMITTING"
  | "WAITING_USER_MESSAGE_ACK"
  | "WAITING_RESPONSE_START"
  | "WAITING_RESPONSE_COMPLETE"
  | "EXTRACTING"
  | "READY"
  | "FAILED";
/** Where a submission is, and whether its message was sent: "not-sent" until the send control may
 * be pressed, "unknown" from then on until an acknowledgement confirms it as "sent". */
export class SubmissionTracker {
  phase: SubmissionPhase = "VALIDATING";
  state: SubmissionState = "not-sent";
  marker?: SubmissionMarker;
  transition(next: SubmissionPhase): void {
    if (this.phase === "READY" || this.phase === "FAILED") throw new Error("SUBMISSION_TERMINAL");
    this.phase = next;
    if (next === "SUBMITTING") this.state = "unknown";
  }
  record(marker: SubmissionMarker): void {
    this.marker = marker;
  }
  acknowledge(ack: SubmissionAck): void {
    this.state = ack.state;
    if (ack.state === "sent") this.phase = "WAITING_RESPONSE_START";
    else this.phase = "FAILED";
  }
  fail(): void {
    this.phase = "FAILED";
  }
  complete(): void {
    if (this.state !== "sent") throw new Error("SUBMIT_STATE_UNKNOWN");
    this.phase = "READY";
  }
}
