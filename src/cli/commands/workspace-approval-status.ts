import { loadApprovals } from "../../config/approvals.js";
import { loadRegistry } from "../../config/registry.js";
import { ApprovalService } from "../../services/approval-service.js";
import type { CommandDeps } from "../command-deps.js";

export async function runWorkspaceApprovalStatus(deps: CommandDeps): Promise<Record<string, unknown>> {
  const workspace = await deps.workspaces.load(deps.root());
  const registry = await loadRegistry(deps.paths);
  const approvals = await loadApprovals(deps.paths);
  return {
    workspaceKey: workspace.workspaceKey,
    status: new ApprovalService(approvals).status(
      workspace,
      new Map(registry.agents.map((agent) => [agent.alias, agent]))
    )
  };
}
