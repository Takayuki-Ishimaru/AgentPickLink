import type { CommandDeps } from "../command-deps.js";

export async function runWorkspaceList(deps: CommandDeps): Promise<Record<string, unknown>> {
  const workspace = await deps.workspaces.load(deps.root());
  return { path: workspace.root, workspaceKey: workspace.workspaceKey, agents: workspace.config.agents };
}
