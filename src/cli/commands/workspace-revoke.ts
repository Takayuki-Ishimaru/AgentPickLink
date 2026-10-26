import { updateApprovals } from "../../config/approvals.js";
import { ApprovalService } from "../../services/approval-service.js";
import type { CommandDeps } from "../command-deps.js";

export async function runWorkspaceRevoke(deps: CommandDeps): Promise<Record<string, unknown>> {
  const workspace = await deps.workspaces.load(deps.root());
  await updateApprovals(deps.paths, (approvals) => {
    new ApprovalService(approvals).revoke(workspace.workspaceKey);
  });
  const client = await deps.connectExistingBroker(deps.paths).catch(() => undefined);
  if (client) {
    try {
      await client.call("conversation.closeAllForWorkspace", { root: workspace.root });
    } catch {
      /* policy state is already revoked */
    } finally {
      client.close();
    }
  }
  return { revoked: true, workspaceKey: workspace.workspaceKey };
}
