/**
 * The terminal implementation of `SetupHost` (docs/extension-less-onboarding.md §4.1, WP-B): the
 * `install` command's `apl-setup` sequence and `SetupController` drive exactly the same state
 * machine the `agentpicklink.setup` webview does (`src/extension/setup-view.ts`); only rendering
 * and confirmation differ.
 *
 * Like the webview host, this only ever receives data (`PanelState`) and renders it -- it never
 * prints prompt/response text, and the only URLs it can ever show are the ones already present in
 * `PanelState` today (none: the panel itself never renders a candidate's URL either). `log()` lines
 * carry the same metadata-only invariant as the panel's hidden output channel and are intentionally
 * not printed to the terminal by default -- the phase/progress/error/incident lines below are the
 * terminal's user-facing equivalent of that channel.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppPaths } from "../config/paths.js";
import { loadGlobalConfig, saveGlobalConfig } from "../config/global-config.js";
import type { GlobalConfig } from "../config/schema.js";
import { persistedEnvironment } from "../services/env-policy.js";
import {
  buildStamp,
  identityFor,
  integrationVariablesFor,
  readInstallJson
} from "../services/install-home.js";
import type { IntegrationDefinition, IntegrationVariables } from "../services/integrations.js";
import {
  describeDiscoverySummary,
  describeErrorCode,
  describePanelPhase,
  translator
} from "../services/localize.js";
import type {
  BrokerHealthSnapshot,
  ConfirmRequest,
  Disposable,
  SaveSummary,
  SetupHost
} from "../services/setup-controller.js";
import type {
  HostMessage,
  IntegrationFlags,
  Locale,
  PanelProgress,
  PanelState
} from "../services/setup-protocol.js";
import type { StatusKind } from "../services/setup-status.js";
import type { Prompter } from "./ui/prompts.js";

export type ClientFlags = GlobalConfig["clients"];

export type TerminalSetupHostOptions = {
  locale: Locale;
  /** The running package's own version (`package.json` `version`), shown in diagnostics and used
   * as the `M365_AGENT_BUILD` stamp together with `build`. */
  version: string;
  build?: string;
  /** The shared `M365AgentWorkspace` application-data paths (config.yaml, logs, ...) -- distinct
   * from `installHome`, the `<home>` this `install` run is staging into. */
  paths: AppPaths;
  /** `<home>` (docs/extension-less-onboarding.md §3.2): `<home>/bin/node` + `<home>/bin/apl.js`. */
  installHome: string;
  platform: NodeJS.Platform;
  /** The workspace this host is currently driving `SetupController` for. `install` constructs one
   * host per workspace (see src/cli/commands/install.ts) so `apply()`/`save()` never mix up two
   * workspaces' approvals; sign-in and the registry are still shared because they live in the
   * broker and in `agents.yaml`, not in this object. */
  workspaceRoot: string;
  /** `<home>/app/<version>/dist/broker/process.js` once `install.json` exists, else this running
   * package's own `dist/broker/process.js` -- resolved once by `resolveBrokerEntry` before the host
   * is constructed, because `SetupHost.brokerEntry()` is synchronous. */
  brokerEntry: string;
  /** Writes one line to the terminal -- `text` never carries its own trailing newline, so the
   * caller's `out` is expected to add one (e.g. `(line) => process.stdout.write(`${line}\n`)`).
   * Every `SetupHost` method below funnels its user-facing output through this single seam so a
   * test can assert on exactly what a real run would print, one call per line. */
  out: (text: string) => void;
  /**
   * The *unwrapped* prompter -- never pre-wrapped with `withYes()` (docs/extension-less-onboarding.md
   * §3.1's Consent rule, P0-3): `--yes` answers only the install-plan confirmation, which `install`
   * asks directly, outside this host, before staging begins. `confirm()` below decides for itself,
   * per `ConfirmRequest.kind` and the three flags below, whether a given confirmation may be
   * auto-answered non-interactively.
   */
  prompter: Prompter;
  /** `--yes`: may auto-answer a `"plan"`-kind confirmation (e.g. "open the sign-in browser now?")
   * non-interactively. Never bypasses `"agents"`/`"widening"`. */
  yes?: boolean;
  /** `--approve-agents`: may auto-answer the agent-roster approval (`ConfirmRequest.kind ===
   * "agents"`) non-interactively. */
  approveAgents?: boolean;
  /** `--allow-actions-possible`: may auto-answer the capability-widening consent
   * (`ConfirmRequest.kind === "widening"`) non-interactively. */
  allowActionsPossible?: boolean;
  /** Used only to compute `integrationVariables()` (§4.7 C9); never read for anything else. */
  env: NodeJS.ProcessEnv;
  /** `--verbose`: when given, every `log()` line is also written here (stderr, in practice),
   * prefixed `[log]`, in addition to always being appended to the app-data log file under
   * `paths.logs` (ISSUE-09). Metadata only, same invariant as `log()` itself -- never anything
   * `log()` was not already going to write. Absent by default, matching the pre-existing silent
   * behavior of a normal (non-`--verbose`) run. */
  verboseOut?: (text: string) => void;
  /** The invoking user's OS home directory (`CommandDeps.homedir()`): used for
   * `~/.codex/config.toml` and as the base for `integrationVariables()`. Always injected -- never
   * a bare `os.homedir()` call -- so a test's fake home directory is honored end to end instead of
   * this host quietly touching the real one. */
  homedir: () => string;
};

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const CLI_LOG_FILE = "cli.log";

