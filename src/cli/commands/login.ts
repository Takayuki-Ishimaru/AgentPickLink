import type { CommandDeps } from "../command-deps.js";
import { buildSetupService, formatProgressLine } from "./agent-discover.js";

/** Reuses `SetupService.ensureSignedIn({ interactive: true })` (see docs/ux-redesign.md §2.5):
 * it checks `browser.authState` first and only opens the interactive sign-in window when the
 * account is not already signed in, printing progress (login-waiting/login-closing) to stderr. */
export async function runLogin(deps: CommandDeps): Promise<{ state: string }> {
  const service = buildSetupService(deps);
  return service.ensureSignedIn({
    interactive: true,
    onProgress: (event) => deps.stderr(formatProgressLine(event))
  });
}
