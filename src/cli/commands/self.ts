import lockfile from "proper-lockfile";
import { withFileLock } from "../../config/storage.js";
import {
  stopOwnedInstallBroker,
  validatePurgeData,
  purgeLocalData,
  lockPurgeData,
  assertPurgeProfileIdle
} from "../../services/uninstall-safety.js";
/**
 * `m365-agent self status|use <version>|prune|uninstall [--purge-data]` -- machine-install
 * maintenance for the `<home>` `install` staged (docs/extension-less-onboarding.md §3.2, §4.7 C10).
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DomainError } from "../../domain/errors.js";
import {
  defaultClientDetectionIo,
  isClaudeCliOnPath,
  vscodeUserDir
} from "../../services/client-detection.js";
import { restartBrokerIfStale } from "../../services/broker-staleness.js";
import { appendCliLog } from "../setup-host-terminal.js";
import {
  currentVersion,
  identityFor,
  integrationVariablesFor,
  listVersions,
  pruneVersions,
  readInstallJson,
  resolveInstallHome,
  useVersion,
  writeInstallJson,
  validateInstallation
} from "../../services/install-home.js";
import {
  removeIntegrations,
  refreshStaleIntegrations,
  type IntegrationDefinition
} from "../../services/integrations.js";
import { pickLocaleFromEnv, translator } from "../../services/localize.js";
import type { CommandDeps } from "../command-deps.js";
import { resolveStandaloneDefinition } from "./integrations.js";
import { withYes } from "../ui/prompts.js";

const execFileAsync = promisify(execFile);

export type SelfOptions = {
  home?: string;
  purgeData?: boolean;
  yes?: boolean;
  /** ISSUE-09: echoes `restartBrokerIfStale`'s metadata-only log lines to stderr, prefixed
   * `[log]`, in addition to them always being appended to the app-data log file. */
  verbose?: boolean;
};

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function resolveHome(deps: CommandDeps, home: string | undefined): string {
  return resolveInstallHome({
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir(),
    override: home
  });
}

export async function runSelfStatus(
  deps: CommandDeps,
  options: SelfOptions = {}
): Promise<Record<string, unknown>> {
  const home = resolveHome(deps, options.home);
  const installJson = await readInstallJson(home).catch(() => undefined);
  const versions = await listVersions(home);
  const identity = identityFor({ home, platform: deps.platform });
  let runtimeVersion: string | null;
  try {
    const { stdout } = await execFileAsync(identity.command, ["--version"], {
      timeout: 5_000,
      windowsHide: true
    });
    runtimeVersion = stdout.trim();
  } catch {
    runtimeVersion = null;
  }
  return {
    home,
    installed: !!installJson,
    install: installJson ?? null,
    versions,
    current: identity,
    runtimeVersion,
    // P1-7: what bin/apl.js actually references right now (the current-version sidecar, falling
    // back to install.json) -- can disagree with install.json.version if the two are ever updated
    // out of step.
    currentVersion: await currentVersion(home, installJson)
  };
}

