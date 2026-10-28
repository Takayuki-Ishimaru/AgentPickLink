import { describe, expect, it } from "vitest";
import { formatReadableResult } from "../../src/cli/api.js";

describe("plain CLI result summaries", () => {
  it("summarizes doctor findings with relevant details and next steps", () => {
    const output = formatReadableResult({
      ok: false,
      findings: ["workspace.approval", "browser"],
      workspace: {
        approvalStatus: "approval-required",
        assignments: [{ alias: "sales", status: "approval-required" }]
      },
      browser: { installed: false, details: "Chromium runtime missing" }
    });

    expect(output).toContain("Health check: 2 issue(s) need attention");
    expect(output).toContain("workspace.approval: approvalStatus=approval-required");
    expect(output).toContain("apl workspace approve");
    expect(output).toContain("browser: installed=false; details=Chromium runtime missing");
    expect(output).toContain("choose an installed browser");
    expect(output).toContain("Problems found: 2");
  });

  it("keeps agent descriptions and usage hints in the terminal summary", () => {
    const output = formatReadableResult({
      agents: [
        {
          alias: "sales",
          name: "Sales Helper",
          status: "ready",
          description: "Answers sales questions.",
          usageHint: "Ask about account plans."
        }
      ]
    });

    expect(output).toContain("sales — ready — Sales Helper");
    expect(output).toContain("Answers sales questions.");
    expect(output).toContain("Usage: Ask about account plans.");
  });

  it("shows the topology reason and the complete policy key/value for doctor findings", () => {
    const output = formatReadableResult({
      ok: false,
      findings: ["topology", "policy.chat.mcp.access"],
      topology: { supported: false, note: "Remote workspace is not supported." },
      installConsistency: {
        policies: [
          {
            client: "codex",
            policy: "chat.mcp.access",
            value: "blocked",
            blocks: true,
            source: "config.toml"
          }
        ]
      }
    });

    expect(output).toContain("note=Remote workspace is not supported.");
    expect(output).toContain("policy=chat.mcp.access");
    expect(output).toContain("value=blocked");
    expect(output).toContain("Problems found: 2");
  });
});
