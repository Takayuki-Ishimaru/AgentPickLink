#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "../config/package-version.js";
import { formatInstallReport } from "./commands/install.js";
import { pickLocaleFromEnv } from "../services/localize.js";
import { createDefaultCliApi } from "./runtime.js";
import { isCliError, runCommand, type CliApi, type CliContext } from "./api.js";

/** Repeatable-option accumulator for commander (`--workspace <path>` may be given more than once). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function buildProgram(api: CliApi = createDefaultCliApi()): Command {
  const program = new Command();
  program.name("m365-agent").description("AgentPickLink for M365").version(PACKAGE_VERSION);
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
    .option("--agents <list>", "comma-separated agent aliases/keys; skips the interactive prompt")
    .option("--home <dir>", "install location, overriding the platform default")
    .option(
      "--approve-agents",
      "confirm the agent-roster approval non-interactively (§3.1's Consent rule -- distinct from --yes)"
    )
    .option(
      "--allow-actions-possible",
      "confirm the capability-widening consent non-interactively, for a plan with an actions-possible agent"
    )
    .option(
      "--force",
      "install this package even though install.json records a newer version (§4.7 C4 downgrade)"
    )
    .option(
      "--dev",
      "register this running checkout as the machine install (§4.7 C2), instead of staging a copy"
    );
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
        ctx.error(`${result.code}: ${result.message}${result.remediation ? `\n${result.remediation}` : ""}`);
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
    .option(
      "--verbose",
      "echo metadata-only diagnostic lines (broker-release waits, restart-and-retry outcomes) to stderr, prefixed [log]"
    );
  const selfStatus = self.command("status").option(homeOption, homeOptionDescription);
  selfStatus.action((opts: { home?: string }) => runCommand(context(), () => api.self("status", opts)));
  const use = self.command("use <version>").option(homeOption, homeOptionDescription);
  use.action((version: string, opts: { home?: string }) => {
    const ctx = context();
    return runCommand(ctx, () =>
      api.self("use", { version, yes: ctx.yes, home: opts.home, verbose: ctx.verbose })
    );
  });
  const prune = self.command("prune").option(homeOption, homeOptionDescription);
  prune.action((opts: { home?: string }) =>
    runCommand(context(), () => api.self("prune", { yes: context().yes, home: opts.home }))
  );
  const uninstall = self
    .command("uninstall")
    .option("--purge-data", "also remove agents.yaml, approvals.json and the browser profile")
    .option(homeOption, homeOptionDescription);
  uninstall.action((opts: { purgeData?: boolean; home?: string }) =>
    runCommand(context(), () =>
      api.self("uninstall", { purgeData: !!opts.purgeData, yes: context().yes, home: opts.home })
    )
  );

  const integrations = program
    .command("integrations")
    .option(
      "--verbose",
      "echo metadata-only diagnostic lines (broker-release waits, restart-and-retry outcomes) to stderr, prefixed [log]"
    );
  const write = integrations
    .command("write")
    .option(
      "--client <list>",
      "comma-separated vscode,vscode-user,vscode-workspace,claude,claude-user,claude-project,codex (default: vscode,claude,codex)"
    )
    .option("--workspace <path>", "workspace folder (default: the current directory)")
    .option("--force", "overwrite a foreign (not AgentPickLink-owned) entry too, after backing it up")
    .option(homeOption, homeOptionDescription);
  write.action((opts: { client?: string; workspace?: string; force?: boolean; home?: string }) =>
    runCommand(context(), () => api.integrations("write", opts))
  );
  const status = integrations
    .command("status")
    .option("--client <list>")
    .option("--workspace <path>")
    .option(homeOption, homeOptionDescription);
  status.action((opts: { client?: string; workspace?: string; home?: string }) =>
    runCommand(context(), () => api.integrations("status", opts))
  );
  const integrationsRemove = integrations
    .command("remove")
    .option("--client <list>")
    .option("--workspace <path>")
    .option("--force", "remove a foreign (not AgentPickLink-owned) entry too, after backing it up")
    .option(homeOption, homeOptionDescription);
  integrationsRemove.action((opts: { client?: string; workspace?: string; force?: boolean; home?: string }) =>
    runCommand(context(), () => api.integrations("remove", opts))
  );
  const snippet = integrations
    .command("snippet")
    .option("--client <list>")
    .option(homeOption, homeOptionDescription);
  snippet.action((opts: { client?: string; home?: string }) =>
    runCommand(context(), () => api.integrations("snippet", opts))
  );

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
