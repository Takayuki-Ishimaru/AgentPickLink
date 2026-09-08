import { DomainError } from "../../domain/errors.js";
import type { CommandDeps } from "../command-deps.js";
import { withYes } from "../ui/prompts.js";

/** Requires explicit confirmation: resets the dedicated Edge automation profile and shuts down
 * the broker. This only signs the local automation profile out -- it does not claim to revoke
 * any Microsoft 365 session globally. */
export async function runLogout(
  deps: CommandDeps,
  options?: { yes?: boolean }
): Promise<{ loggedOut: boolean }> {
  const prompter = withYes(deps.prompter, !!options?.yes);
  if (
    !(await prompter.confirm(
      "Reset the dedicated AgentPickLink Edge profile? This signs the automation profile out and closes all conversations."
    ))
  ) {
    throw new DomainError("INVALID_ARGUMENT", "Logout was not confirmed.");
  }
  await deps.initializeLocalState(deps.paths, deps.preparer);
  const client = await deps.connectOrStartDefaultBroker(deps.paths);
  try {
    await client.call("browser.resetProfile", {});
    await client.call("broker.shutdown", {});
    return { loggedOut: true };
  } finally {
    client.close();
  }
}
