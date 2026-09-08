import { adapterIdFor } from "../../transports/browser/adapters/index.js";
import {
  AliasSchema,
  deriveBindingFingerprint,
  type AgentKind,
  type BrowserAgentDefinition
} from "../../domain/agent.js";
import { DomainError } from "../../domain/errors.js";
import { loadRegistry, saveRegistry } from "../../config/registry.js";
import { assertSupportedTopology } from "../../services/workspace-service.js";
import { pathPattern, slug } from "../../domain/text.js";
import type { CapturedAgent } from "../../transports/transport.js";
import type { CommandDeps } from "../command-deps.js";

/**
 * §12: capture (`--capture`) or direct-URL (`--url`) registration, with an optional `--force`
 * fallback that always saves a disabled, unverified diagnostic entry -- never invocable or
 * approvable -- even when live inspection actually succeeded and would otherwise verify.
 */
export async function runAgentAdd(
  deps: CommandDeps,
  options: { capture?: boolean; url?: string; force?: boolean }
): Promise<Record<string, unknown>> {
  assertSupportedTopology();
  await deps.initializeLocalState(deps.paths, deps.preparer);
  const client = await deps.connectOrStartDefaultBroker(deps.paths);
  let candidate: CapturedAgent;
  try {
    try {
      candidate = (await client.call(
        options.capture ? "agent.capture" : "agent.inspectUrl",
        options.capture ? { timeoutMs: 300_000 } : { url: options.url }
      )) as CapturedAgent;
    } catch (value) {
      if (!options.force || !options.url) throw value;
      candidate = forcedCandidate(options.url);
    }
  } finally {
    client.close();
  }
  const metadata = await promptAgentMetadata(deps, candidate);
  const provisional: BrowserAgentDefinition = {
    alias: metadata.alias,
    displayName: metadata.displayName,
    kind: metadata.kind,
    transport: "browser",
    entryPoint: { mode: "direct-chat", url: candidate.url, surface: candidate.surface },
    description: metadata.description || undefined,
    usageHint: metadata.usageHint || undefined,
    enabled: !options.force,
    capabilityClass: metadata.capabilityClass,
    uiActionPolicy: "never-click",
    verification: {
      status: options.force ? "unverified" : "verified",
      adapterId: resolveAdapterId(candidate.surface, metadata.kind, candidate.adapterId),
      expectedDisplayName: candidate.displayName,
      expectedStableAgentId: candidate.stableAgentId,
      expectedSurface: candidate.surface,
      validatedUrlPattern: candidate.validatedUrlPattern,
      bindingFingerprint: `sha256:${"0".repeat(64)}`,
      validatedAt: deps.clock().toISOString()
    }
  };
  provisional.verification.bindingFingerprint = deriveBindingFingerprint(provisional);
  const registry = await loadRegistry(deps.paths);
  if (registry.agents.some((item) => item.alias === provisional.alias) && !options.force)
    throw new DomainError(
      "INVALID_ARGUMENT",
      `Alias ${provisional.alias} already exists. Remove it first or use --force to save an unverified replacement.`
    );
  registry.agents = [...registry.agents.filter((item) => item.alias !== provisional.alias), provisional].sort(
    (a, b) => a.alias.localeCompare(b.alias)
  );
  await saveRegistry(deps.paths, registry);
  return {
    added: true,
    alias: provisional.alias,
    displayName: provisional.displayName,
    enabled: provisional.enabled,
    verificationStatus: provisional.verification.status,
    bindingFingerprint: provisional.verification.bindingFingerprint
  };
}

async function promptAgentMetadata(
  deps: CommandDeps,
  candidate: CapturedAgent
): Promise<{
  alias: string;
  displayName: string;
  kind: AgentKind;
  capabilityClass: "knowledge-only" | "actions-possible" | "unknown";
  description: string;
  usageHint: string;
}> {
  const env = deps.env;
  const { prompter } = deps;
  if (!prompter.interactive && !env.M365_AGENT_ALIAS)
    throw new DomainError(
      "INVALID_ARGUMENT",
      "Agent registration needs an interactive terminal or M365_AGENT_ALIAS and M365_AGENT_CAPABILITY_CLASS."
    );
  const aliasValue =
    env.M365_AGENT_ALIAS ??
    ((await prompter.question(`Alias [${slug(candidate.displayName)}]: `)) || slug(candidate.displayName));
  const aliasResult = AliasSchema.safeParse(aliasValue);
  if (!aliasResult.success)
    throw new DomainError(
      "INVALID_ARGUMENT",
      "Agent alias must be lowercase alphanumeric with optional hyphens."
    );
  const alias = aliasResult.data;
  const displayName =
    env.M365_AGENT_DISPLAY_NAME ??
    (prompter.interactive
      ? (await prompter.question(`Local display name [${candidate.displayName}]: `)) || candidate.displayName
      : candidate.displayName);
  const kind = (env.M365_AGENT_KIND ??
    (prompter.interactive
      ? await prompter.question("Kind (m365-agent-builder/sharepoint-agent/copilot-studio): ")
      : "m365-agent-builder")) as AgentKind;
  if (!["m365-agent-builder", "sharepoint-agent", "copilot-studio"].includes(kind))
    throw new DomainError("INVALID_ARGUMENT", "Invalid agent kind.");
  const capabilityClass = (env.M365_AGENT_CAPABILITY_CLASS ??
    (prompter.interactive
      ? await prompter.question("Capability (knowledge-only/actions-possible/unknown): ")
      : "")) as "knowledge-only" | "actions-possible" | "unknown";
  if (!["knowledge-only", "actions-possible", "unknown"].includes(capabilityClass))
    throw new DomainError("INVALID_ARGUMENT", "An explicit capability classification is required.");
  const description =
    env.M365_AGENT_DESCRIPTION ??
    (prompter.interactive ? await prompter.question("Description (optional): ") : "");
  const usageHint =
    env.M365_AGENT_USAGE_HINT ??
    (prompter.interactive ? await prompter.question("Usage hint (optional): ") : "");
  return { alias, displayName, kind, capabilityClass, description, usageHint };
}

function forcedCandidate(urlValue: string): CapturedAgent {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new DomainError("INVALID_ARGUMENT", "The agent URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new DomainError(
      "POLICY_BLOCKED",
      "A forced diagnostic entry must still use a credential-free HTTPS URL."
    );
  return {
    url: url.toString(),
    surface: /teams/i.test(url.hostname) ? "teams-web" : "m365-copilot",
    adapterId: "generic-diagnostic@1",
    displayName: "Unverified agent",
    validatedUrlPattern: pathPattern(url.pathname)
  };
}

/** Delegates to the shared browser-adapter registry (§ adapters/index.ts), preserving the one
 * CLI-side special case: a captured/forced diagnostic candidate (`generic-diagnostic@1`) passes
 * straight through instead of being resolved to a real adapter, but only in the same fallback
 * case the registry itself would otherwise resolve to its surface-wide "any" adapter (i.e. the
 * agent kind is not one the surface has a specific adapter for). */
function resolveAdapterId(surface: CapturedAgent["surface"], kind: AgentKind, detected: string): string {
  if (surface === "teams-web" || kind === "copilot-studio" || kind === "m365-agent-builder")
    return adapterIdFor(surface, kind);
  return detected === "generic-diagnostic@1" ? detected : adapterIdFor(surface, kind);
}
