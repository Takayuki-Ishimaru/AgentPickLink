import type { GlobalConfig } from "../config/schema.js";
import type { Registry } from "../config/registry.js";
import type { ApprovalStore } from "../domain/approval.js";
import type { BrowserAgentDefinition } from "../domain/agent.js";
import type { WorkspaceContext } from "../domain/workspace.js";
import { DomainError } from "../domain/errors.js";
import { AgentService } from "./agent-service.js";
import { ApprovalService } from "./approval-service.js";
import { WorkspaceService } from "./workspace-service.js";

/** The three local stores every policy decision is re-derived from. Injected as loaders (rather
 * than as already-loaded values) because §28.3 requires the broker to reload workspace config,
 * registry, and approvals immediately before every invocation -- never to cache a decision. */
export type PolicyStores = {
  config: () => Promise<GlobalConfig>;
  registry: () => Promise<Registry>;
  approvals: () => Promise<ApprovalStore>;
};
export type AuthorizedAgent = { workspace: WorkspaceContext; agent: BrowserAgentDefinition };

/**
 * The single place the §28.3 fail-fast policy chain is composed: topology/workspace root and
 * config (WorkspaceService) -> alias actually requested by the workspace -> registry entry
 * eligibility, binding fingerprint, adapter support, capability class (AgentService) -> local
 * approval of that exact binding (ApprovalService). `authorize` is the one function both
 * conversation.invoke and conversation.list go through, so a revoked or changed policy can never
 * be visible to one and not the other.
 */
export class PolicyService {
  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly stores: PolicyStores
  ) {}

  /** Workspace resolution only (no agent decision): used where the caller is scoping an
   * operation to a workspace rather than authorizing an agent. */
  loadWorkspace(root: string): Promise<WorkspaceContext> {
    return this.workspaces.load(root);
  }

  /** §28.3 fail-fast order. Throws the first DomainError that applies; never starts a browser. */
  async authorize(root: string, alias: string): Promise<AuthorizedAgent> {
    const workspace = await this.loadWorkspace(root);
    if (!workspace.config.agents.some((item) => item.alias === alias))
      throw new DomainError("AGENT_NOT_ASSIGNED", "The requested agent is not assigned to this workspace.");
    const { agents, approvals } = await this.load();
    const agent = agents.assertEligible(alias);
    approvals.assertApproved(workspace, agent);
    return { workspace, agent };
  }

  /** Registry eligibility without a workspace, for the workspace-independent admin path
   * (`agent.validate`). It never implies local approval for any workspace. */
  async assertEligible(alias: string): Promise<BrowserAgentDefinition> {
    const [config, registry] = await Promise.all([this.stores.config(), this.stores.registry()]);
    return new AgentService(registry, config).assertEligible(alias);
  }

  /**
   * The public roster for `workspace.list`. Every ineligibility reason is deliberately collapsed
   * into "approval-required" so a repository cannot infer whether an unapproved alias exists in
   * the user's registry, or why its local binding is currently ineligible.
   */
  async roster(root: string): Promise<Record<string, unknown>> {
    let workspace: WorkspaceContext;
    try {
      workspace = await this.loadWorkspace(root);
    } catch (error) {
      if (error instanceof DomainError && error.code === "WORKSPACE_NOT_CONFIGURED")
        return { workspace: { configured: false, approvalStatus: "not-configured" }, agents: [] };
      if (error instanceof DomainError && error.code === "WORKSPACE_CONFIG_INVALID")
        return { workspace: { configured: true, approvalStatus: "invalid" }, agents: [] };
      throw error;
    }
    const { agents: agentService, approvals } = await this.load();
    const agents = workspace.config.agents.map((requested) => {
      const remediation =
        "Open the AgentPickLink panel in VS Code, review the selected agents, and press Save to approve this workspace. For diagnostics, run AgentPickLink: Copy diagnostics from the command palette.";
      try {
        const candidate = agentService.assertEligible(requested.alias);
        approvals.assertApproved(workspace, candidate);
        return {
          alias: requested.alias,
          name: candidate.displayName,
          kind: candidate.kind,
          description: candidate.description,
          usageHint: candidate.usageHint,
          capabilityClass: candidate.capabilityClass,
          status: "ready" as const,
          lastValidatedAt: candidate.verification.validatedAt
        };
      } catch {
        // Do not let a repository infer whether an unapproved alias exists in
        // the user's registry or why its local binding is currently ineligible.
        return { alias: requested.alias, status: "approval-required" as const, remediation };
      }
    });
    return {
      workspace: {
        configured: true,
        approvalStatus: agents.every((item) => item.status === "ready") ? "approved" : "approval-required"
      },
      agents
    };
  }

  private async load(): Promise<{ agents: AgentService; approvals: ApprovalService }> {
    const [config, registry, store] = await Promise.all([
      this.stores.config(),
      this.stores.registry(),
      this.stores.approvals()
    ]);
    return {
      agents: new AgentService(registry, config),
      approvals: new ApprovalService(store, config.security.allowedCapabilityClasses)
    };
  }
}
