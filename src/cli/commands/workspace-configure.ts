import path from "node:path";
import { loadRegistry } from "../../config/registry.js";
import { loadGlobalConfig } from "../../config/global-config.js";
import { atomicWrite } from "../../config/storage.js";
import { DomainError } from "../../domain/errors.js";
import { SUPPORTED_BROWSER_ADAPTER_IDS } from "../../domain/agent.js";
import { WorkspaceConfigSchema } from "../../domain/workspace.js";
import type { CommandDeps } from "../command-deps.js";

/** §30.3: presents a multi-select list of verified, enabled, supported policy-allowed agents
 * and writes a canonical, deterministically-ordered `.m365-agents.json` with binding
 * fingerprints. The file is only a request -- `workspace approve` is still required. */
export async function runWorkspaceConfigure(deps: CommandDeps): Promise<Record<string, unknown>> {
  const [registry, config] = await Promise.all([loadRegistry(deps.paths), loadGlobalConfig(deps.paths)]);
  const candidates = registry.agents.filter(
    (agent) =>
      agent.enabled &&
      agent.verification.status === "verified" &&
      config.security.allowedCapabilityClasses.includes(
        agent.capabilityClass as "knowledge-only" | "actions-possible"
      ) &&
      SUPPORTED_BROWSER_ADAPTER_IDS.has(agent.verification.adapterId)
  );
  let selected = deps.env.M365_AGENT_ALIASES?.split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
  if (!selected && deps.prompter.interactive) {
    deps.stdout(
      `${candidates.map((agent, index) => `${index + 1}. ${agent.alias} — ${agent.displayName}`).join("\n")}\n`
    );
    const answer = await deps.prompter.question("Select agent numbers or aliases (comma-separated): ");
    selected = answer
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => (/^\d+$/.test(token) ? (candidates[Number(token) - 1]?.alias ?? token) : token));
  }
  if (!selected)
    throw new DomainError(
      "INVALID_ARGUMENT",
      "Workspace configure requires an interactive terminal or M365_AGENT_ALIASES.",
      false,
      { remediation: "Run interactively or set M365_AGENT_ALIASES=alias1,alias2." }
    );
  const byAlias = new Map(candidates.map((agent) => [agent.alias, agent]));
  const unknown = selected.filter((alias) => !byAlias.has(alias));
  if (unknown.length)
    throw new DomainError(
      "AGENT_NOT_FOUND",
      `The selected agents are not verified, supported, enabled, and allowed by local policy: ${unknown.join(", ")}`
    );
  const workspaceConfig = WorkspaceConfigSchema.parse({
    version: 1,
    agents: [...new Set(selected)]
      .sort()
      .map((alias) => ({ alias, bindingFingerprint: byAlias.get(alias)!.verification.bindingFingerprint }))
  });
  await atomicWrite(
    path.join(deps.root(), ".m365-agents.json"),
    `${JSON.stringify(workspaceConfig, null, 2)}\n`
  );
  return {
    configured: true,
    agents: workspaceConfig.agents,
    note: "This repository file is a request, not authorization. Run m365-agent workspace approve."
  };
}
