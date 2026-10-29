import type { ProgressEvent } from "../../domain/progress.js";
import { splitDiscoveryWarnings } from "../../domain/discovery-warnings.js";
import { SetupService, type AgentCandidate } from "../../services/setup-service.js";
import type { CommandDeps } from "../command-deps.js";
import { pickLocaleFromEnv } from "../../services/localize.js";
import { localizedProgressMessage, progressPhaseLabel } from "../../services/progress-localize.js";
import type { Locale } from "../../services/setup-protocol.js";

/** Adapts the CLI's granular `CommandDeps` into the smaller, decoupled `SetupDeps` shape
 * `SetupService` needs -- the same adaptation a VS Code extension host would perform with its
 * own broker-spawn/local-state wiring instead of `connectOrStartDefaultBroker`. `root` defaults to
 * `deps.root` (every existing caller's behavior); `install` (WP-B) passes a different one per
 * workspace, since one CLI invocation can set up more than one. */
export function buildSetupService(deps: CommandDeps, root: () => string = deps.root): SetupService {
  return new SetupService({
    paths: deps.paths,
    connect: () => deps.connectOrStartDefaultBroker(deps.paths),
    connectExisting: () => deps.connectExistingBroker(deps.paths),
    preparer: deps.preparer,
    clock: deps.clock,
    root
  });
}

/** A short, human-readable line for a broker progress event, written to stderr so it never mixes
 * with `--json`/plain stdout output. */
export function formatProgressLine(event: ProgressEvent, locale: Locale = "en"): string {
  return `${progressPhaseLabel(event.phase, locale)}${event.message ? `: ${localizedProgressMessage(event.message, locale)}` : ""}\n`;
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
  const locale = pickLocaleFromEnv(deps.env);
  let previous = "";
  let lastAt = 0;
  const onProgress = (event: ProgressEvent) => {
    const signature = JSON.stringify([
      event.phase,
      event.message?.replace(/ \(still working\)$/, ""),
      event.current,
      event.total
    ]);
    if (signature === previous && Date.now() - lastAt < 30_000) return;
    previous = signature;
    lastAt = Date.now();
    deps.stderr(formatProgressLine(event, locale));
  };
  await service.ensureSignedIn({
    interactive: !!options.login,
    onProgress
  });
  const result = await service.discover(onProgress);
  if (options.json) return result;
  return formatCandidates(result, locale);
}

function formatCandidates(
  result: { candidates: AgentCandidate[]; warnings: string[] },
  locale: Locale
): string {
  const lines =
    result.candidates.length === 0
      ? [locale === "ja" ? "エージェントは見つかりませんでした。" : "No agents were discovered."]
      : result.candidates.map(
          (candidate) =>
            `${candidate.displayName} — ${candidate.url} (${candidate.source}, ${
              candidate.registered
                ? candidate.registered.alias
                : locale === "ja"
                  ? "未登録"
                  : "not registered"
            })`
        );
  const { warnings, diagnostics } = splitDiscoveryWarnings(result.warnings);
  if (warnings.length) lines.push(`${locale === "ja" ? "警告" : "Warnings"}: ${warnings.join(", ")}`);
  if (diagnostics.length)
    lines.push(`${locale === "ja" ? "診断情報" : "Diagnostics"}: ${diagnostics.join(", ")}`);
  return lines.join("\n");
}
