/** Schedules release checks and installs verified VSIX updates through VS Code. */
import * as vscode from "vscode";
import type { ExtensionRuntime } from "./runtime.js";
import { checkGithubUpdate, fetchReleases } from "../services/update-checker.js";
import { newestExtensionRelease } from "../services/extension-update.js";
import { installExtensionRelease } from "./extension-update.js";

export {
  RELEASES_API,
  compareVersions,
  newestRelease,
  checkGithubUpdate
} from "../services/update-checker.js";

export const UPDATE_CHECK_DELAY_MS = 5_000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

type UpdateDeps = {
  fetch: typeof fetchReleases;
  install: typeof installExtensionRelease;
};

export function startUpdateCheck(
  context: vscode.ExtensionContext,
  runtime: ExtensionRuntime,
  deps: UpdateDeps = { fetch: fetchReleases, install: installExtensionRelease }
): vscode.Disposable {
  let stopped = false;
  let installed = false;
  let inFlight: AbortController | undefined;
  let rerun = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const checksEnabled = () => runtime.configuration().get<boolean>("checkForUpdates", true);
  const autoUpdate = () => runtime.configuration().get<boolean>("autoUpdate", true);

  const schedule = (delay: number): void => {
    if (timer) clearTimeout(timer);
    if (stopped || installed) return;
    timer = setTimeout(() => void run(), delay);
    timer.unref?.();
  };

  const run = async (): Promise<void> => {
    if (stopped || installed || inFlight || !checksEnabled()) return;
    const abort = new AbortController();
    inFlight = abort;
    const automatic = autoUpdate();
    const active = () => !stopped && !abort.signal.aborted && checksEnabled() && autoUpdate() === automatic;
    try {
      const feed = await deps.fetch(abort.signal);
      if (!active()) return;
      const release = automatic ? newestExtensionRelease(feed, runtime.version) : undefined;
      if (release) {
        if (!(await deps.install(context, release, abort.signal, active))) return;
        // Do not reinstall while this window still runs the old extension awaiting reload.
        installed = true;
        if (stopped) return;
        runtime.log(`update-check: installed ${release.tag}; reload required`);
        const button = runtime.locale === "ja" ? "再読み込み" : "Reload window";
        const message =
          runtime.locale === "ja"
            ? `AgentPickLink ${release.tag} に更新しました。反映するには VS Code を再読み込みしてください。`
            : `AgentPickLink updated to ${release.tag}. Reload VS Code to apply the update.`;
        if ((await vscode.window.showInformationMessage(message, button)) === button && !stopped)
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
      } else {
        // A release without a verifiable VSIX can still be opened for a manual update.
        await checkGithubUpdate({
          installed: runtime.version,
          state: context.globalState,
          fetchReleases: async () => feed,
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
        });
      }
    } catch {
      if (!abort.signal.aborted && !stopped) runtime.log("update-check: unavailable; will retry later");
    } finally {
      abort.abort();
      inFlight = undefined;
      const delay = rerun ? 0 : UPDATE_CHECK_INTERVAL_MS;
      rerun = false;
      schedule(delay);
    }
  };

  const settings = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      !event.affectsConfiguration("agentpicklink.autoUpdate") &&
      !event.affectsConfiguration("agentpicklink.checkForUpdates")
    )
      return;
    if (timer) clearTimeout(timer);
    inFlight?.abort();
    if (inFlight) rerun = checksEnabled();
    else if (checksEnabled()) schedule(0);
  });
  schedule(UPDATE_CHECK_DELAY_MS);
  return {
    dispose: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      settings.dispose();
      inFlight?.abort();
    }
  };
}
