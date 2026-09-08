import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli/index.js";
import type { CliApi } from "../../src/cli/api.js";

const api = (): CliApi => {
  const done = async () => ({ ok: true });
  return {
    init: done,
    login: done,
    logout: done,
    doctor: done,
    broker: done,
    agentAdd: done,
    agentRemove: done,
    agentList: async () => ({ agents: [] }),
    agentDiscover: async () => ({ candidates: [], warnings: [] }),
    agentTest: done,
    workspaceConfigure: done,
    workspaceList: done,
    workspaceValidate: done,
    workspaceApprove: done,
    workspaceApprovalStatus: done,
    workspaceRevoke: done,
    serve: async () => undefined
  };
};

describe("CLI command surface", () => {
  it("registers every v0.1 command", () => {
    const program = buildProgram(api());
    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["init", "login", "logout", "doctor", "broker", "agent", "workspace", "serve"])
    );
    const broker = program.commands.find((command) => command.name() === "broker")!;
    const agent = program.commands.find((command) => command.name() === "agent")!;
    const workspace = program.commands.find((command) => command.name() === "workspace")!;
    expect(broker.commands.map((command) => command.name())).toEqual(["status", "restart", "stop"]);
    expect(agent.commands.map((command) => command.name())).toEqual([
      "add",
      "remove",
      "list",
      "discover",
      "test"
    ]);
    expect(workspace.commands.map((command) => command.name())).toEqual([
      "configure",
      "list",
      "validate",
      "approve",
      "approval-status",
      "revoke"
    ]);
  });
});
