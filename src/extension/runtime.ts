/**
 * Process-wide services the extension's commands, webview and providers share: application paths,
 * the resolved Node runtime, the output channel and the settings the panel exposes.
 *
 * The output channel is the extension's only log sink -- `no-console` is an error in this
 * repository and, more importantly, prompt/response text must never be logged (only phases,
 * counts and error codes reach `log()`).
 */
import * as vscode from "vscode";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appPaths, type AppPaths } from "../config/paths.js";
import { vscodeUserDir } from "../services/client-detection.js";
import {
  integrationVariablesFor,
  readInstallJson,
  resolveInstallHome,
  type InstallJson
} from "../services/install-home.js";
import type { IntegrationVariables } from "../services/integrations.js";
import { compareVersions } from "../services/update-checker.js";
import type { IntegrationFlags, Locale } from "./protocol.js";
import { pickLocale } from "./localize.js";
import {
  defaultNodeProbe,
  MINIMUM_NODE_MAJOR,
  parseNodeMajor,
  probeCandidate,
  resolveNodeRuntime,
  type NodeProbe,
  type NodeRuntimeResolution
} from "./node-runtime.js";
import { persistedEnvironment as computePersistedEnvironment } from "./env-policy.js";

/** Environment variables forwarded from the extension host to every child process we start. */
const FORWARDED_ENVIRONMENT = [
  "M365_AGENT_APP_DATA",
  "M365_AGENT_DEV_APP_URL",
  "M365_AGENT_DEV_INSECURE_LOOPBACK",
  "M365_AGENT_ALLOW_UNSUPPORTED_OS"
] as const;

export const CONFIGURATION_SECTION = "agentpicklink";

