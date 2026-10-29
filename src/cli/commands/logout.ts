import { DomainError } from "../../domain/errors.js";
import type { CommandDeps } from "../command-deps.js";
import { withYes } from "../ui/prompts.js";
import { pickLocaleFromEnv } from "../../services/localize.js";

/** Requires explicit confirmation: resets the dedicated Edge automation profile and shuts down
 * the broker. This only signs the local automation profile out -- it does not claim to revoke
 * any Microsoft 365 session globally. */
export async function runLogout(
  deps: CommandDeps,
  options?: { yes?: boolean }
): Promise<{ loggedOut: boolean }> {
  const prompter = withYes(deps.prompter, !!options?.yes);
  const ja = pickLocaleFromEnv(deps.env) === "ja";
  if (
    !(await prompter.confirm(
      ja
        ? "AgentPickLink 専用の Edge プロファイルを初期化しますか？サインアウトし、すべての会話を閉じます。"
        : "Reset the dedicated AgentPickLink Edge profile? This signs the automation profile out and closes all conversations."
    ))
  ) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      ja ? "サインアウトが確認されませんでした。" : "Logout was not confirmed.",
      false,
      {
        remediation: ja
          ? "端末なしでサインアウトを承認する場合は apl logout --yes を指定してください。"
          : "To confirm logout without an interactive terminal, run apl logout --yes."
      }
    );
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
