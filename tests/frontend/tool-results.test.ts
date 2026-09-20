import { describe, expect, it } from "vitest";
import { asError, failure } from "../../src/frontend/tool-results.js";
import { DomainError } from "../../src/domain/errors.js";

/**
 * Item 1: `DomainError.options.callLog`/`.timedOut` (a redacted Playwright launch call log,
 * forwarded across IPC -- see src/ipc/protocol.ts's IpcResponse and src/ipc/client.ts's
 * `receive()`) are broker-internal diagnostics meant for the CLI/extension's own log file
 * (src/services/setup-controller.ts's `exclusive()`, appending `browser-log:` lines), never the
 * public MCP tool contract. `failure()` is the single place every tool failure funnels through
 * (see src/frontend/tools.ts), so it must strip both fields before an AI client ever sees a result.
 */
describe("frontend tool-results: MCP surface strips broker-internal diagnostics", () => {
  it("never includes callLog/timedOut in a tool failure's structuredContent or text", () => {
    const domainError = new DomainError("BROWSER_START_FAILED", "The browser did not start.", false, {
      callLog: ["<launching> [redacted-url]", "<launched> pid=4242"],
      timedOut: true
    });
    const toolError = asError(domainError);
    const result = failure("req_1", toolError);

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("BROWSER_START_FAILED");
    expect(result.structuredContent.error).not.toHaveProperty("callLog");
    expect(result.structuredContent.error).not.toHaveProperty("timedOut");
    expect(result.content[0].text).not.toContain("callLog");
    expect(result.content[0].text).not.toContain("launched");
    expect(result.content[0].text).not.toContain("pid=4242");
  });

  it("leaves an ordinary tool error (no callLog/timedOut) unaffected", () => {
    const domainError = new DomainError("AUTH_REQUIRED", "Sign-in is required.", false);
    const result = failure("req_2", asError(domainError));
    expect(result.structuredContent.error).toEqual({
      code: "AUTH_REQUIRED",
      message: "Sign-in is required.",
      retryable: false,
      remediation: expect.stringContaining("Sign in")
    });
  });
});
