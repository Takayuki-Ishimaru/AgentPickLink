import { AliasSchema } from "../../domain/agent.js";
import { DomainError } from "../../domain/errors.js";
import { loadRegistry, saveRegistry } from "../../config/registry.js";
import type { CommandDeps } from "../command-deps.js";

export async function runAgentRemove(deps: CommandDeps, alias: string): Promise<Record<string, unknown>> {
  if (!AliasSchema.safeParse(alias).success)
    throw new DomainError(
      "INVALID_ARGUMENT",
      "Agent alias must be lowercase alphanumeric with optional hyphens."
    );
  const current = await loadRegistry(deps.paths);
  const next = { ...current, agents: current.agents.filter((agent) => agent.alias !== alias) };
  if (next.agents.length === current.agents.length) return { removed: false, alias };
  await saveRegistry(deps.paths, next);
  return { removed: true, alias };
}
