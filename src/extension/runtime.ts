/**
 * Process-wide services the extension's commands, webview and providers share: application paths,
 * the resolved Node runtime, the output channel and the settings the panel exposes.
 *
 * The output channel is the extension's only log sink -- `no-console` is an error in this
 * repository and, more importantly, prompt/response text must never be logged (only phases,
 * counts and error codes reach `log()`).
 */
import * as vscode from "vscode";
import os from "node:os";
import path from "node:path";
import { appPaths, type AppPaths } from "../config/paths.js";
import type { IntegrationFlags, Locale } from "./protocol.js";
import { pickLocale } from "./localize.js";
import { resolveNodeRuntime, type NodeRuntimeResolution } from "./node-runtime.js";
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

  /** Resolved once per window (and again after `agentpicklink.nodePath` changes). */
  node(): Promise<NodeRuntimeResolution> {
    this.nodeRuntime ??= resolveNodeRuntime(this.configuration().get<string>("nodePath")).then(
      (resolution) => {
        for (const warning of resolution.warnings) this.log(`node: ${warning}`);
        this.log(`node: using ${resolution.kind} runtime (${resolution.version ?? "electron"})`);
        return resolution;
      }
    );
    return this.nodeRuntime;
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

  brokerEntry(): string {
    return path.join(this.extensionRoot, "dist", "broker", "process.js");
  }

  cliEntry(): string {
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

  /** The `IntegrationDefinition` written to every on-disk MCP client configuration file: the
   * resolved Node command, `<cliEntry> serve`, and only the environment safe to persist. Shared by
   * the panel's Save flow and the activation-time stale-integration refresh so both always agree on
   * what "the current version" looks like. */
  async integrationDefinition(): Promise<{ command: string; args: string[]; env?: Record<string, string> }> {
    const node = await this.node();
    const environment = this.persistedEnvironment(node);
    return {
      command: node.command,
      args: [this.cliEntry(), "serve"],
      ...(Object.keys(environment).length > 0 ? { env: environment } : {})
    };
  }
}
