#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError } from "../domain/errors.js";
import { toToolError } from "./ui/formatter.js";
import { PACKAGE_VERSION } from "../config/package-version.js";
import { formatInstallReport } from "./commands/install.js";
import { pickLocaleFromEnv } from "../services/localize.js";
import { createDefaultCliApi } from "./runtime.js";
import { isCliError, printResult, runCommand, type CliApi, type CliContext } from "./api.js";

/** Repeatable-option accumulator for commander (`--workspace <path>` may be given more than once). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function buildProgram(api: CliApi = createDefaultCliApi()): Command {
  const program = new Command().exitOverride();
  program.name("apl").description("AgentPickLink for M365").version(PACKAGE_VERSION);
  program
    .option("--json", "emit machine-readable JSON")
    .option("--yes", "confirm explicitly requested operations")
    .option(
      "--verbose",
      "echo metadata-only diagnostic lines (broker-release waits, restart-and-retry outcomes) to stderr, prefixed [log]"
    );
  const context = (): CliContext => {
    const options = program.opts<{ json?: boolean; yes?: boolean; verbose?: boolean }>();
    return {
      workspaceRoot: process.cwd(),
      json: !!options.json,
      yes: !!options.yes,
      verbose: !!options.verbose,
      out: (s) => process.stdout.write(`${s}\n`),
      error: (s) => process.stderr.write(`${s}\n`),
      api
    };
  };
  const leaf = (command: Command, action: () => Promise<unknown>) =>
    command.action(() => runCommand(context(), action));

  leaf(program.command("init").description("Create the global configuration and local state files."), () =>
    api.init()
  );
  leaf(program.command("login").description("Sign in to Microsoft 365 using the managed browser."), () =>
    api.login()
  );
  leaf(program.command("logout").description("Sign out and close the managed browser session."), () =>
    api.logout({ yes: context().yes })
  );
  const doctor = program
    .command("doctor")
    .description("Check local setup, workspace approval, integrations, and broker health.")
    .option("--agent <alias>", "validate one configured agent without sending a message")
    .option("--auth", "check the current browser sign-in state");
  doctor.action(async (opts: { agent?: string; auth?: boolean }) => {
    const ctx = context();
    try {
      const result = await api.doctor(opts);
      printResult(ctx, result);
      process.exitCode = isCliError(result) ? 2 : result.ok === false ? 1 : 0;
    } catch (error) {
      printResult(ctx, toToolError(error));
      process.exitCode = 2;
    }
  });

  const broker = program.command("broker").description("Inspect and control the local background broker.");
  leaf(broker.command("status").description("Show whether the broker is running and its health."), () =>
    api.broker("status")
  );
  leaf(broker.command("restart").description("Restart the local broker."), () => api.broker("restart"));
  leaf(broker.command("stop").description("Stop the local broker."), () => api.broker("stop"));

  const agent = program.command("agent").description("Discover, register, and validate agents.");
  const add = agent
    .command("add")
    .description("Register an agent from a browser page or direct URL.")
    .option("--capture", "capture the current agent page in a dedicated Edge window")
    .option("--url <url>", "register the specified direct agent URL")
    .option("--force", "replace an existing agent with the same alias");
  add.action((opts: { capture?: boolean; url?: string; force?: boolean }) =>
    runCommand(context(), async () => {
      if (opts.capture && opts.url)
        throw new DomainError("INVALID_ARGUMENT", "Use either --capture or --url, not both.");
      if (!opts.capture && !opts.url)
        throw new DomainError("INVALID_ARGUMENT", "Specify --capture or --url <url>.");
      if (opts.capture)
        process.stderr.write(
          "A dedicated Edge window will open. Navigate to the target agent's direct 1:1 chat and leave that page visible.\n"
        );
      return api.agentAdd(opts);
    })
  );
  const remove = agent.command("remove <alias>").description("Remove a registered agent by alias.");
  remove.action((alias: string) => runCommand(context(), () => api.agentRemove(alias)));
  leaf(agent.command("list").description("List registered agents and their readiness."), () =>
    api.agentList()
  );
  const discover = agent
    .command("discover")
    .description("Find available agents in Microsoft 365.")
    .option("--login", "open the sign-in window if needed");
  discover.action((opts: { login?: boolean }) =>
    runCommand(context(), () => api.agentDiscover({ ...opts, json: context().json }))
  );
  const test = agent
    .command("test <alias>")
    .description("Validate an agent; optionally send a test message.")
    .option("--send-test-message", "send a test message (requires --yes to confirm)");
  test.action((alias: string, opts: { sendTestMessage?: boolean }) =>
    runCommand(context(), () => api.agentTest(alias, { ...opts, yes: context().yes }))
  );

  const workspace = program
    .command("workspace")
    .description("Manage this repository's agent assignments and approvals.");
  leaf(workspace.command("configure").description("Select verified agents for this workspace."), () =>
    api.workspaceConfigure()
  );
  leaf(workspace.command("list").description("List agents assigned to this workspace."), () =>
    api.workspaceList()
  );
  leaf(workspace.command("validate").description("Check workspace assignments and approvals."), () =>
    api.workspaceValidate()
  );
  leaf(workspace.command("approve").description("Review and approve the assigned agents."), () =>
    api.workspaceApprove({ yes: context().yes })
  );
  leaf(workspace.command("approval-status").description("Show the current approval state."), () =>
    api.workspaceApprovalStatus()
  );
  leaf(workspace.command("revoke").description("Revoke this workspace's agent approvals."), () =>
    api.workspaceRevoke()
  );

  // `install` (the command behind the portable archive's `apl-setup` launcher) has its own exit
  // codes (0/1/2/3, docs/extension-less-onboarding.md §3.1) and its own plain-text report, so it
  // bypasses runCommand/printResult the same way `serve` does.
  const install = program
    .command("install")
    .description(
      "Set up AgentPickLink for one or more workspaces. Use --verbose to echo metadata-only " +
        "diagnostic lines (broker-release waits, restart-and-retry outcomes) to stderr, prefixed [log]."
    )
    .argument("[workspaces...]", "workspace folder(s) to set up")
    .option("--workspace <path>", "another workspace folder (repeatable)", collect, [] as string[])
    .option(
      "--verbose",
      "echo metadata-only diagnostic lines (broker-release waits, restart-and-retry outcomes) to stderr, prefixed [log]"
    )
    .option("--from-extension", "stage the invoking extension and retain existing agent approvals")
    .option("--browser", "use the browser setup page; confirmations stay in the terminal")
    .option("--no-open", "display the one-shot browser URL without opening it")
    .option("--dry-run", "print the plan and stop; nothing is written")
    .option(
      "--clients <mode>",
      "auto (default: vscode/vscode-user + claude/claude-user user-scope + codex) | none | " +
        "vscode,vscode-user,vscode-workspace,claude,claude-user,claude-project,codex"
    )
    .option("--agents <list>", "comma-separated aliases/keys (or key=alias); skips the interactive prompt")
    .option("--home <dir>", "install location, overriding the platform default")
    .option(
      "--approve-agents",
      "confirm the agent-roster approval in a non-interactive run (separate from --yes)"
    )
    .option(
      "--allow-actions-possible",
      "confirm the capability-widening consent non-interactively, for a plan with an actions-possible agent"
    )
    .option("--force", "allow installing an older version than the one currently installed")
    .option("--dev", "register this checkout as the machine install instead of staging a copy");
  install.action(
    async (
      positionalWorkspaces: string[],
      opts: {
        workspace: string[];
        dryRun?: boolean;
        browser?: boolean;
        open?: boolean;
        clients?: string;
        agents?: string;
        home?: string;
        approveAgents?: boolean;
        allowActionsPossible?: boolean;
        force?: boolean;
        dev?: boolean;
        fromExtension?: boolean;
      }
    ) => {
      const ctx = context();
      const result = await ctx.api.install({
        workspaces: [...positionalWorkspaces, ...opts.workspace],
        yes: ctx.yes,
        dryRun: !!opts.dryRun,
        browser: !!opts.browser,
        noOpen: opts.open === false,
        clients: opts.clients,
        agents: opts.agents,
        home: opts.home,
        approveAgents: !!opts.approveAgents,
        allowActionsPossible: !!opts.allowActionsPossible,
        force: !!opts.force,
        dev: !!opts.dev,
        fromExtension: !!opts.fromExtension,
        json: ctx.json,
        verbose: ctx.verbose
      });
      if (isCliError(result)) {
        if (ctx.json) ctx.out(JSON.stringify(result, null, 2));
        else
          ctx.error(
            `${result.code}: ${result.message}${result.remediation ? `\n${result.remediation}` : ""}`
          );
        process.exitCode = 1;
        return;
      }
      if (ctx.json) ctx.out(JSON.stringify(result, null, 2));
      else ctx.out(formatInstallReport(result, pickLocaleFromEnv(process.env)));
      process.exitCode = result.exitCode;
    }
  );

  const homeOption = "--home <dir>";
  const homeOptionDescription = "install location, overriding the platform default";

  const self = program
    .command("self")
    .description("Manage the portable CLI installation.")
    .option(
      "--verbose",
      "echo metadata-only diagnostic lines (broker-release waits, restart-and-retry outcomes) to stderr, prefixed [log]"
    );
  const selfStatus = self
    .command("status")
    .description("Show the installed CLI version, runtime, and launcher path.")
    .option(homeOption, homeOptionDescription);
  selfStatus.action((opts: { home?: string }) => runCommand(context(), () => api.self("status", opts)));
  const use = self
    .command("use <version>")
    .description("Switch the active CLI installation to a staged version.")
    .option(homeOption, homeOptionDescription);
  use.action((version: string, opts: { home?: string }) => {
    const ctx = context();
    return runCommand(ctx, () =>
      api.self("use", { version, yes: ctx.yes, home: opts.home, verbose: ctx.verbose })
    );
  });
  const prune = self
    .command("prune")
    .description("Remove unused staged versions.")
    .option(homeOption, homeOptionDescription);
  prune.action((opts: { home?: string }) =>
    runCommand(context(), () => api.self("prune", { yes: context().yes, home: opts.home }))
  );
  const uninstall = self
    .command("uninstall")
    .description("Remove the portable CLI installation.")
    .option("--purge-data", "also remove agents.yaml, approvals.json and the browser profile")
    .option(homeOption, homeOptionDescription);
  uninstall.action((opts: { purgeData?: boolean; home?: string }) =>
    runCommand(context(), () =>
      api.self("uninstall", { purgeData: !!opts.purgeData, yes: context().yes, home: opts.home })
    )
  );

  const integrations = program
    .command("integrations")
    .description("Write, inspect, remove, or print AI client configuration.")
    .option(
      "--verbose",
      "echo metadata-only diagnostic lines (broker-release waits, restart-and-retry outcomes) to stderr, prefixed [log]"
    );
  const write = integrations
    .command("write")
    .description("Register AgentPickLink with the selected AI clients.")
    .option(
      "--client <list>",
      "client list: vscode, vscode-user, vscode-workspace, claude, claude-user, claude-project, codex (default: vscode,claude,codex)"
    )
    .option("--workspace <path>", "workspace folder (default: the current directory)")
    .option("--force", "overwrite a foreign (not AgentPickLink-owned) entry too, after backing it up")
    .option(homeOption, homeOptionDescription);
  // APL-REVIEW-02: `written: []` + `skipped: [...]` used to still exit 0, so a caller that only
  // checks the exit code believed a requested integration exists. `runIntegrationsWrite` now
  // reports `ok`. Handled per action rather than by widening `runCommand`/`isCliError` themselves:
  // every other command routed through `runCommand` returns either a `ToolError`-shaped `CliResult`
  // (already handled by `isCliError`) or a domain-specific object with no `ok` field (checked
  // above -- init/login/logout/broker/agent-*/workspace-*/self all return no `ok` field); `doctor`
  // is the one command whose result *does* carry `ok`, and it already bypasses `runCommand`
  // entirely with its own dedicated action, so it is unaffected either way.
  write.action((opts: { client?: string; workspace?: string; force?: boolean; home?: string }) =>
    runCommand(context(), async () => {
      const result = await api.integrations("write", opts);
      if (!isCliError(result)) process.exitCode = (result as { ok?: boolean }).ok === false ? 1 : 0;
      return result;
    })
  );
  const status = integrations
    .command("status")
    .description("Show whether each selected client has a current AgentPickLink entry.")
    .option("--client <list>", "comma-separated client names (default: vscode,claude,codex)")
    .option("--workspace <path>", "workspace folder (default: the current directory)")
    .option(homeOption, homeOptionDescription);
  status.action((opts: { client?: string; workspace?: string; home?: string }) =>
    runCommand(context(), () => api.integrations("status", opts))
  );
  const integrationsRemove = integrations
    .command("remove")
    .description("Remove AgentPickLink entries from the selected clients.")
    .option("--client <list>", "comma-separated client names (default: vscode,claude,codex)")
    .option("--workspace <path>", "workspace folder (default: the current directory)")
    .option("--force", "remove a foreign (not AgentPickLink-owned) entry too, after backing it up")
    .option(homeOption, homeOptionDescription);
  integrationsRemove.action((opts: { client?: string; workspace?: string; force?: boolean; home?: string }) =>
    runCommand(context(), async () => {
      const result = await api.integrations("remove", opts);
      if (!isCliError(result)) process.exitCode = (result as { ok?: boolean }).ok === false ? 1 : 0;
      return result;
    })
  );
  const snippet = integrations
    .command("snippet")
    .description("Print ready-to-paste configuration for selected clients.")
    .option("--client <list>", "comma-separated client names (default: vscode,claude,codex)")
    .option(homeOption, homeOptionDescription);
  snippet.action(async (opts: { client?: string; home?: string }) => {
    const ctx = context();
    try {
      const result = await api.integrations("snippet", opts);
      if (isCliError(result)) {
        printResult(ctx, result);
        process.exitCode = 1;
      } else if (ctx.json) ctx.out(JSON.stringify(result, null, 2));
      else {
        const snippets = Object.entries(result as Record<string, string>);
        ctx.out(
          snippets.length === 1
            ? snippets[0][1]
            : snippets.map(([client, text]) => `=== ${client} ===\n${text}`).join("\n\n")
        );
      }
    } catch (error) {
      printResult(ctx, toToolError(error));
      process.exitCode = 1;
    }
  });

  // serve owns the MCP stdio transport: stdout carries only protocol traffic, so
  // this bypasses runCommand/printResult entirely rather than relying solely on
  // printResult's undefined-skip to keep the stream clean.
  program
    .command("serve")
    .description("Run the MCP server over standard input and output.")
    .action(async () => {
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
  const program = buildProgram().exitOverride();
  const json = argv.slice(2).includes("--json");
  const configure = (command: Command): void => {
    command.configureOutput({ writeErr: () => undefined });
    command.commands.forEach(configure);
  };
  configure(program);
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    const result =
      error instanceof CommanderError
        ? { code: "INVALID_ARGUMENT", message: error.message, retryable: false }
        : toToolError(error);
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stderr.write(`${result.code}: ${result.message}\n`);
    process.exitCode = 1;
  }
}

/**
 * Same behaviour as {@link main}, exported under its own name so `<home>/bin/apl.js`
 * (`src/services/install-home.ts`'s `writeLaunchers`) has one small, explicit, version-stable
 * surface to dynamically `import()` and call rather than reaching into the direct-invocation entry
 * point below.
 */
export const runCli = main;

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
