/**
 * The VS Code side of the GitHub release check: scheduling the startup delay, the localized
 * notification and opening the release in the browser. The pure half -- fetching the releases
 * feed, comparing SemVer tags and building the release URL -- moved to
 * `src/services/update-checker.ts` (no `vscode` import) so the CLI can reuse it; re-exported below
 * so this module and its tests keep working unchanged.
 */
import * as vscode from "vscode";
import type { ExtensionRuntime } from "./runtime.js";
import { checkGithubUpdate, fetchReleases } from "../services/update-checker.js";

export {
  RELEASES_API,
  compareVersions,
  newestRelease,
  checkGithubUpdate
} from "../services/update-checker.js";

export const UPDATE_CHECK_DELAY_MS = 5_000;

export function startUpdateCheck(
  context: vscode.ExtensionContext,
  runtime: ExtensionRuntime
): vscode.Disposable {
  const abort = new AbortController();
  const active = () => !abort.signal.aborted && runtime.configuration().get<boolean>("checkForUpdates", true);
  const timer = setTimeout(() => {
    void checkGithubUpdate({
      installed: runtime.version,
      state: context.globalState,
      fetchReleases: () => fetchReleases(abort.signal),
      active,
      notify: async (tag) => {
        const button = runtime.locale === "ja" ? "リリースを開く" : "Open release";
        const message =
          runtime.locale === "ja"
            ? `AgentPickLink ${tag} が公開されています（現在: ${runtime.version}）。`
            : `AgentPickLink ${tag} is available (installed: ${runtime.version}).`;
        return (await vscode.window.showInformationMessage(message, button)) === button;
      },
      open: (url) => vscode.env.openExternal(vscode.Uri.parse(url))
    }).catch(() => {
      if (!abort.signal.aborted) runtime.log("update-check: unavailable; will retry next activation");
    });
  }, UPDATE_CHECK_DELAY_MS);
  timer.unref?.();
  return {
    dispose: () => {
      clearTimeout(timer);
      abort.abort();
    }
  };
}