/**
 * ISSUE-09 (docs/validation-log-2026-09-14-windows.md): `TerminalSetupHost.log()` used to discard
 * every line outright, so a run that hit the broker-release wait (`broker-staleness.ts`'s
 * `waitForBrokerFullyReleased`) or a stale-broker restart left no trace anywhere -- not even for a
 * later `doctor`/support investigation. Every line reaching here already carries the same
 * metadata-only invariant `post()` documents above (phase names, elapsed times, known condition
 * names -- never prompt/response text), so persisting it is safe.
 *
 * Appended under `paths.logs` (the same directory `src/observability/audit.ts`'s `AuditLogger`
 * writes into, with the same private-file convention: `mkdir` 0o700, `appendFile` 0o600) rather
 * than rotated -- this codebase has no log-rotation writer to reuse yet, so this deliberately
 * stays as simple as the audit log it sits next to instead of inventing one. Best-effort: a failed
 * write must never turn an otherwise-successful command into a failure.
 */
export async function appendCliLog(paths: Pick<AppPaths, "logs">, line: string): Promise<void> {
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  await appendFile(path.join(paths.logs, CLI_LOG_FILE), `${new Date().toISOString()} ${line}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

/** The phase/message text here is already whatever the domain layer produced (English, metadata
 * only); there is nothing left to localize beyond the surrounding lines `post()` adds. */
function progressLine(progress: PanelProgress): string {
  const seconds = progress.elapsedMs !== undefined ? Math.round(progress.elapsedMs / 1000) : undefined;
  const parts = [
    progress.phase,
    progress.message,
    seconds !== undefined ? `${seconds}s` : undefined,
    progress.current !== undefined && progress.total !== undefined
      ? `${progress.current}/${progress.total}`
      : undefined
  ].filter((part): part is string => !!part && part.length > 0);
  return parts.join(" - ");
}

/** `<home>/app/<version>/dist/broker/process.js` when `install.json` already exists (an `install`
 * that already staged a version, or a later `self`/`serve` invocation), else `ownBrokerEntry` --
 * this running package's own `dist/broker/process.js` (§4.7 C13: "one broker per user, from the
 * machine install", falling back to "my own tree" before any machine install exists). */
export async function resolveBrokerEntry(home: string, ownBrokerEntry: string): Promise<string> {
  const installJson = await readInstallJson(home).catch(() => undefined);
  if (!installJson) return ownBrokerEntry;
  return path.join(home, "app", installJson.version, "dist", "broker", "process.js");
}

/** `SetupHost.integrationFlags()` is synchronous, so the `clients:` block has to be loaded before
 * the host exists. Use this instead of the constructor directly. */
export async function createTerminalSetupHost(options: TerminalSetupHostOptions): Promise<TerminalSetupHost> {
  const config = await loadGlobalConfig(options.paths);
  return new TerminalSetupHost(options, config.clients);
}

export class TerminalSetupHost implements SetupHost {
  readonly locale: Locale;
  readonly version: string;
  readonly paths: AppPaths;

  private clients: ClientFlags;
  private lastState?: PanelState;
  private lastSaveSummary?: SaveSummary;

  constructor(
    private readonly options: TerminalSetupHostOptions,
    initialClients: ClientFlags
  ) {
    this.locale = options.locale;
    this.version = options.version;
    this.paths = options.paths;
    this.clients = initialClients;
  }

  /** Repoints this host at another workspace between `install`'s per-workspace iterations (see the
   * `workspaceRoot` doc comment above): the running package version, install home, and the
   * sign-in/registry state a fresh `SetupController` reconnects to are unaffected. */
  setWorkspaceRoot(workspaceRoot: string): void {
    this.options.workspaceRoot = workspaceRoot;
  }

  /** The most recent `saved()` call's summary, for `install`'s per-workspace report line. */
  savedSummary(): SaveSummary | undefined {
    return this.lastSaveSummary;
  }

  /** The most recent `PanelState` this host rendered -- `install` reads `candidates`/`selectedKeys`
   * off it after `runSetup()`/`runDiscover()` to drive its own selection step (numbered multi-select
   * or `--agents`), the same list the panel would show. */
  lastPanelState(): PanelState | undefined {
    return this.lastState;
  }

  /* -------------------------------------------------------------- rendering */

  post(message: HostMessage): void {
    const state = message.state;
    const previous = this.lastState;
    this.lastState = state;
    const t = translator(this.locale);

    if (!previous || previous.phase !== state.phase)
      this.options.out(`> ${describePanelPhase(this.locale, state.phase)}`);

    if (state.progress && !sameJson(state.progress, previous?.progress)) {
      const line = progressLine(state.progress);
      if (line.length > 0) this.options.out(`  ${line}`);
    }

    if (state.discoverySummary && !sameJson(state.discoverySummary, previous?.discoverySummary)) {
      this.options.out(
        t("cliDiscoverySummary")
          .replace("{total}", String(state.discoverySummary.total))
          .replace("{descriptions}", String(state.discoverySummary.descriptions))
      );
      // WP-D: the count-bearing notice takes over from the older generic `cliDiscoveryPartial`
      // line whenever the summary is partial (`describeDiscoverySummary` returns undefined only
      // when it is not).
      const partialNotice = describeDiscoverySummary(state.discoverySummary, this.locale);
      if (partialNotice) this.options.out(`  ${partialNotice}`);
    }

    if (state.error && !sameJson(state.error, previous?.error)) {
      const described = describeErrorCode(this.locale, state.error.code);
      this.options.out(`! ${described?.summary ?? state.error.message} (${state.error.code})`);
      const remediation = described?.remediation ?? state.error.remediation;
      if (remediation) this.options.out(`  ${remediation}`);
    }

    if (state.incidents.length > 0 && !sameJson(state.incidents, previous?.incidents)) {
      for (const incident of state.incidents)
        this.options.out(
          `  ${t("cliIncidentLine").replace("{message}", incident.message).replace("{code}", incident.code)}`
        );
    }
  }

  log(line: string): void {
    // Metadata only, same invariant as the panel's hidden output channel -- never echoed to the
    // terminal's normal (non-`--verbose`) output, so the phase/progress/error/incident lines above
    // stay the whole of what a plain `install` run prints. Never sensitive: see the module doc
    // comment. ISSUE-09: persisted (best-effort) rather than discarded, and, with `--verbose`,
    // also echoed live -- see `appendCliLog`'s doc comment.
    void appendCliLog(this.paths, line).catch(() => undefined);
    this.options.verboseOut?.(`[log] ${line}`);
  }

  /* -------------------------------------------------------------- confirmation / notifications */

  /**
   * §3.1's Consent rule (P0-3): `--yes` may only auto-answer a `"plan"`-kind confirmation; the
   * agent-roster approval (`"agents"`) and the capability-widening consent (`"widening"`) need
   * their own explicit flags (`--approve-agents`, `--allow-actions-possible`). Interactively, none
   * of the three flags matter -- the prompter always asks. Non-interactively, a request whose kind
   * needs a flag that was not given fails closed (resolves `false`) rather than falling through to
   * `prompter.confirm()`, which would itself resolve `false` for the exact same reason but without
   * the chance to name the missing flag first (`install`'s caller does that from the report).
   */
  async confirm(request: ConfirmRequest): Promise<boolean> {
    this.options.out(request.title);
    if (request.detail) this.options.out(request.detail);
    if (!this.options.prompter.interactive && request.kind === "plan" && this.options.yes) return true;
    if (!this.options.prompter.interactive && request.kind === "agents" && this.options.approveAgents)
      return true;
    if (
      !this.options.prompter.interactive &&
      request.kind === "widening" &&
      this.options.allowActionsPossible
    )
      return true;
    if (!this.options.prompter.interactive) {
      this.options.out(translator(this.locale)("cliNoTty"));
      if (request.kind === "agents" || request.kind === "widening") return false;
    }
    return this.options.prompter.confirm(request.confirmLabel);
  }

  notify(level: "info" | "warning", text: string): void {
    this.options.out(level === "warning" ? `! ${text}` : text);
    // ISSUE-10 (docs/validation-log-2026-09-14-windows-round3.md S2): unlike log(), this used to
    // reach only stdout -- a restart-and-retry notice (e.g. installRestartingBrokerRetry) never
    // appeared in cli.log, leaving no persisted trace of a run that recovered from a stale broker.
    // Same metadata-only invariant as log(): this is always already user-facing terminal text.
    void appendCliLog(this.paths, `notice: ${text}`).catch(() => undefined);
  }

  /** No button in a terminal: the text is the whole notice (matches the panel's own text, minus
   * the "Sign in" action button -- signing in again is just re-running `install`). */
  promptSignIn(request: { text: string; actionLabel: string }): void {
    void request.actionLabel;
    this.options.out(request.text);
  }

  async clipboard(text: string): Promise<void> {
    this.options.out(translator(this.locale)("cliClipboardFollows"));
    this.options.out(text);
  }

  async openLogs(): Promise<void> {
    this.options.out(translator(this.locale)("cliLogsAt").replace("{path}", this.paths.logs));
  }

  async hostDiagnostics(): Promise<Record<string, unknown>> {
    return {
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
      runtime: process.execPath
    };
  }

  /* -------------------------------------------------------------- workspace / trust */

  workspaceRoot(): string | undefined {
    return this.options.workspaceRoot;
  }

  trusted(): boolean {
    return true;
  }

  homeDirectory(): string {
    return this.options.homedir();
  }

  /* -------------------------------------------------------------- integrations */

  /** These flags govern only the opt-in, project/workspace-scope files (`.mcp.json`,
   * `.vscode/mcp.json`) driven through `SetupController.save()`; the default, zero-touch
   * user-scope files (`vscodeUser`/`claudeUser`) are written directly by `install` itself,
   * independent of this workspace-scoped Save flow (docs/extension-less-onboarding.md §4.4). */
  integrationFlags(): IntegrationFlags {
    return {
      codex: this.clients.codex,
      claudeCode: this.clients.claudeProject,
      vscodeMcpJson: this.clients.vscodeWorkspace
    };
  }

  async saveIntegrationFlags(flags: IntegrationFlags): Promise<void> {
    this.clients = {
      ...this.clients,
      vscodeWorkspace: flags.vscodeMcpJson,
      claudeProject: flags.claudeCode,
      codex: flags.codex
    };
    const config = await loadGlobalConfig(this.paths);
    await saveGlobalConfig(this.paths, { ...config, clients: { ...config.clients, ...this.clients } });
  }

  /** §3.2/§4.7 C14: the version-independent identity plus the ownership marker and, for a
   * workspace-file target, the cache-busting build stamp. `applyIntegrations` (src/services/
   * integrations.ts) strips `M365_AGENT_BUILD` again for the user-scope Codex entry -- see its
   * `withoutBuildStamp` helper -- so this always returns the same thing regardless of which
   * integration ends up using it. */
  async integrationDefinition(): Promise<IntegrationDefinition> {
    const installed = await readInstallJson(this.options.installHome);
    const identity =
      installed?.identity ?? identityFor({ home: this.options.installHome, platform: this.options.platform });
    const persisted = persistedEnvironment(
      installed?.runtime.source === "electron" ? { ELECTRON_RUN_AS_NODE: "1" } : {},
      this.options.env.M365_AGENT_APP_DATA
    );
    return {
      ...identity,
      env: {
        ...persisted,
        M365_AGENT_MANAGED: "1",
        M365_AGENT_BUILD: buildStamp(this.options.version, this.options.build)
      }
    };
  }

  /** §4.7 C9: derived from this run's own `env`/`platform`/`homeDirectory()`, never from
   * `M365_AGENT_INSTALL_ROOT` (see `integrationVariablesFor`'s doc comment). */
  integrationVariables(): IntegrationVariables | undefined {
    return integrationVariablesFor({
      env: this.options.env,
      platform: this.options.platform,
      homedir: this.homeDirectory()
    });
  }

  brokerEntry(): string {
    return this.options.brokerEntry;
  }

  refreshClients(): void {
    // No MCP client to nudge from here: the CLI just wrote the files; VS Code/Claude Code/Codex
    // pick them up the next time they start or reload (the report's "next steps" say so).
  }

  /* -------------------------------------------------------------- health / status */

  onHealth(_listener: (health: BrokerHealthSnapshot | undefined) => void): Disposable {
    // The CLI has no live health poller (it runs one operation and exits); nothing to subscribe to.
    return { dispose: () => undefined };
  }

  statusChanged(_status: { kind: StatusKind; devMode: boolean }): void {
    // No status bar to update in a terminal.
  }

  async saved(summary: SaveSummary): Promise<void> {
    this.lastSaveSummary = summary;
  }
}
