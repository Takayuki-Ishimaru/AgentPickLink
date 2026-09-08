import { loadApprovals, saveApprovals } from "../../config/approvals.js";
import { loadRegistry } from "../../config/registry.js";
import { loadGlobalConfig } from "../../config/global-config.js";
import { DomainError } from "../../domain/errors.js";
import { ApprovalService } from "../../services/approval-service.js";
import type { CommandDeps } from "../command-deps.js";
import { approvalSummaryLines } from "../ui/formatter.js";
import { withYes } from "../ui/prompts.js";

/**
 * §10.3: must display the normalized workspace location, every requested alias with its local
 * display name and capability class, verification state, binding-fingerprint match, and a
 * warning that Microsoft 365 responses will enter GitHub Copilot context -- then require
 * explicit confirmation. Approval is never inferred from opening the repository or an MCP call.
 */
export async function runWorkspaceApprove(
  deps: CommandDeps,
  options?: { yes?: boolean }
): Promise<Record<string, unknown>> {
  const workspace = await deps.workspaces.load(deps.root());
  const [registry, approvals, config] = await Promise.all([
    loadRegistry(deps.paths),
    loadApprovals(deps.paths),
    loadGlobalConfig(deps.paths)
  ]);
  const details = workspace.config.agents.map((requested) => {
    const agent = registry.agents.find((item) => item.alias === requested.alias);
    return {
      alias: requested.alias,
      displayName: agent?.displayName,
      capabilityClass: agent?.capabilityClass,
      verificationStatus: agent?.verification.status ?? "missing",
      bindingMatches:
        !!agent &&
        (!requested.bindingFingerprint ||
          requested.bindingFingerprint === agent.verification.bindingFingerprint)
    };
  });
  deps.stderr(`${approvalSummaryLines(workspace.root, details).join("\n")}\n`);
  const prompter = withYes(deps.prompter, !!options?.yes);
  if (!(await prompter.confirm("Approve exactly these local agent bindings for this workspace?")))
    throw new DomainError("INVALID_ARGUMENT", "Workspace approval was not confirmed.");
  const approval = new ApprovalService(approvals, config.security.allowedCapabilityClasses).approve(
    workspace,
    registry.agents
  );
  await saveApprovals(deps.paths, approvals);
  return {
    approved: true,
    workspaceKey: workspace.workspaceKey,
    approvedBindings: approval.approvedBindings
  };
}
