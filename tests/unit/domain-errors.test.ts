import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";

describe("DomainError for an ask whose message was or may have been sent", () => {
  it("carries the handle of the conversation the failed ask left open into its result", () => {
    const error = new DomainError("SUBMIT_STATE_UNKNOWN", "The message may have been submitted.", false, {
      submissionState: "unknown",
      conversationHandle: "conv_kept"
    });
    expect(error.toResult("req-1")).toEqual({
      ok: false,
      requestId: "req-1",
      error: {
        code: "SUBMIT_STATE_UNKNOWN",
        message: "The message may have been submitted.",
        retryable: false,
        submissionState: "unknown",
        conversationHandle: "conv_kept",
        remediation: expect.any(String)
      }
    });
  });

  it("has no conversationHandle in its result when no conversation was left open", () => {
    const error = new DomainError("SUBMIT_STATE_UNKNOWN", "The message may have been submitted.", false, {
      submissionState: "unknown"
    });
    expect(error.toResult("req-1").error).not.toHaveProperty("conversationHandle");
  });

  // A failed ask can leave its conversation open to be read, so the stock advice must name the way
  // to collect the reply instead of leaving the caller to send the message again.
  it.each(["SUBMIT_STATE_UNKNOWN", "RESPONSE_TIMEOUT"] as const)(
    "%s's default remediation points to m365_agent_session action=read",
    (code) => {
      const { remediation } = new DomainError(code, "failed").toResult("req-1").error;
      expect(remediation).toContain("m365_agent_session");
      expect(remediation).toContain("action=read");
      expect(remediation).toContain("conversationHandle");
    }
  );

  it("tells the caller the message was not sent again, and puts reading first", () => {
    for (const code of ["SUBMIT_STATE_UNKNOWN", "RESPONSE_TIMEOUT"] as const) {
      const remediation = new DomainError(code, "failed").toResult("req-1").error.remediation!;
      expect(remediation.indexOf("action=read")).toBeGreaterThan(-1);
      expect(remediation).toMatch(/not (retried|resubmitted)|Do not send it again/i);
    }
  });

  it("lets an explicit remediation replace the default one", () => {
    const error = new DomainError("RESPONSE_TIMEOUT", "failed", false, {
      remediation: "Call m365_agent_session with action=read and conversationHandle=conv_kept.",
      conversationHandle: "conv_kept"
    });
    expect(error.toResult("req-1").error.remediation).toBe(
      "Call m365_agent_session with action=read and conversationHandle=conv_kept."
    );
  });

  it("survives a JSON round trip, as it does on the broker's wire", () => {
    const error = new DomainError("RESPONSE_TIMEOUT", "failed", false, {
      submissionState: "sent",
      partialResponse: { text: "so far", citations: [] },
      conversationHandle: "conv_kept"
    });
    const wire = JSON.parse(JSON.stringify(error.toResult("req-1").error));
    expect(wire).toMatchObject({
      code: "RESPONSE_TIMEOUT",
      submissionState: "sent",
      partialResponse: { text: "so far", citations: [] },
      conversationHandle: "conv_kept"
    });
  });
});