export async function runSelfUse(
  deps: CommandDeps,
  version: string,
  options: SelfOptions = {}
): Promise<Record<string, unknown>> {
  const home = resolveHome(deps, options.home);
  const release = await lockfile.lock(home, { realpath: true, retries: 0 });
  try {
    await useVersion({ home, version, platform: deps.platform });
    const installJson = await readInstallJson(home).catch(() => undefined);
    if (installJson)
      await writeInstallJson(home, {
        ...installJson,
        version,
        identity:
          installJson.runtime.source === "electron"
            ? {
                command: installJson.runtime.path,
                args: [path.join(home, "app", version, "dist", "cli", "index.js"), "serve"]
              }
            : installJson.identity,
        updatedAt: new Date().toISOString()
      });
    if (installJson) {
      // §4.4: an `install.json` written before the user-scope defaults existed recorded the bare
      // vendor tokens `"vscode"`/`"claude"`, meaning the workspace/project-scope file of that era.
      const clients = installJson.clients.map((token) =>
        token === "vscode" ? "vscode-workspace" : token === "claude" ? "claude-project" : token
      );
      const definition = await resolveStandaloneDefinition(deps, home);
      const variables = integrationVariablesFor({
        env: deps.env,
        platform: deps.platform,
        homedir: deps.homedir()
      });
      const compareEnvKeys = ["M365_AGENT_MANAGED", "M365_AGENT_BUILD"] as const;
      // §4.4: `vscodeUser`/`claudeUser` are per-machine (not per-workspace) files, so they are
      // refreshed once, alongside Codex, rather than inside the per-workspace loop below.
      const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
      const vscodeUserDirectory = (await pathExists(userDir)) ? userDir : undefined;
      const claudeCliAvailable = await isClaudeCliOnPath({
        ...defaultClientDetectionIo(),
        env: deps.env,
        platform: deps.platform,
        homedir: deps.homedir()
      });
      await refreshStaleIntegrations(
        {
          definition,
          homeDirectory: deps.homedir(),
          variables,
          compareEnvKeys,
          vscodeUserDirectory,
          claudeCliAvailable
        },
        {
          codex: false,
          claudeCode: false,
          vscodeMcpJson: false,
          vscodeUser: clients.includes("vscode-user"),
          claudeUser: clients.includes("claude-user")
        }
      );
      const settings = {
        codex: false,
        claudeCode: clients.includes("claude-project"),
        vscodeMcpJson: clients.includes("vscode-workspace")
      };
      for (const workspaceRoot of installJson.workspaces)
        await refreshStaleIntegrations(
          { definition, workspaceRoot, homeDirectory: deps.homedir(), variables, compareEnvKeys },
          settings
        );
    }
    // §4.2/§4.7 C13: re-pointing bin/apl.js is only half of "self use" -- a broker already running
    // the previous version must be restarted so it, too, picks up the version now in effect.
    const brokerEntry = path.join(home, "app", version, "dist", "broker", "process.js");
    const restarted = await restartBrokerIfStale({
      paths: deps.paths,
      brokerEntry,
      log: (line) => {
        // ISSUE-09 (docs/validation-log-2026-09-14-windows.md): persisted (best-effort) rather than
        // discarded, and, with --verbose, also echoed live -- same convention as
        // TerminalSetupHost.log() in setup-host-terminal.ts.
        void appendCliLog(deps.paths, line).catch(() => undefined);
        if (options.verbose) deps.stderr(`[log] ${line}\n`);
      }
    }).catch(() => false);
    return { switched: true, version, home, restartedBroker: restarted };
  } finally {
    await release();
  }
}

export async function runSelfPrune(
  deps: CommandDeps,
  options: SelfOptions = {}
): Promise<Record<string, unknown>> {
  const home = resolveHome(deps, options.home);
  const release = await lockfile.lock(home, { realpath: true, retries: 0 });
  try {
    const installJson = await readInstallJson(home).catch(() => undefined);
    if (!installJson)
      throw new DomainError("INVALID_ARGUMENT", `No AgentPickLink install found under ${home}.`, false, {
        remediation: "Run m365-agent install first."
      });
    // P1-7: keep whatever bin/apl.js actually references (the current-version sidecar), not
    // install.json.version blindly -- the two can disagree if a future writer updates one without
    // the other.
    const keep = (await currentVersion(home, installJson)) ?? installJson.version;
    const candidates = (await listVersions(home)).filter((version) => version !== keep);
    if (
      candidates.length &&
      !(await withYes(deps.prompter, !!options.yes).confirm(
        translator(pickLocaleFromEnv(deps.env))("selfPruneConfirm").replace(
          "{versions}",
          candidates.join(", ")
        )
      ))
    )
      return { removed: [], kept: keep, home, confirmed: false };
    const removed = await pruneVersions({ home, keep });
    return { removed, kept: keep, home };
  } finally {
    await release();
  }
}