export class ExtensionRuntime {
  readonly paths: AppPaths = appPaths();
  readonly extensionRoot: string;
  readonly version: string;
  readonly locale: Locale;
  readonly output: vscode.OutputChannel;
  private nodeRuntime?: Promise<NodeRuntimeResolution>;
  /** §4.7 C2/C4/C13: `<home>/install.json`, read once at construction, and the `<home>` it was
   * read from (not itself a field of `install.json`, so it is kept alongside). `undefined` until
   * `loadInstallInfo()` resolves, or forever when no machine install exists / it could not be
   * read -- see that method's doc comment for the resulting synchronous-read race, which is
   * bounded and, in practice, over well before anything but the very first activation instant
   * calls `cliEntry()`/`brokerEntry()`. */
  private installInfo?: InstallJson;
  private installHome?: string;
  private installInfoPromise?: Promise<InstallJson | undefined>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.extensionRoot = context.extensionUri.fsPath;
    this.version = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "0.0.0";
    this.locale = pickLocale(vscode.env.language);
    this.output = vscode.window.createOutputChannel("AgentPickLink", { log: true });
    context.subscriptions.push(this.output);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${CONFIGURATION_SECTION}.nodePath`)) this.nodeRuntime = undefined;
      })
    );
    // Deliberately not started here: `homeDirectory()` is overridden by tests on the constructed
    // instance (see tests/extension/harness.ts), *after* the constructor returns. Starting the
    // read here would read the real machine's `install.json` (or a test's real $HOME) before that
    // override ever takes effect. `ensureInstallInfo()` below is invoked instead by every accessor
    // that needs it, the first of which in production is `integrationDefinition()` from
    // `refreshIntegrationsOnActivate()`, itself the very first thing `activate()` calls.
  }

  /** §4.7 C2/C4: reads `<home>/install.json` once, lazily (see the constructor's comment), and
   * memoizes the result -- both the synchronously-readable `installInfo`/`installHome` fields (for
   * `cliEntry()`/`brokerEntry()`, which `SetupHost.brokerEntry()` requires to stay synchronous) and
   * the promise every async accessor awaits. A missing file (no machine install) resolves
   * `undefined` without logging anything; a present-but-invalid one is caught and logged (metadata
   * only -- never its content) so a corrupt file degrades to "no machine install" rather than
   * breaking activation. When the machine install's version is strictly older than this
   * extension's own, logs the one line docs/extension-less-onboarding.md §4.7 C4 asks for and
   * still resolves the record (so `machineInstallUsable` can tell "older" from "absent"). */
  private ensureInstallInfo(): Promise<InstallJson | undefined> {
    this.installInfoPromise ??= (async () => {
      try {
        const home = resolveInstallHome({
          env: process.env,
          platform: process.platform,
          homedir: this.homeDirectory()
        });
        const json = await readInstallJson(home);
        if (!json) return undefined;
        this.installHome = home;
        this.installInfo = json;
        const cmp = compareVersions(json.version, this.version);
        if (cmp === undefined)
          // §P2: a version neither side can parse leaves `machineInstallUsable` false forever, so
          // say so once instead of silently behaving as if the machine install were older.
          this.log(
            "install.json: its version could not be parsed; the machine install is used only for the broker"
          );
        else if (cmp === -1)
          this.log(
            `machine install ${json.version} is older than the extension ${this.version}; ` +
              "the broker still follows install.json (§4.7 C13)"
          );
        return json;
      } catch (error) {
        // §P2: metadata only. A Zod error's message embeds the offending *values*; only the issue
        // count and the property paths may reach the output channel.
        this.log(describeInstallJsonFailure(error));
        return undefined;
      }
    })();
    return this.installInfoPromise;
  }

  /** §4.7 C13: resolves once `<home>/install.json` has been read (or found absent), so a caller
   * about to make its *first* broker decision -- `activate()`'s auto-start, which is the first
   * thing to touch the broker when every integration flag is off -- can await it and be sure the
   * synchronous `brokerEntry()` below already reflects the machine install. Cheap and idempotent:
   * the read itself happens at most once per window. */
  async ready(): Promise<void> {
    await this.ensureInstallInfo();
  }

  /** The machine install's `install.json`, once read; `undefined` when there is none (or it could
   * not be read). Awaiting this is equivalent to `ready()` plus the record itself -- used by
   * `restartBrokerIfStale` to pass §4.7 C13's `expected` version. */
  machineInstall(): Promise<InstallJson | undefined> {
    return this.ensureInstallInfo();
  }

  async reloadMachineInstall(): Promise<void> {
    this.installInfoPromise = undefined;
    this.installInfo = undefined;
    this.installHome = undefined;
    this.nodeRuntime = undefined;
    await this.ready();
  }

  machineInstallOffer(): { installedVersion?: string; updateAvailable: boolean } {
    return {
      installedVersion: this.installInfo?.version,
      updateAvailable: !this.installInfo || compareVersions(this.version, this.installInfo.version) === 1
    };
  }

  /** True once `install.json` is present and at least as new as this extension (§4.7 C4) -- the
   * one condition under which the extension defers to the machine install for its identity,
   * `cliEntry()` and (unless the runtime is Electron) its Node runtime. `brokerEntry()` is
   * deliberately *not* gated on this (§4.7 C13, clarified 2026-09-13). */
  private machineInstallUsable(installJson: InstallJson): boolean {
    const cmp = compareVersions(installJson.version, this.version);
    return cmp !== undefined && cmp >= 0;
  }

  /** Appends one metadata-only line to the output channel. Never called with agent content. */
  log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  configuration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  }

  integrationFlags(): IntegrationFlags {
    const configuration = this.configuration();
    return {
      codex: configuration.get<boolean>("integrations.codex", false),
      claudeCode: configuration.get<boolean>("integrations.claudeCode", false),
      vscodeMcpJson: configuration.get<boolean>("integrations.vscodeMcpJson", false)
    };
  }

  async saveIntegrationFlags(flags: IntegrationFlags): Promise<void> {
    const configuration = this.configuration();
    const target = vscode.ConfigurationTarget.Global;
    await configuration.update("integrations.codex", flags.codex, target);
    await configuration.update("integrations.claudeCode", flags.claudeCode, target);
    await configuration.update("integrations.vscodeMcpJson", flags.vscodeMcpJson, target);
  }

  autoStartBroker(): boolean {
    return this.configuration().get<boolean>("autoStartBroker", true);
  }

  /** `agentpicklink.autoConnect`: after auto-start, resume a workspace that was set up here before
   * (see `SetupViewProvider.autoConnect`). Only ever reached through `autoStartBroker()`. */
  autoConnect(): boolean {
    return this.configuration().get<boolean>("autoConnect", true);
  }

  /** Resolved once per window (and again after `agentpicklink.nodePath` changes). §4.7 C4: when a
   * usable machine install exists (`install.json` present, its version >= this extension's own)
   * and its recorded runtime is a real Node binary (`"bundled"` or `"node"`), that binary is used
   * directly, with an empty environment -- no PATH lookup, no Electron marker, nothing left to
   * resolve. An `"electron"`-sourced machine install keeps today's behaviour unchanged (§4.7 C2:
   * "the Electron runtime cannot be copied"), falling through to `resolveNodeRuntime()` exactly as
   * if no machine install existed. */
  node(): Promise<NodeRuntimeResolution> {
    this.nodeRuntime ??= this.ensureInstallInfo().then(async (installJson) => {
      if (
        installJson &&
        installJson.runtime.source !== "electron" &&
        this.machineInstallUsable(installJson)
      ) {
        // P1-5: `install.json` is a record of what another entry point did, possibly months ago on
        // a machine whose `<home>` has since been moved, pruned or restored from a backup. Prove
        // the binary is there (and new enough) before handing hosts a command line built on it.
        const recorded = await this.verifyMachineRuntime(installJson);
        if (recorded) {
          this.log(
            `node: using machine install ${installJson.version} runtime (${installJson.runtime.source})`
          );
          return recorded;
        }
      }
      const resolution = await resolveNodeRuntime(
        this.configuration().get<string>("nodePath"),
        this.nodeProbe()
      );
      for (const warning of resolution.warnings) this.log(`node: ${warning}`);
      this.log(`node: using ${resolution.kind} runtime (${resolution.version ?? "electron"})`);
      return resolution;
    });
    return this.nodeRuntime;
  }

  /** P1-5: the recorded runtime as a `NodeRuntimeResolution`, or `undefined` (after exactly one
   * metadata-only log line) when it cannot be used -- the file is gone, it will not run, or the
   * version it reports is below `MINIMUM_NODE_MAJOR`. The probe is skipped entirely when
   * `install.json` already records a `nodeVersion` new enough to satisfy the minimum; it is run
   * when that field is absent (`install` before P1-5 never recorded it for a bundled runtime) or
   * records something too old, because a stale record is exactly the case worth catching. */
  private async verifyMachineRuntime(installJson: InstallJson): Promise<NodeRuntimeResolution | undefined> {
    const command = installJson.runtime.path;
    try {
      await access(command);
    } catch {
      this.log(`node: install.json runtime ${command} is missing; falling back to a resolved runtime`);
      return undefined;
    }
    const recordedMajor = installJson.runtime.nodeVersion
      ? parseNodeMajor(installJson.runtime.nodeVersion)
      : undefined;
    let version = installJson.runtime.nodeVersion;
    if (recordedMajor === undefined || recordedMajor < MINIMUM_NODE_MAJOR) {
      const probed = await probeCandidate(this.nodeProbe(), command);
      if (!probed.ok) {
        this.log(`node: install.json runtime rejected (${probed.reason}); falling back`);
        return undefined;
      }
      version = probed.version;
    }
    return {
      command,
      env: {},
      kind: "path",
      ...(version !== undefined ? { version } : {}),
      warnings: []
    } satisfies NodeRuntimeResolution;
  }

  /** The `NodeProbe` `node()` resolves with. A method (rather than an inline `defaultNodeProbe()`)
   * so a test can shadow it on the instance the way the harness already shadows `homeDirectory()`,
   * and no test ever execs a real binary. */
  nodeProbe(): NodeProbe {
    return defaultNodeProbe();
  }

  /** The first workspace folder, or `undefined` for an empty window. Multi-root windows are
   * rejected further down by WorkspaceService (`MULTI_ROOT_UNSUPPORTED`), not here. */
  workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  homeDirectory(): string {
    return os.homedir();
  }

  /** §4.7 C2/C13: `<home>/app/<version>/dist/broker/process.js` once `install.json` has been read,
   * else this extension's own tree. Deliberately **not** gated on `machineInstallUsable()` -- C13
   * as clarified on 2026-09-13 says the broker follows `install.json` *regardless of which entry
   * point is newer*, because exactly one broker version may own the dedicated browser profile at a
   * time, and the IPC `protocolMajor` check is what guards a newer VSIX talking to it. (Only
   * `node()`, `cliEntry()` and `integrationDefinition()` keep the C4 version gate.) The one line
   * logged when this extension is the newer of the two comes from `ensureInstallInfo()`, which runs
   * exactly once; this accessor itself is called on every spawn and must stay silent.
   *
   * `SetupHost.brokerEntry()` is synchronous, so this can only reflect `install.json` once
   * `ensureInstallInfo()` has resolved at least once -- every first broker decision therefore
   * awaits `ready()` first (see `activate()`'s `autoStart`). */
  brokerEntry(): string {
    void this.ensureInstallInfo();
    if (this.installInfo && this.installHome)
      return path.join(this.installHome, "app", this.installInfo.version, "dist", "broker", "process.js");
    return path.join(this.extensionRoot, "dist", "broker", "process.js");
  }

  /** See `brokerEntry()`: the same machine-install/own-tree choice, for `dist/cli/index.js`. */
  cliEntry(): string {
    void this.ensureInstallInfo();
    if (this.installInfo && this.installHome && this.machineInstallUsable(this.installInfo))
      return path.join(this.installHome, "app", this.installInfo.version, "dist", "cli", "index.js");
    return path.join(this.extensionRoot, "dist", "cli", "index.js");
  }

  mediaUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, "media");
  }

  /** Only the `M365_AGENT_*` passthroughs plus whatever the Node runtime itself requires. */
  extraEnvironment(node: NodeRuntimeResolution): Record<string, string> {
    const extra: Record<string, string> = { ...node.env };
    for (const key of FORWARDED_ENVIRONMENT) {
      const value = process.env[key];
      if (value !== undefined) extra[key] = value;
    }
    return extra;
  }

  /** Full environment for a detached child process. */
  childEnvironment(node: NodeRuntimeResolution): NodeJS.ProcessEnv {
    return { ...process.env, ...this.extraEnvironment(node) };
  }

  /** The environment safe to persist into an on-disk MCP client configuration file (Codex's
   * `config.toml`, Claude Code's `.mcp.json`, VS Code's `.vscode/mcp.json`) -- unlike
   * `extraEnvironment()`, this deliberately drops every `M365_AGENT_DEV_*` development override
   * (see src/extension/env-policy.ts for why). */
  persistedEnvironment(node: NodeRuntimeResolution): Record<string, string> {
    return computePersistedEnvironment(node.env, process.env.M365_AGENT_APP_DATA);
  }

  /** The `IntegrationDefinition` written to every on-disk MCP client configuration file. §4.7 C2:
   * when a usable machine install exists, this is `install.json`'s own `identity` (already the
   * version-independent `<home>/bin/node` + `<home>/bin/apl.js serve` per §3.2) plus the persisted
   * environment and the `M365_AGENT_MANAGED` ownership marker -- the workspace-file cache-busting
   * stamp (§4.7 C14) is a workspace-file-writer concern applied by `install`/`applyIntegrations`,
   * not by this method. Otherwise, unchanged: the resolved Node command and `<cliEntry> serve`.
   * Shared by the panel's Save flow and the activation-time stale-integration refresh so both
   * always agree on what "the current version" looks like. */
  async integrationDefinition(): Promise<{ command: string; args: string[]; env?: Record<string, string> }> {
    const [installJson, node] = await Promise.all([this.ensureInstallInfo(), this.node()]);
    const environment = this.persistedEnvironment(node);
    if (installJson && this.machineInstallUsable(installJson)) {
      return {
        command: installJson.identity.command,
        args: [...installJson.identity.args],
        env: {
          ...environment,
          ...(installJson.runtime.source === "electron" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          M365_AGENT_MANAGED: "1"
        }
      };
    }
    return {
      command: node.command,
      args: [this.cliEntry(), "serve"],
      ...(Object.keys(environment).length > 0 ? { env: environment } : {})
    };
  }

  /** §4.7 C9: the same `%LOCALAPPDATA%`/home-directory prefixes the CLI's terminal host reports,
   * so a workspace file the extension writes is just as portable to a teammate on the same OS. */
  integrationVariables(): IntegrationVariables | undefined {
    return integrationVariablesFor({
      env: process.env,
      platform: process.platform,
      homedir: this.homeDirectory()
    });
  }

  /** §4.4/§4.7 C5: the VS Code *user-profile* `mcp.json` this machine's default profile would use
   * -- the file `apl-setup`'s default `vscodeUser` writer targets. Sort order 200 (user profile)
   * already beats this provider's 300 (extension), so a managed/legacy entry there would silently
   * disable the provider's copy anyway; the provider checks this path itself (mcp-provider.ts) so
   * it can log why, instead of registering a definition VS Code will never actually enable. */
  vscodeUserMcpJsonPath(): string {
    return path.join(
      vscodeUserDir({ env: process.env, platform: process.platform, homedir: this.homeDirectory() }),
      "mcp.json"
    );
  }
}

/** §P2: a one-line, value-free description of why `install.json` could not be read. A Zod error's
 * own `message` quotes the offending values; only the number of issues and the property paths they
 * are at may be logged. */
function describeInstallJsonFailure(error: unknown): string {
  const issues = (error as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const paths = issues
      .map((issue) => {
        const issuePath = (issue as { path?: unknown }).path;
        return Array.isArray(issuePath) ? issuePath.join(".") : "";
      })
      .filter((value) => value.length > 0);
    return `install.json invalid (${issues.length} issue${issues.length === 1 ? "" : "s"} at ${
      paths.length > 0 ? paths.join(", ") : "<root>"
    })`;
  }
  return "install.json invalid (it could not be parsed)";
}
