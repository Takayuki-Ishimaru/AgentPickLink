/**
 * Exposes the workspace's approved Microsoft 365 agents to VS Code's own MCP support
 * (`vscode.lm.registerMcpServerDefinitionProvider`, VS Code 1.101+). The server is the unchanged
 * stdio frontend: `node <extension>/dist/cli/index.js serve`, started in the workspace folder so
 * it resolves the same `.m365-agents.json` the user approved.
 *
 * No definition is offered until `.m365-agents.json` exists: without it the frontend would only be
 * able to answer with `WORKSPACE_NOT_CONFIGURED`.
 */
import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionRuntime } from "./runtime.js";

export const MCP_PROVIDER_ID = "agentpicklink.mcp";
export const MCP_SERVER_LABEL = "m365-agents";
export const WORKSPACE_FILE = ".m365-agents.json";

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export class AgentPickLinkMcpProvider implements vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.changed.event;

  constructor(private readonly runtime: ExtensionRuntime) {}

  /** Tells VS Code to re-read the definitions (called after Save and after a broker restart). */
  refresh(): void {
    this.changed.fire();
  }

  async provideMcpServerDefinitions(): Promise<vscode.McpStdioServerDefinition[]> {
    const folder = this.runtime.workspaceFolder();
    if (!folder) return [];
    if (!vscode.workspace.isTrusted) {
      this.runtime.log("mcp: the workspace is not trusted; offering no server definition");
      return [];
    }
    if (!(await fileExists(path.join(folder.uri.fsPath, WORKSPACE_FILE)))) {
      this.runtime.log(`mcp: no ${WORKSPACE_FILE} in the workspace; offering no server definition`);
      return [];
    }
    const node = await this.runtime.node();
    const definition = new vscode.McpStdioServerDefinition(
      MCP_SERVER_LABEL,
      node.command,
      [this.runtime.cliEntry(), "serve"],
      this.runtime.extraEnvironment(node),
      this.runtime.version
    );
    definition.cwd = folder.uri;
    this.runtime.log(`mcp: offering "${MCP_SERVER_LABEL}" for ${folder.uri.fsPath}`);
    return [definition];
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/**
 * Registers the provider when the running VS Code build has the API. Returns the provider either
 * way so Save can still call `refresh()` unconditionally.
 */
export function registerMcpProvider(
  runtime: ExtensionRuntime,
  context: vscode.ExtensionContext
): AgentPickLinkMcpProvider {
  const provider = new AgentPickLinkMcpProvider(runtime);
  context.subscriptions.push(provider);
  const register = vscode.lm?.registerMcpServerDefinitionProvider;
  if (typeof register !== "function") {
    runtime.log("mcp: this VS Code build has no MCP server definition provider API; skipping.");
    return provider;
  }
  try {
    context.subscriptions.push(register(MCP_PROVIDER_ID, provider));
    runtime.log(`mcp: registered provider ${MCP_PROVIDER_ID}`);
  } catch (error) {
    runtime.log(`mcp: provider registration failed: ${error instanceof Error ? error.message : error}`);
  }
  return provider;
}
