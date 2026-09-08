import type { CapabilityClass } from "./agent.js";

export type ApprovedAgentBinding = {
  alias: string;
  bindingFingerprint: string;
  capabilityClass: Exclude<CapabilityClass, "unknown">;
};
export type WorkspaceApproval = {
  workspaceKey: string;
  approvedBindings: ApprovedAgentBinding[];
  approvedConfigDigest: string;
  approvedAt: string;
  approvalVersion: 1;
};
export type ApprovalStore = { version: 1; approvals: WorkspaceApproval[] };
