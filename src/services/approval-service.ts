import type { ApprovalStore, WorkspaceApproval } from "../domain/approval.js";
import {
  deriveBindingFingerprint,
  SUPPORTED_BROWSER_ADAPTER_IDS,
  type BrowserAgentDefinition
} from "../domain/agent.js";
import type { CapabilityClass } from "../domain/agent.js";
import type { WorkspaceContext } from "../domain/workspace.js";
import { DomainError } from "../domain/errors.js";
export type ApprovalStatus = "approved" | "approval-required" | "binding-mismatch";
export class ApprovalService {
  private readonly allowedCapabilityClasses: Set<CapabilityClass>;
  constructor(
    private readonly store: ApprovalStore,
    allowedCapabilityClasses: readonly CapabilityClass[] = ["knowledge-only"]
  ) {
    this.allowedCapabilityClasses = new Set(allowedCapabilityClasses);
  }
  get(workspaceKey: string): WorkspaceApproval | undefined {
    return this.store.approvals.find((approval) => approval.workspaceKey === workspaceKey);
  }
  status(workspace: WorkspaceContext, agents: Map<string, BrowserAgentDefinition>): ApprovalStatus {
    const approval = this.get(workspace.workspaceKey);
    if (!approval) return "approval-required";
    for (const requested of workspace.config.agents) {
      const agent = agents.get(requested.alias);
      const approved = approval.approvedBindings.find((binding) => binding.alias === requested.alias);
      if (!agent || !approved) return "approval-required";
      if (
        !agent.enabled ||
        agent.verification.status !== "verified" ||
        agent.capabilityClass === "unknown" ||
        !this.allowedCapabilityClasses.has(agent.capabilityClass) ||
        !SUPPORTED_BROWSER_ADAPTER_IDS.has(agent.verification.adapterId)
      )
        return "approval-required";
      if (
        deriveBindingFingerprint(agent) !== agent.verification.bindingFingerprint ||
        approved.bindingFingerprint !== agent.verification.bindingFingerprint ||
        (requested.bindingFingerprint &&
          requested.bindingFingerprint !== agent.verification.bindingFingerprint)
      )
        return "binding-mismatch";
    }
    return "approved";
  }
  assertApproved(workspace: WorkspaceContext, agent: BrowserAgentDefinition): void {
    const requested = workspace.config.agents.find((item) => item.alias === agent.alias);
    if (!requested)
      throw new DomainError("AGENT_NOT_ASSIGNED", "The requested agent is not assigned to this workspace.");
    if (
      requested.bindingFingerprint &&
      requested.bindingFingerprint !== agent.verification.bindingFingerprint
    )
      throw new DomainError(
        "AGENT_BINDING_MISMATCH",
        "The workspace binding fingerprint does not match the local agent."
      );
    if (!SUPPORTED_BROWSER_ADAPTER_IDS.has(agent.verification.adapterId))
      throw new DomainError("AGENT_ENTRYPOINT_UNSUPPORTED", "The agent uses an unsupported browser adapter.");
    const approval = this.get(workspace.workspaceKey);
    if (!approval)
      throw new DomainError("WORKSPACE_APPROVAL_REQUIRED", "This workspace has not been approved locally.");
    const binding = approval.approvedBindings.find((item) => item.alias === agent.alias);
    if (!binding)
      throw new DomainError(
        "WORKSPACE_APPROVAL_REQUIRED",
        "This requested agent has not been approved locally."
      );
    if (binding.bindingFingerprint !== agent.verification.bindingFingerprint)
      throw new DomainError("AGENT_BINDING_MISMATCH", "The approved binding does not match the local agent.");
    if (
      binding.capabilityClass !== agent.capabilityClass ||
      !this.allowedCapabilityClasses.has(binding.capabilityClass)
    )
      throw new DomainError(
        "AGENT_CAPABILITY_BLOCKED",
        "The approved agent capability class is blocked by local policy."
      );
  }
  approve(workspace: WorkspaceContext, agents: BrowserAgentDefinition[]): WorkspaceApproval {
    const bindings = workspace.config.agents.map((requested) => {
      const agent = agents.find((item) => item.alias === requested.alias);
      if (!agent)
        throw new DomainError("AGENT_NOT_FOUND", `Agent ${requested.alias} is not in the local registry.`);
      if (!agent.enabled) throw new DomainError("AGENT_DISABLED", `Agent ${requested.alias} is disabled.`);
      if (agent.verification.status !== "verified")
        throw new DomainError("AGENT_UNVERIFIED", `Agent ${requested.alias} is not verified.`);
      if (deriveBindingFingerprint(agent) !== agent.verification.bindingFingerprint)
        throw new DomainError(
          "AGENT_BINDING_MISMATCH",
          `Agent ${requested.alias} no longer matches its verified binding.`
        );
      if (!SUPPORTED_BROWSER_ADAPTER_IDS.has(agent.verification.adapterId))
        throw new DomainError(
          "AGENT_ENTRYPOINT_UNSUPPORTED",
          `Agent ${requested.alias} uses an unsupported browser adapter.`
        );
      if (agent.capabilityClass === "unknown" || !this.allowedCapabilityClasses.has(agent.capabilityClass))
        throw new DomainError(
          "AGENT_CAPABILITY_BLOCKED",
          `Agent ${requested.alias} has a capability class blocked by local policy. Allowed: ${[
            ...this.allowedCapabilityClasses
          ].join(", ")}.`
        );
      if (
        requested.bindingFingerprint &&
        requested.bindingFingerprint !== agent.verification.bindingFingerprint
      )
        throw new DomainError("AGENT_BINDING_MISMATCH", `Agent ${requested.alias} has a mismatched binding.`);
      return {
        alias: requested.alias,
        bindingFingerprint: agent.verification.bindingFingerprint,
        capabilityClass: agent.capabilityClass
      };
    });
    const next: WorkspaceApproval = {
      workspaceKey: workspace.workspaceKey,
      approvedBindings: bindings,
      approvedConfigDigest: workspace.configDigest,
      approvedAt: new Date().toISOString(),
      approvalVersion: 1
    };
    this.store.approvals = [
      ...this.store.approvals.filter((item) => item.workspaceKey !== workspace.workspaceKey),
      next
    ];
    return next;
  }
  revoke(workspaceKey: string): void {
    this.store.approvals = this.store.approvals.filter((item) => item.workspaceKey !== workspaceKey);
  }
}
