import { DomainError } from "../../domain/errors.js";
import { assertSupportedTopology } from "../../services/workspace-service.js";
import type { CommandDeps } from "../command-deps.js";
import { withYes } from "../ui/prompts.js";

/** §12.4: default behavior never sends a message. `--send-test-message` must display the exact
 * test message and requires explicit confirmation before it is submitted. */
export const TEST_MESSAGE = "あなたの役割を一文で説明してください";

export async function runAgentTest(
  deps: CommandDeps,
  alias: string,
  options: { sendTestMessage?: boolean; yes?: boolean }
): Promise<Record<string, unknown>> {
  assertSupportedTopology();
  if (options.sendTestMessage) {
    const prompter = withYes(deps.prompter, !!options.yes);
    if (!(await prompter.confirm(`Send this exact test message to ${alias}?\n${TEST_MESSAGE}`)))
      throw new DomainError("INVALID_ARGUMENT", "Sending the test message was not confirmed.");
  }
  const client = await deps.connectOrStartDefaultBroker(deps.paths);
  try {
    return (await client.call("agent.validate", {
      agent: alias,
      sendTestMessage: !!options.sendTestMessage
    })) as Record<string, unknown>;
  } finally {
    client.close();
  }
}