export async function runSelfUninstall(
  deps: CommandDeps,
  options: SelfOptions = {}
): Promise<Record<string, unknown>> {
  const home = resolveHome(deps, options.home);
  await validateInstallation(home, deps.platform);
  if (options.purgeData) await validatePurgeData(deps, home);
  const release = await lockfile.lock(home, { realpath: true, retries: 0 });
  try {
    return await withFileLock(deps.paths.startupLock, async () => {
      const installJson = await validateInstallation(home, deps.platform);
      const locale = pickLocaleFromEnv(deps.env);
      const t = translator(locale);
      const prompter = withYes(deps.prompter, !!options.yes);
      const confirmed = await prompter.confirm(
        options.purgeData ? t("selfUninstallPurgeConfirm") : t("selfUninstallConfirm")
      );
      if (!confirmed)
        throw new DomainError("INVALID_ARGUMENT", "Uninstall was not confirmed.", false, {
          remediation: "Re-run with --yes for a non-interactive uninstall."
        });

      // Confirmation can take arbitrarily long: recheck before touching any integration or payload.
      await validateInstallation(home, deps.platform);
      if (options.purgeData) await validatePurgeData(deps, home);
      await stopOwnedInstallBroker(deps, home, !!options.purgeData);
      if (options.purgeData) await assertPurgeProfileIdle(deps);
      const dataLock = options.purgeData ? await lockPurgeData(deps) : undefined;
      try {
        const purgeEntries = options.purgeData
          ? (await fs.readdir(deps.paths.root)).filter((name) => !dataLock?.names.includes(name))
          : [];
        if (options.purgeData) await validatePurgeData(deps, home, dataLock?.names);

        // §4.7 C10: removing the machine install also removes the *managed* client entries it wrote --
        // never agents.yaml, approvals.json, or the browser profile (deps.paths.root) unless
        // --purge-data, and never a foreign entry (no --force here: a hand-written or differently-owned
        // entry under the m365-agents key must stay byte-identical, reported in `skippedIntegrations`).
        const removedIntegrations: string[] = [];
        const skippedIntegrations: string[] = [];
        if (installJson) {
          const identity = installJson.identity;
          const variables = integrationVariablesFor({
            env: deps.env,
            platform: deps.platform,
            homedir: deps.homedir()
          });
          const definition: IntegrationDefinition = { command: identity.command, args: identity.args };
          // §4.4: Codex and the two default user-scope writers are per-machine, not per-workspace, so
          // they are removed once here rather than inside the per-workspace loop below.
          const userDir = vscodeUserDir({ env: deps.env, platform: deps.platform, homedir: deps.homedir() });
          const vscodeUserDirectory = (await pathExists(userDir)) ? userDir : undefined;
          const claudeCliAvailable = await isClaudeCliOnPath({
            ...defaultClientDetectionIo(),
            env: deps.env,
            platform: deps.platform,
            homedir: deps.homedir()
          });
          const machineScoped = await removeIntegrations(
            {
              definition,
              variables,
              homeDirectory: deps.homedir(),
              vscodeUserDirectory,
              claudeCliAvailable,
              exec: deps.exec
            },
            { codex: true, claudeCode: false, vscodeMcpJson: false, vscodeUser: true, claudeUser: true },
            { requireIdentityMatch: true }
          );
          removedIntegrations.push(...machineScoped.written);
          skippedIntegrations.push(...machineScoped.skipped);
          for (const workspaceRoot of installJson.workspaces) {
            const summary = await removeIntegrations(
              { definition, variables, homeDirectory: deps.homedir(), workspaceRoot },
              { codex: false, claudeCode: true, vscodeMcpJson: true },
              { requireIdentityMatch: true }
            );
            removedIntegrations.push(...summary.written);
            skippedIntegrations.push(...summary.skipped);
          }
        }

        await fs.rm(path.join(home, "bin"), { recursive: true, force: true });
        await fs.rm(path.join(home, "app"), { recursive: true, force: true });
        await fs.rm(path.join(home, "install.json"), { force: true });

        if (options.purgeData) await purgeLocalData(deps, purgeEntries);

        return {
          uninstalled: true,
          home,
          removedIntegrations,
          skippedIntegrations,
          purged: !!options.purgeData
        };
      } finally {
        await dataLock?.release();
      }
    });
  } finally {
    await release();
  }
}
