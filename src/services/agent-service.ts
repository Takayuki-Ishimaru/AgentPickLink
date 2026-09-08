import type { GlobalConfig } from "../config/schema.js";
import type { Registry } from "../config/registry.js";
import {
  deriveBindingFingerprint,
  SUPPORTED_BROWSER_ADAPTER_IDS,
  type BrowserAgentDefinition
} from "../domain/agent.js";
import { DomainError } from "../domain/errors.js";
import { isCapabilityAllowed } from "../domain/policy.js";
export class AgentService {
  constructor(
    private readonly registry: Registry,
    private readonly config: GlobalConfig
  ) {}
  get(alias: string): BrowserAgentDefinition {
    const agent = this.registry.agents.find((item) => item.alias === alias);
    if (!agent)
      throw new DomainError(
        "AGENT_NOT_FOUND",
        "The requested Microsoft 365 agent is not in the local registry."
      );
    return agent;
  }
  assertEligible(alias: string): BrowserAgentDefinition {
    const agent = this.get(alias);
    if (!agent.enabled) throw new DomainError("AGENT_DISABLED", "The requested agent is disabled.");
    if (agent.verification.status !== "verified")
      throw new DomainError("AGENT_UNVERIFIED", "The requested agent is not verified.");
    if (deriveBindingFingerprint(agent) !== agent.verification.bindingFingerprint)
      throw new DomainError(
        "AGENT_BINDING_MISMATCH",
        "The registry entry no longer matches its verified binding fingerprint."
      );
    if (!SUPPORTED_BROWSER_ADAPTER_IDS.has(agent.verification.adapterId))
      throw new DomainError(
        "AGENT_ENTRYPOINT_UNSUPPORTED",
        "The verified browser adapter is not supported by this version."
      );
    if (!isCapabilityAllowed(agent.capabilityClass, this.config.security.allowedCapabilityClasses))
      throw new DomainError(
        "AGENT_CAPABILITY_BLOCKED",
        "The requested agent capability class is blocked by local policy."
      );
    return agent;
  }
}
