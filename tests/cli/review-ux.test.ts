import { afterEach, describe, expect, it, vi } from "vitest";
import { formatReadableResult, printResult, type CliApi, type CliContext } from "../../src/cli/api.js";
import { buildProgram } from "../../src/cli/index.js";
import { formatProgressLine } from "../../src/cli/commands/agent-discover.js";

afterEach(() => vi.unstubAllEnvs());

describe("review CLI output regressions", () => {
  it("renders workspace assignments independently from agent readiness", () => {
    const output = formatReadableResult({
      path: "/workspace",
      workspaceKey: "workspace-test",
      agents: [{ alias: "architecture-agent", expected: { displayName: "Architecture Agent" } }]
    });
    expect(output).toContain("architecture-agent");
    expect(output).toContain("/workspace");
    expect(output).not.toContain("undefined");
  });
  it("keeps nested status data readable on separate lines", () => {
    const output = formatReadableResult({
      running: true,
      health: { browser: { state: "ready" }, conversations: { active: 1, max: 4 } }
    });
    expect(output).not.toContain("state=ready; conversations=");
    expect(output.split("\n").length).toBeGreaterThan(3);
  });
  it("directs an unconfigured workspace to setup", () => {
    const output = formatReadableResult({
      ok: false,
      findings: ["workspace.approval", "workspace.assignments"],
      workspace: { path: "/workspace", approvalStatus: "not-configured", assignments: [] }
    });
    expect(output).toContain("apl-setup");
    expect(output).not.toContain("then `apl workspace approve`");
  });
  it("also handles the real missing-workspace error shape and retains approval guidance for configured workspaces", () => {
    expect(
      formatReadableResult({
        ok: false,
        findings: ["workspace.approval"],
        workspace: { code: "WORKSPACE_NOT_CONFIGURED", message: "missing", retryable: false }
      })
    ).toContain("apl-setup <path>");
    expect(
      formatReadableResult({
        ok: false,
        findings: ["workspace.approval"],
        workspace: {
          approvalStatus: "approval-required",
          assignments: [{ alias: "design", status: "approval-required" }]
        }
      })
    ).toContain("then `apl workspace approve`");
  });
  it("localizes doctor, command help, and discovery messages in Japanese", () => {
    vi.stubEnv("LC_ALL", "ja_JP.UTF-8");
    const program = buildProgram({} as CliApi);
    expect(program.helpInformation()).toContain("使い方:");
    expect(program.commands.find((command) => command.name() === "doctor")?.description()).toContain("診断");
    expect(program.commands.find((command) => command.name() === "install")?.helpInformation()).toContain(
      "エージェントの一覧を承認"
    );
    expect(
      formatReadableResult(
        { ok: false, findings: ["workspace.approval"], workspace: { configured: false } },
        "ja"
      )
    ).toContain("次の手順: apl-setup <パス>");
    const progress = formatProgressLine(
      {
        phase: "discovering",
        message: "Waiting for the Microsoft 365 landing page to render (still working)"
      },
      "ja"
    );
    expect(progress).toContain("表示を待っています（処理中）");
    expect(progress).not.toMatch(/Waiting|still working/);
  });
  it("preserves English help and exact machine-readable JSON", () => {
    vi.stubEnv("LC_ALL", "en_US.UTF-8");
    expect(buildProgram({} as CliApi).helpInformation()).toContain("Usage:");
    const out = vi.fn();
    const value = { code: "WORKSPACE_NOT_CONFIGURED", message: "Original message", retryable: false };
    printResult({ json: true, locale: "ja", out, error: vi.fn() } as unknown as CliContext, value);
    expect(JSON.parse(out.mock.calls[0][0])).toEqual(value);
  });
});
