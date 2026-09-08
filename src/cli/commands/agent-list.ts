import { loadRegistry } from "../../config/registry.js";
import { loadGlobalConfig } from "../../config/global-config.js";
import type { AgentView } from "../../frontend/schemas.js";
import type { CommandDeps } from "../command-deps.js";
import { publicAgent } from "../ui/formatter.js";

export async function runAgentList(deps: CommandDeps): Promise<{ agents: AgentView[] }> {
  const [registry, config] = await Promise.all([loadRegistry(deps.paths), loadGlobalConfig(deps.paths)]);
  return {
    agents: registry.agents.map((agent) => publicAgent(agent, config.security.allowedCapabilityClasses))
  };
}
