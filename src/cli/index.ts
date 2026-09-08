#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultCliApi } from "./runtime.js";
import { runCommand, type CliApi, type CliContext } from "./api.js";

export function buildProgram(api: CliApi = createDefaultCliApi()): Command {
  const program = new Command();
  program.name("m365-agent").description("AgentPickLink for M365").version("0.1.1");
  program
    .option("--json", "emit machine-readable JSON")
    .option("--yes", "confirm explicitly requested operations");
  const context = (): CliContext => {
    const options = program.opts<{ json?: boolean; yes?: boolean }>();
    return {
      workspaceRoot: process.cwd(),
      json: !!options.json,
      yes: !!options.yes,
      out: (s) => process.stdout.write(`${s}\n`),
      error: (s) => process.stderr.write(`${s}\n`),
      api
    };
  };
  const leaf = (command: Command, action: () => Promise<unknown>) =>
    command.action(() => runCommand(context(), action));

  leaf(program.command("init"), () => api.init());
  leaf(program.command("login"), () => api.login());
  leaf(program.command("logout"), () => api.logout({ yes: context().yes }));
  const doctor = program.command("doctor").option("--agent <alias>").option("--auth");
  doctor.action((opts: { agent?: string; auth?: boolean }) => runCommand(context(), () => api.doctor(opts)));

  const broker = program.command("broker");
  leaf(broker.command("status"), () => api.broker("status"));
  leaf(broker.command("restart"), () => api.broker("restart"));
  leaf(broker.command("stop"), () => api.broker("stop"));

  const agent = program.command("agent");
  const add = agent.command("add").option("--capture").option("--url <url>").option("--force");
  add.action((opts: { capture?: boolean; url?: string; force?: boolean }) =>
    runCommand(context(), async () => {
      if (opts.capture && opts.url) throw new Error("Use either --capture or --url, not both.");
      if (!opts.capture && !opts.url) throw new Error("Specify --capture or --url <url>.");
      if (opts.capture)
        process.stderr.write(
          "A dedicated Edge window will open. Navigate to the target agent's direct 1:1 chat and leave that page visible.\n"
        );
      return api.agentAdd(opts);
    })
  );
  const remove = agent.command("remove <alias>");
  remove.action((alias: string) => runCommand(context(), () => api.agentRemove(alias)));
  leaf(agent.command("list"), () => api.agentList());
  const discover = agent.command("discover").option("--login", "open the sign-in window if needed");
  discover.action((opts: { login?: boolean }) =>
    runCommand(context(), () => api.agentDiscover({ ...opts, json: context().json }))
  );
  const test = agent.command("test <alias>").option("--send-test-message");
  test.action((alias: string, opts: { sendTestMessage?: boolean }) =>
    runCommand(context(), () => api.agentTest(alias, { ...opts, yes: context().yes }))
  );

  const workspace = program.command("workspace");
  leaf(workspace.command("configure"), () => api.workspaceConfigure());
  leaf(workspace.command("list"), () => api.workspaceList());
  leaf(workspace.command("validate"), () => api.workspaceValidate());
  leaf(workspace.command("approve"), () => api.workspaceApprove({ yes: context().yes }));
  leaf(workspace.command("approval-status"), () => api.workspaceApprovalStatus());
  leaf(workspace.command("revoke"), () => api.workspaceRevoke());
  // serve owns the MCP stdio transport: stdout carries only protocol traffic, so
  // this bypasses runCommand/printResult entirely rather than relying solely on
  // printResult's undefined-skip to keep the stream clean.
  program.command("serve").action(async () => {
    const ctx = context();
    try {
      await ctx.api.serve();
    } catch (error) {
      ctx.error(error instanceof Error ? error.message : "Command failed.");
      process.exitCode = 1;
    }
  });
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}

/**
 * Node can preserve the spelling used to launch a script in `process.argv[1]` while
 * `import.meta.url` resolves to the filesystem's canonical spelling. This is visible on macOS
 * (`/var` versus `/private/var`) and through npm's `.bin` symlinks. Compare real paths so the
 * packaged CLI still runs when invoked through either form, while keeping imports side-effect free.
 */
export function isDirectInvocation(argvPath: string | undefined, modulePath: string): boolean {
  if (!argvPath) return false;
  const canonical = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      // Preserve the path comparison when a caller supplies a path that has disappeared between
      // argv parsing and this check.
      return path.resolve(value);
    }
  };
  return canonical(argvPath) === canonical(modulePath);
}

// Avoid running when imported by contract tests.
const invoked = isDirectInvocation(process.argv[1], fileURLToPath(import.meta.url));
if (invoked)
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Command failed."}\n`);
    process.exitCode = 1;
  });
