import * as vscode from "vscode";
import path from "node:path";
import { DomainError } from "../domain/errors.js";
import type { ExtensionRuntime } from "./runtime.js";

/** Only invoked by the panel/command's explicit action; no activation hook installs anything. */
export async function openMachineInstallTerminal(runtime: ExtensionRuntime): Promise<vscode.Terminal> {
  const workspace = runtime.workspaceRoot();
  if (!vscode.workspace.isTrusted || !workspace)
    throw new DomainError("WORKSPACE_ROOT_UNAVAILABLE", "Open and trust one workspace before installing.");
  const node = await runtime.node();
  const terminal = vscode.window.createTerminal({
    name: "AgentPickLink install",
    shellPath: node.command,
    // Always stage the extension's own bundled tree, even when cliEntry follows a machine install.
    shellArgs: [
      path.join(runtime.extensionRoot, "dist", "cli", "index.js"),
      "install",
      "--from-extension",
      "--workspace",
      workspace
    ],
    cwd: workspace,
    env: runtime.childEnvironment(node),
    isTransient: true
  });
  terminal.show();
  return terminal;
}
