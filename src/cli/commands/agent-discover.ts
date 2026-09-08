import type { ProgressEvent } from "../../domain/progress.js";
import { splitDiscoveryWarnings } from "../../domain/discovery-warnings.js";
import { SetupService, type AgentCandidate } from "../../services/setup-service.js";
import type { CommandDeps } from "../command-deps.js";

/** Adapts the CLI's granular `CommandDeps` into the smaller, decoupled `SetupDeps` shape
 * `SetupService` needs -- the same adaptation a VS Code extension host would perform with its
 * own broker-spawn/local-state wiring instead of `connectOrStartDefaultBroker`. */
export function buildSetupService(deps: CommandDeps): SetupService {
  return new SetupService({
    paths: deps.paths,
    connect: () => deps.connectOrStartDefaultBroker(deps.paths),
    connectExisting: () => deps.connectExistingBroker(deps.paths),
    preparer: deps.preparer,
    clock: deps.clock,
    root: deps.root
  });
}

/** A short, human-readable line for a broker progress event, written to stderr so it never mixes
 * with `--json`/plain stdout output. */
export function formatProgressLine(event: ProgressEvent): string {
  return `${event.phase}${event.message ? `: ${event.message}` : ""}\n`;
}

/**
 * §2.5/§30. `m365-agent agent discover [--login] [--json]`: starts the broker if needed and
 * requires an already-signed-in account, unless `--login` is given -- discovery itself never
 * opens the interactive sign-in window on its own.
 */
export async function runAgentDiscover(
  deps: CommandDeps,
  options: { login?: boolean; json?: boolean } = {}
): Promise<{ candidates: AgentCandidate[]; warnings: string[] } | string> {
  const service = buildSetupService(deps);
  await service.ensureSignedIn({
    interactive: !!options.login,
    onProgress: (event) => deps.stderr(formatProgressLine(event))
  });
  const result = await service.discover((event) => deps.stderr(formatProgressLine(event)));
  if (options.json) return result;
  return formatCandidates(result);
}

function formatCandidates(result: { candidates: AgentCandidate[]; warnings: string[] }): string {
  const lines =
    result.candidates.length === 0
      ? ["No agents were discovered."]
      : result.candidates.map(
          (candidate) =>
            `${candidate.displayName} — ${candidate.url} (${candidate.source}, ${
              candidate.registered ? candidate.registered.alias : "not registered"
            })`
        );
  const { warnings, diagnostics } = splitDiscoveryWarnings(result.warnings);
  if (warnings.length) lines.push(`Warnings: ${warnings.join(", ")}`);
  if (diagnostics.length) lines.push(`Diagnostics: ${diagnostics.join(", ")}`);
  return lines.join("\n");
}
