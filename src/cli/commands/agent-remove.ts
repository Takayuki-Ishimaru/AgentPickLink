import { AliasSchema } from "../../domain/agent.js";
import { DomainError } from "../../domain/errors.js";
import { updateRegistry } from "../../config/registry.js";
import type { CommandDeps } from "../command-deps.js";

export async function runAgentRemove(deps: CommandDeps, alias: string): Promise<Record<string, unknown>> {
  if (!AliasSchema.safeParse(alias).success)
    throw new DomainError(
      "INVALID_ARGUMENT",
      "Agent alias must be lowercase alphanumeric with optional hyphens."
    );
  // Existence check and deletion share one registry lock, so a concurrent registration or
  // removal by another window is never overwritten and `removed` reports current state.
  let removed = false;
  await updateRegistry(deps.paths, (current) => {
    const next = current.agents.filter((agent) => agent.alias !== alias);
    if (next.length === current.agents.length) return false;
    current.agents = next;
    removed = true;
    return true;
  });
  return { removed, alias };
}
