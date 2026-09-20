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
    serve: async () => undefined,
    install: async () =>
      ({
        dryRun: true,
        confirmed: false,
        version: "0.0.0",
        home: "/home",
        runtime: { path: "/home/bin/node", source: "bundled" },
        clients: [],
        workspaces: [],
        uninstallCommand: "m365-agent self uninstall",
        verified: false,
        instructions: [],
        exitCode: 0
      }) as never,
    self: done,
    integrations: done
  };
};

describe("CLI command surface", () => {
  it("registers every v0.1 command", () => {
    const program = buildProgram(api());
    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining([
        "init",
        "login",
        "logout",
        "doctor",
        "broker",
        "agent",
        "workspace",
        "install",
        "self",
        "integrations",
        "serve"
      ])
    );
    const self = program.commands.find((command) => command.name() === "self")!;
    const integrationsCommand = program.commands.find((command) => command.name() === "integrations")!;
    expect(self.commands.map((command) => command.name())).toEqual(["status", "use", "prune", "uninstall"]);
    expect(integrationsCommand.commands.map((command) => command.name())).toEqual([
      "write",
      "status",
      "remove",
      "snippet"
    ]);
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

  it("registers install's --home/--approve-agents/--allow-actions-possible/--dev flags (P0-3/P1-9)", () => {
    const program = buildProgram(api());
    const install = program.commands.find((command) => command.name() === "install")!;
    const longFlags = install.options.map((option) => option.long);
    expect(longFlags).toEqual(
      expect.arrayContaining(["--home", "--approve-agents", "--allow-actions-possible", "--dev"])
    );
  });

  it("registers --home on every self and integrations subcommand (P1-9)", () => {
    const program = buildProgram(api());
    const self = program.commands.find((command) => command.name() === "self")!;
    for (const sub of self.commands) expect(sub.options.map((option) => option.long)).toContain("--home");
    const integrationsCommand = program.commands.find((command) => command.name() === "integrations")!;
    for (const sub of integrationsCommand.commands)
      expect(sub.options.map((option) => option.long)).toContain("--home");
  });

  it("lists --verbose on install's own help, not only the top-level program (apl-setup --help is install --help)", () => {
    const program = buildProgram(api());
    const install = program.commands.find((command) => command.name() === "install")!;
    expect(install.options.map((option) => option.long)).toContain("--verbose");
    // install's own --help output must actually render the flag, not merely register it as an
    // option object -- helpInformation() is what a real `apl-setup --help`/`install --help` prints.
    expect(install.helpInformation()).toContain("--verbose");
    // install's own description should point a reader at --verbose too.
    expect(install.description()).toContain("--verbose");
  });

  it("also registers --verbose on self and integrations (same behaviour; read either)", () => {
    const program = buildProgram(api());
    const self = program.commands.find((command) => command.name() === "self")!;
    const integrationsCommand = program.commands.find((command) => command.name() === "integrations")!;
    expect(self.options.map((option) => option.long)).toContain("--verbose");
    expect(self.helpInformation()).toContain("--verbose");
    expect(integrationsCommand.options.map((option) => option.long)).toContain("--verbose");
    expect(integrationsCommand.helpInformation()).toContain("--verbose");
  });
});
