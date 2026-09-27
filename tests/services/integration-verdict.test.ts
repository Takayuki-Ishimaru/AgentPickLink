/**
 * `integrationVerdict` (APL-REVIEW-02, P2, src/services/integrations.ts) -- the single verdict the
 * CLI exit code (`integrations write`/`remove`), `install`'s `clientErrors` and the setup panel's
 * completion row (`PanelState.clientApplication`) all share. Exercised in isolation, against hand-
 * built summaries, so its own state machine (not-selected / complete / partial, warnings never
 * counting, and the legacy no-`issues` fallback) is pinned down independently of any real writer.
 */
import { describe, expect, it } from "vitest";
import {
  integrationVerdict,
  type IntegrationIssue,
  type IntegrationSummary
} from "../../src/services/integrations.js";

function issue(overrides: Partial<IntegrationIssue> = {}): IntegrationIssue {
  return {
    kind: "vscodeMcpJson",
    file: "/ws/.vscode/mcp.json",
    code: "invalid-configuration",
    message: "/ws/.vscode/mcp.json: some reason; file was not written.",
    failed: true,
    ...overrides
  };
}

describe("integrationVerdict", () => {
  it("is not-selected when no flag in settings is true (a summary from applying zero settings is itself empty)", () => {
    const summary: IntegrationSummary = { written: [], skipped: [], issues: [] };
    const verdict = integrationVerdict({ codex: false, claudeCode: false, vscodeMcpJson: false }, summary);
    expect(verdict).toEqual({ state: "not-selected", ok: true, errors: [] });
  });

  it("state is not-selected even if the summary happens to carry a failed issue -- ok/errors are computed independently of state", () => {
    const failed = issue();
    const summary: IntegrationSummary = { written: [], skipped: [failed.message], issues: [failed] };
    const verdict = integrationVerdict({ codex: false, claudeCode: false, vscodeMcpJson: false }, summary);
    expect(verdict.state).toBe("not-selected");
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual([failed]);
  });

  it("is complete when something was selected and no issue failed", () => {
    const summary: IntegrationSummary = {
      written: ["/ws/.vscode/mcp.json"],
      skipped: [],
      issues: []
    };
    const verdict = integrationVerdict({ vscodeMcpJson: true }, summary);
    expect(verdict).toEqual({ state: "complete", ok: true, errors: [] });
  });

  it("is partial when at least one issue failed", () => {
    const failed = issue();
    const summary: IntegrationSummary = { written: [], skipped: [failed.message], issues: [failed] };
    const verdict = integrationVerdict({ vscodeMcpJson: true }, summary);
    expect(verdict.state).toBe("partial");
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual([failed]);
  });

  it("stays complete when every issue is benign (failed: false), e.g. a remove's missing-directory skip", () => {
    const benign = issue({
      kind: "vscodeUser",
      file: "mcp.json (vscode-user)",
      code: "user-directory-missing",
      message: "mcp.json (vscode-user): the VS Code user directory was not found.",
      failed: false
    });
    const summary: IntegrationSummary = { written: [], skipped: [benign.message], issues: [benign] };
    const verdict = integrationVerdict({ vscodeUser: true }, summary);
    expect(verdict).toEqual({ state: "complete", ok: true, errors: [] });
  });

  it("a warning never changes the verdict -- it is a note about a file that WAS written", () => {
    const summary: IntegrationSummary = {
      written: ["/home/.claude.json"],
      skipped: [],
      warnings: ["/home/.claude.json: this entry used to point at another workspace."],
      issues: []
    };
    const verdict = integrationVerdict({ claudeUser: true }, summary);
    expect(verdict).toEqual({ state: "complete", ok: true, errors: [] });
  });

  it("mixes benign and failed issues and still reports only the failed one as an error", () => {
    const benign = issue({
      code: "no-workspace",
      message: ".mcp.json: no workspace folder is open.",
      failed: false
    });
    const failed = issue();
    const summary: IntegrationSummary = {
      written: [],
      skipped: [benign.message, failed.message],
      issues: [benign, failed]
    };
    const verdict = integrationVerdict({ claudeCode: true, vscodeMcpJson: true }, summary);
    expect(verdict.state).toBe("partial");
    expect(verdict.errors).toEqual([failed]);
  });

  it("treats every skipped line as a failed write-failed issue when issues is undefined (a legacy summary literal)", () => {
    // install.ts's own early return for a missing VS Code user directory builds exactly this shape
    // (a bare {written, skipped} literal, predating IntegrationSummary.issues).
    const summary: IntegrationSummary = {
      written: [],
      skipped: ["mcp.json (vscode-user): the VS Code user directory was not found on this machine; skipped."]
    };
    const verdict = integrationVerdict({ vscodeUser: true }, summary);
    expect(verdict.state).toBe("partial");
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual([
      {
        kind: "vscodeUser",
        file: "mcp.json (vscode-user)",
        code: "write-failed",
        message: "mcp.json (vscode-user): the VS Code user directory was not found on this machine; skipped.",
        failed: true
      }
    ]);
  });

  it("accepts the panel/CLI's narrower IntegrationFlags shape ({codex, claudeCode, vscodeMcpJson}) as settings", () => {
    // No `vscodeUser`/`claudeUser` keys at all -- IntegrationFlags never has them.
    const verdict = integrationVerdict(
      { codex: false, claudeCode: false, vscodeMcpJson: true },
      {
        written: ["/ws/.vscode/mcp.json"],
        skipped: [],
        issues: []
      }
    );
    expect(verdict).toEqual({ state: "complete", ok: true, errors: [] });
  });
});
