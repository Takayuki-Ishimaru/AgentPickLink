/**
 * A deliberately tiny message dictionary for the host-side UI (commands' notifications, the modal
 * approval prompt, the status bar). Japanese when VS Code runs in Japanese, English otherwise.
 * The webview carries its own copy of the strings it renders (media/setup.js). Host-agnostic (no
 * `vscode` import) so the CLI can share it; the VS Code extension re-exports this module from
 * `src/extension/localize.ts`.
 */
import { ERROR_CODES, type ErrorCode } from "../domain/errors.js";
import type { Locale, PanelPhase } from "./setup-protocol.js";

export function pickLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/** The CLI has no `vscode.env.language`, so it picks the same way any other POSIX/Windows tool
 * does: `LC_ALL`, falling back to `LANG` (`ja*` -> ja, everything else -> en). Locale environment
 * variables look like `ja_JP.UTF-8`; `pickLocale` only looks at the leading language tag. */
export function pickLocaleFromEnv(env: NodeJS.ProcessEnv): Locale {
  return pickLocale(env.LC_ALL ?? env.LANG);
}

const MESSAGES = {
  approveTitle: {
    ja: "このワークスペースで次のエージェントを承認します",
    en: "Approve these agents for this workspace"
  },
  approveBody: {
    ja: "Microsoft 365 の応答は AI クライアントのコンテキストに入ります。このワークスペースでこれらのエージェントだけを承認しますか？",
    en: "Microsoft 365 responses will enter the AI client context. Approve exactly these agents for this workspace?"
  },
  approveConfirm: { ja: "承認して保存", en: "Approve and save" },
  saved: { ja: "選択したエージェントを保存しました。", en: "Selected agents saved." },
  savedWithIntegrations: {
    ja: "エージェントと連携設定を保存しました。連携先に表示されない場合は、その AI クライアントを再起動してください。",
    en: "Agents and client settings saved. If an agent does not appear in a connected AI client, restart that client."
  },
  cancel: { ja: "キャンセル", en: "Cancel" },
  actionsPossible: { ja: "ファイル生成・アクションあり", en: "file output / actions possible" },
  knowledgeOnly: { ja: "知識のみ", en: "knowledge only" },
  actionsPossibleWidensCapability: {
    ja: "注意: 「ファイル生成・アクションあり」を承認すると、この PC 上の他のワークスペースでもその能力クラスのエージェントを承認できるようになります（各ワークスペースでの承認は別途必要です）。",
    en: "Note: approving an actions-possible agent also allows other workspaces on this machine to approve agents of that capability class (each workspace still needs its own approval)."
  },
  reloadQuestion: {
    ja: "エージェントを保存し、MCP サーバー定義を更新しました。Codex / Claude Code など他のクライアントは再起動が必要な場合があります。ウィンドウを再読み込みしますか？",
    en: "Agents saved and the MCP server definition updated. Other clients (Codex / Claude Code) may need their own restart. Reload the window now?"
  },
  reload: { ja: "再読み込み", en: "Reload" },
  later: { ja: "後で", en: "Later" },
  diagnosticsCopied: {
    ja: "診断情報をクリップボードにコピーしました。",
    en: "Diagnostics copied to the clipboard."
  },
  revealLogs: { ja: "ログフォルダーを開く", en: "Reveal log folder" },
  close: { ja: "閉じる", en: "Close" },
  noWorkspace: {
    ja: "単一ルートのワークスペースを開いてから実行してください。",
    en: "Open a single-root workspace folder first."
  },
  savedNeedsSignIn: {
    ja: "設定を保存しました。利用するには再サインインしてください。",
    en: "Settings saved. Sign in again to use these agents."
  },
  signedOut: { ja: "サインアウトしました。", en: "Signed out." },
  brokerRestarted: { ja: "ブローカーを再起動しました。", en: "The broker was restarted." },
  noAgentsSelected: {
    ja: "保存するエージェントを 1 つ以上選択してください。",
    en: "Select at least one agent to save."
  },
  browserChannelSwitched: {
    ja: "{from} が見つからないため、ブラウザーを {to} に切り替えました。",
    en: "{from} is not installed; the browser channel was switched to {to}."
  },
  workspaceUntrusted: {
    ja: "このワークスペースは制限モードです。エージェントを保存するには、ワークスペースを信頼してください。",
    en: "This workspace is in Restricted Mode. Trust the workspace before saving agents."
  },
  restartingBroker: { ja: "接続を復旧しています", en: "Restoring the connection" },
  // docs/validation-log-2026-09-14-windows-round2.md R4: shown via `notify()` (never `log()`) when
  // `install` restarts a broker that was already running before this run connected to it, after
  // its first browser-needing step failed with BROWSER_START_FAILED, and retries that step once.
  installRestartingBrokerRetry: {
    ja: "古いブローカーを再起動して再試行します",
    en: "Restarting the previous broker and retrying"
  },
  integrationsRefreshed: {
    ja: "AgentPickLink: MCP 設定を新しいバージョンに合わせて更新しました",
    en: "MCP client settings were updated for the new version"
  },
  statusReady: { ja: "接続済み", en: "ready" },
  statusSignIn: { ja: "サインインが必要", en: "sign-in required" },
  statusStopped: { ja: "未接続", en: "not connected" },
  statusUiChanged: { ja: "接続を確認してください", en: "connection needs attention" },
  statusError: { ja: "エラー", en: "error" },
  uiChangedTooltip: {
    ja: "Microsoft 365 の画面構成が想定と異なります。開発者に確認してください。",
    en: "The Microsoft 365 page structure differs from what this version expects. Check with the developer."
  },
  signInTooltip: {
    ja: "Microsoft 365 のサインインが必要です。クリックしてパネルを開き、「接続して更新」を押してください。",
    en: "Microsoft 365 sign-in is required. Click to open the panel and sign in."
  },
  // G2: the proactive notification shown at most once per sign-in-required transition (see
  // shouldNotifySignIn in src/extension/status.ts), plus its "Sign in" action button.
  signInRequiredNotification: {
    ja: "Microsoft 365 のサインインが必要です",
    en: "Microsoft 365 sign-in is required"
  },
  signIn: { ja: "サインイン", en: "Sign in" },
  browserSignInTitle: {
    ja: "ブラウザーで Microsoft 365 にサインインしてください",
    en: "Sign in to Microsoft 365 in the browser"
  },
  browserSignInInstructions: {
    ja: "これからサインイン用のブラウザーを開きます。エージェントを利用する職場または学校アカウントでサインインし、追加認証を求められた場合もブラウザーで操作してください。\n\nサインインが完了すると、このウィンドウは自動で閉じます。その後、VS Code の AgentPickLink パネルに戻ってください。",
    en: "A browser window will open for sign-in. Sign in with the work or school account that has your agents and complete any additional authentication in that browser.\n\nIf a personal account appears, use its account menu to switch to your work or school account. The window closes automatically when sign-in is complete. Then return to the AgentPickLink panel in VS Code."
  },
  openSignInBrowser: { ja: "ブラウザーを開く", en: "Open browser" },
  // G3: unregistering a registered agent (distinct from the panel's "hide from list", which never
  // touches the registry) and revoking this workspace's local approval.
  unregisterConfirmTitle: {
    ja: "このエージェントの登録を削除しますか？",
    en: "Unregister this agent?"
  },
  unregisterConfirmBody: {
    ja: "登録を削除すると、このワークスペースの割り当ても解除され、他のワークスペースからも使えなくなります。候補一覧から一時的に隠すだけなら「候補から隠す」を使ってください。",
    en: 'Unregistering removes it from every workspace\'s assignment, not just this one. To only hide it from this list, use "Hide from list" instead.'
  },
  unregisterConfirm: { ja: "登録を削除", en: "Unregister" },
  agentUnregistered: { ja: "エージェントの登録を削除しました。", en: "The agent was unregistered." },
  revokeConfirmTitle: {
    ja: "このワークスペースの承認を取り消しますか？",
    en: "Revoke this workspace's approval?"
  },
  revokeConfirmBody: {
    ja: "登録済みのエージェントはそのまま残りますが、次に使うときはこのワークスペースで再度承認が必要になります。.m365-agents.json は変更されません。",
    en: "Registered agents are left as they are, but this workspace will need approving again before they can be used. .m365-agents.json is not changed."
  },
  revokeConfirm: { ja: "承認を取り消す", en: "Revoke approval" },
  workspaceRevoked: {
    ja: "このワークスペースの承認を取り消しました。",
    en: "This workspace's approval was revoked."
  },
  // G5: the "Advanced" section's restart prompt after updateConfig() reports restartRequired.
  advancedRestartQuestion: {
    ja: "設定を保存しました。反映にはブローカーの再起動が必要です。今すぐ再起動しますか？",
    en: "Settings saved. The broker must restart for this to take effect. Restart it now?"
  },
  restartNow: { ja: "今すぐ再起動", en: "Restart now" },

  /* -------------------------------------------------------------- WP-B: install / self / integrations CLI */
  cliDiscoverySummary: {
    ja: "発見結果: {total} 件（説明あり {descriptions} 件）",
    en: "Discovery: {total} agent(s) ({descriptions} with a description)"
  },
  cliDiscoveryPartial: {
    ja: "一部の情報を取得できませんでした（詳細は診断を参照）。",
    en: "Some information could not be retrieved (see diagnostics)."
  },
  // WP-D: the count-bearing partial notice (SetupService.discover()'s `partial`/`failedCount`, see
  // domain/discovery-warnings.ts's summarizeDiscoveryCompleteness), shown in place of
  // `cliDiscoveryPartial` wherever a `failedCount` is available. Metadata only -- a count, never
  // agent names.
  cliDiscoveryPartialCount: {
    ja: "一部の候補を取得できませんでした（{count} 件）。再実行すると増えることがあります。",
    en: "Some candidates could not be retrieved ({count}). Re-running discovery may find more."
  },
  // WP-D / ISSUE-2026-09-14-01: shown instead of `cliDiscoveryPartialCount` when `failedCount` is
  // only a floor for an unknown number of losses (`failedCountKnown: false`) -- a count would
  // either overstate what is known or, when the floor is fully offset elsewhere, misleadingly read
  // as "0 lost". Never shows a number.
  cliDiscoveryPartialUnknown: {
    ja: "一部の候補を取得できなかった可能性があります。再実行すると増えることがあります。",
    en: "Some candidates may not have been retrieved. Re-running discovery may find more."
  },
  cliIncidentLine: { ja: "通知: {message} ({code})", en: "Incident: {message} ({code})" },
  cliNoTty: {
    ja: "対話端末がないため確認できません。計画には --yes、一覧承認には --approve-agents、能力拡大には --allow-actions-possible が必要です。",
    en: "No interactive terminal is available to confirm this. Non-interactive plans need --yes; roster approval needs --approve-agents and widening needs --allow-actions-possible."
  },
  cliYesAnswer: { ja: "--yes により自動的に「はい」", en: "answered yes automatically (--yes)" },
  cliClipboardFollows: { ja: "コピーする内容:", en: "Copied text follows:" },
  cliLogsAt: { ja: "ログの場所: {path}", en: "Logs are at: {path}" },
  cliSignInInstructions: { ja: "サインインの案内: {text}", en: "Sign-in notice: {text}" },

  installDoctorFailed: {
    ja: "診断で問題が見つかりました。apl doctor を確認してください。",
    en: "Diagnostics found problems. Review apl doctor."
  },
  cliVersionLabel: { ja: "バージョン", en: "version" },
  cliHomeLabel: { ja: "インストール先", en: "home" },
  cliRuntimeLabel: { ja: "ランタイム", en: "runtime" },
  cliWorkspaceLabel: { ja: "ワークスペース", en: "workspace" },
  cliFailed: { ja: "失敗", en: "failed" },
  installDoctorResult: { ja: "診断結果", en: "Diagnostics" },
  selfPruneConfirm: {
    ja: "旧バージョン {versions} を削除しますか？",
    en: "Remove older versions {versions}?"
  },
  installPlanHeader: { ja: "=== インストール計画 ===", en: "=== Install plan ===" },
  installPlanVersion: { ja: "バージョン: {version}", en: "Version: {version}" },
  installPlanHome: { ja: "インストール先: {home}", en: "Install location: {home}" },
  installPlanRuntimeBundled: {
    ja: "ランタイム: 同梱の Node.js を使用",
    en: "Runtime: the bundled Node.js"
  },
  installPlanRuntimeSystem: {
    ja: "ランタイム: 同梱の Node.js が見つからないため、現在の Node.js を使用（開発環境向け）",
    en: "Runtime: the bundled Node.js was not found; using the current Node.js (developer setups only)"
  },
  installPlanClientsHeader: { ja: "書き込むクライアント設定:", en: "Client files to write:" },
  installPlanClientsNone: {
    ja: "書き込むクライアント設定はありません（--clients none）。",
    en: "No client configuration will be written (--clients none)."
  },
  installPlanClientPolicyBlocked: {
    ja: "{client}: {policy} によりブロックされているため、書き込みません。",
    en: "{client}: blocked by {policy}; it will not be written."
  },
  installPlanClientNotDetected: { ja: "{client}: 検出されませんでした。", en: "{client}: not detected." },
  installPlanClientVscodeUser: {
    ja: "vscode-user（既定: ユーザープロファイルの mcp.json。フォルダーの信頼を尋ねられません）",
    en: "vscode-user (default: the user-profile mcp.json; no folder-trust prompt)"
  },
  installPlanClientVscodeWorkspace: {
    ja: "vscode-workspace（.vscode/mcp.json。任意設定。初回はフォルダーの信頼を尋ねられます）",
    en: "vscode-workspace (.vscode/mcp.json; opt-in. VS Code may ask to trust the folder the first time)"
  },
  installPlanClientClaudeUser: {
    ja: "claude-user（既定: `claude mcp add-json --scope user` で登録。プロジェクトごとの承認は不要）",
    en: "claude-user (default: registered via `claude mcp add-json --scope user`; no per-project approval)"
  },
  installPlanClientClaudeProject: {
    ja: "claude-project（.mcp.json。任意設定。初回利用時に承認が必要です）",
    en: "claude-project (.mcp.json; opt-in. Needs approval on first use)"
  },
  installMigrationRemovedVscodeWorkspace: {
    ja: "{file} の m365-agents 設定を削除します（VS Code がフォルダーの信頼を尋ねないように）。",
    en: "removing the entry in {file} so VS Code does not ask to trust the folder."
  },
  installMigrationRemovedClaudeProject: {
    ja: "{file} の m365-agents 設定を削除します（Claude Code がプロジェクトの承認を尋ねないように）。",
    en: "removing the entry in {file} so Claude Code does not ask to approve the project server."
  },
  installVscodeUserSkippedNoUserDir: {
    ja: "vscode-user: この端末に VS Code のユーザーディレクトリが見つからなかったため、書き込みをスキップしました。`apl integrations snippet --client vscode-user` でスニペットを確認してください。",
    en: "vscode-user: the VS Code user directory was not found on this machine; skipped. Run `apl integrations snippet --client vscode-user` for a snippet."
  },
  installVscodeUserDirCreated: {
    ja: "VS Code のユーザー設定フォルダーを作成しました",
    en: "Created VS Code's user settings folder"
  },
  installPlanWorkspacesHeader: { ja: "対象ワークスペース:", en: "Workspaces:" },
  installConfirmPrompt: {
    ja: "この内容でインストールしますか？",
    en: "Proceed with this installation?"
  },
  installDryRunNotice: {
    ja: "--dry-run が指定されたため、何も変更していません。",
    en: "--dry-run was given; nothing was changed."
  },
  installNotConfirmed: {
    ja: "確認されなかったため、インストールを中止しました。",
    en: "Installation was not confirmed; nothing was changed."
  },
  installStaging: { ja: "パッケージを配置しています...", en: "Staging the package..." },
  installStagingSkipped: {
    ja: "既に配置済みのバージョンから実行されているため、配置手順を省略します。",
    en: "Already running from the staged version; skipping the copy."
  },
  installDevNotice: {
    ja: "--dev: このチェックアウトを直接、機械側インストールとして登録します（app/ への複製はしません）。",
    en: "--dev: registering this checkout directly as the machine install (no copy into app/)."
  },
  installAgentsStep: {
    ja: "ワークスペース {workspace} のエージェントを設定しています...",
    en: "Setting up agents for workspace {workspace}..."
  },
  installNoAgentsInteractive: {
    ja: "エージェント番号をカンマ区切りで選択してください（Enter で現在の選択を維持）: ",
    en: "Select agent numbers, comma-separated (Enter keeps the current selection): "
  },
  installNoAgentsNonInteractive: {
    ja: "--agents を指定するか、対話端末で実行してください。",
    en: "Specify --agents or run interactively."
  },
  installUnknownAgents: { ja: "不明なエージェント: {aliases}", en: "Unknown agent(s): {aliases}" },
  installApproveAgentsRequired: {
    ja: "非対話実行でエージェントの一覧を承認するには --approve-agents を指定してください。",
    en: "Non-interactive runs must pass --approve-agents to approve the agent roster."
  },
  installActionsPossibleDropped: {
    ja: "ファイル生成・アクションありのエージェントは --allow-actions-possible なしでは登録されません（対象: {names}）。",
    en: "actions-possible agent(s) were not registered without --allow-actions-possible: {names}"
  },
  installSaveFailed: {
    ja: "エージェントの保存に失敗しました。",
    en: "Saving the agent roster failed."
  },
  installVerifying: { ja: "MCP 接続を確認しています...", en: "Verifying the MCP connection..." },
  installVerifyFailed: {
    ja: "MCP 接続を確認できませんでした。",
    en: "The MCP connection could not be verified."
  },
  installReportHeader: { ja: "=== インストール結果 ===", en: "=== Install report ===" },
  installReportNoClients: {
    ja: "クライアント設定は書き込まれませんでした。",
    en: "No client configuration was written."
  },
  installClientSnippetLabel: {
    ja: "書き込まれませんでした。次のスニペットを使用してください:",
    en: "not written; use this snippet:"
  },
  installUninstallHint: {
    ja: "アンインストールするには次を実行してください:",
    en: "To uninstall, run:"
  },
  installNextStepsHeader: { ja: "次の手順:", en: "Next steps:" },
  installNextStepsVscode: {
    ja: "VS Code でワークスペースを開き、Chat に話しかけると自動で起動します（初めて開くフォルダーでは VS Code がフォルダーの信頼を尋ねることがあります）。",
    en: "Open the workspace in VS Code and start chatting; the server starts automatically. (VS Code may ask to trust the folder the first time you open it.)"
  },
  installNextStepsClaude: {
    ja: "Claude Code を再起動してください。ユーザースコープに登録済みです。",
    en: "Restart Claude Code; the server is registered in your user scope."
  },
  installNextStepsCodex: { ja: "Codex を再起動してください。", en: "Restart Codex." },
  installNextStepsIncident: {
    ja: "Microsoft 365 の画面構成が変わった場合は m365-agent doctor を実行し、その出力を報告してください。",
    en: "If Microsoft 365 changes its layout, run m365-agent doctor and send its output."
  },
  installElevatedRefused: {
    ja: "管理者/root 権限では実行できません。通常の権限で実行し直してください。",
    en: "This cannot run with administrator/root privileges. Re-run with normal user privileges."
  },

  selfStatusHeader: { ja: "=== インストール状態 ===", en: "=== self status ===" },
  selfUseDone: { ja: "{version} に切り替えました。", en: "Switched to {version}." },
  selfPruneDone: { ja: "削除したバージョン: {versions}", en: "Removed version(s): {versions}" },
  selfUninstallConfirm: {
    ja: "AgentPickLink をこのマシンから削除します（登録簿・承認・ブラウザープロファイルは保持します）。よろしいですか？",
    en: "This removes AgentPickLink from this machine (the registry, approvals, and browser profile are kept). Proceed?"
  },
  selfUninstallPurgeConfirm: {
    ja: "--purge-data が指定されました。登録簿・承認・ブラウザープロファイルも削除します。元に戻せません。よろしいですか？",
    en: "--purge-data was given: the registry, approvals, and browser profile will also be deleted. This cannot be undone. Proceed?"
  },
  selfUninstallDone: { ja: "AgentPickLink を削除しました。", en: "AgentPickLink was removed." },

  integrationsForeignRefused: {
    ja: "{file}: AgentPickLink が書き込んだものではない設定があるため、変更していません（--force で強制できます）。",
    en: "{file}: has an entry AgentPickLink did not write; left untouched (use --force to override)."
  },
  integrationsRemoveDone: { ja: "削除しました: {file}", en: "Removed: {file}" },
  integrationsWriteDone: { ja: "書き込みました: {file}", en: "Wrote: {file}" }
} as const satisfies Record<string, Record<Locale, string>>;

export type MessageKey = keyof typeof MESSAGES;

export function translate(locale: Locale, key: MessageKey): string {
  return MESSAGES[key][locale];
}

/** A bound translator, so call sites read as `t("reload")`. */
export function translator(locale: Locale): (key: MessageKey) => string {
  return (key) => translate(locale, key);
}

/**
 * WP-D: the localized "some candidates could not be retrieved" notice for a partial discovery
 * summary (see `SetupService.discover()`'s `partial`/`failedCount`/`failedCountKnown`, derived
 * from domain/discovery-warnings.ts's `summarizeDiscoveryCompleteness`). Returns `undefined` when
 * the summary was not partial, so a caller renders nothing rather than an empty line. Counts only
 * -- never agent names, matching every other discovery diagnostic in this file.
 *
 * `failedCountKnown === false` (ISSUE-2026-09-14-01) means `failedCount` is only a floor for an
 * unknown number of losses, not a real tally: showing it as a count would misstate what is known,
 * so this renders `cliDiscoveryPartialUnknown` instead -- never a literal "(0)". A caller that
 * omits `failedCountKnown` (older callers that predate it) keeps the original count-bearing
 * wording, `failedCount` defaulting to `0` exactly as before.
 */
export function describeDiscoverySummary(
  summary: { partial: boolean; failedCount?: number; failedCountKnown?: boolean },
  locale: Locale
): string | undefined {
  if (!summary.partial) return undefined;
  if (summary.failedCountKnown === false) return translate(locale, "cliDiscoveryPartialUnknown");
  return translate(locale, "cliDiscoveryPartialCount").replace("{count}", String(summary.failedCount ?? 0));
}

/* ---------------------------------------------------------------- error codes */

/**
 * One localized line per `ErrorCode`, plus (for the handful of codes users actually hit) a
 * localized replacement for the English remediation in src/domain/errors.ts.
 *
 * The `satisfies Record<ErrorCode, ...>` is the point of this shape: adding a code to
 * `ERROR_CODES` without a line here fails `npm run typecheck`, so the panel can never end up
 * showing a bare code with no explanation. The English `message`/`remediation` the domain layer
 * produced are never replaced -- the panel shows both (see `PanelError` in ./protocol.ts).
 */
type ErrorCodeEntry = { ja: string; en: string; remediation?: Record<Locale, string> };

const ERROR_CODE_TEXT = {
  WORKSPACE_NOT_CONFIGURED: {
    ja: "このワークスペースはまだ設定されていません。",
    en: "This workspace has not been configured yet."
  },
  WORKSPACE_CONFIG_INVALID: {
    ja: ".m365-agents.json の内容が正しくありません。",
    en: "The .m365-agents.json file in this workspace is not valid."
  },
  WORKSPACE_APPROVAL_REQUIRED: {
    ja: "このワークスペースのエージェントは、この PC でまだ承認されていません。",
    en: "The agents this workspace requests have not been approved on this machine.",
    remediation: {
      ja: "AgentPickLink パネルを開き、「承認して保存」でこのワークスペースのエージェントを承認してください。",
      en: "Open the AgentPickLink panel and press Save to approve these agents for this workspace."
    }
  },
  WORKSPACE_APPROVAL_REVOKED: {
    ja: "このワークスペースの承認は取り消されています。",
    en: "This workspace's approval has been revoked."
  },
  WORKSPACE_CONFIG_CHANGED: {
    ja: ".m365-agents.json が承認後に変更されました。",
    en: ".m365-agents.json changed after it was approved."
  },
  WORKSPACE_ROOT_AMBIGUOUS: {
    ja: "ワークスペースのルートを一意に決められませんでした。",
    en: "The workspace root could not be determined unambiguously."
  },
  WORKSPACE_ROOT_UNAVAILABLE: {
    ja: "ワークスペースフォルダーが開かれていません。",
    en: "No workspace folder is open."
  },
  MULTI_ROOT_UNSUPPORTED: {
    ja: "マルチルートワークスペースには対応していません。",
    en: "Multi-root workspaces are not supported."
  },
  PLATFORM_UNSUPPORTED: {
    ja: "このOSは通常利用の対象外です。Linux配布物は開発・CI用です。",
    en: "This OS is not supported for normal use. Linux artifacts are for development/CI."
  },
  REMOTE_HOST_UNSUPPORTED: {
    ja: "リモート環境では利用できません。",
    en: "This does not run against a remote host."
  },
  AGENT_NOT_ASSIGNED: {
    ja: "このエージェントはこのワークスペースに割り当てられていません。",
    en: "The agent is not assigned to this workspace."
  },
  AGENT_NOT_FOUND: {
    ja: "指定されたエージェントが登録簿にありません。",
    en: "The agent is not in the local registry."
  },
  AGENT_DISABLED: {
    ja: "このエージェントは無効になっています。",
    en: "The agent is disabled in the local registry."
  },
  AGENT_UNVERIFIED: {
    ja: "このエージェントはまだ検証されていません。",
    en: "The agent has not been verified yet."
  },
  AGENT_BINDING_MISMATCH: {
    ja: "別名が別のエージェントを指しています。",
    en: "The workspace alias resolves to a different local agent binding."
  },
  AGENT_CAPABILITY_BLOCKED: {
    ja: "この能力クラスのエージェントは許可されていません。",
    en: "Agents of this capability class are not allowed by local policy."
  },
  AGENT_ENTRYPOINT_UNSUPPORTED: {
    ja: "このエージェントの入口 URL には対応していません。",
    en: "This agent's entry point is not supported."
  },
  AGENT_IDENTITY_UNVERIFIED: {
    ja: "ページ上でエージェントの同一性を確認できませんでした。",
    en: "The agent's identity could not be confirmed on the page."
  },
  AGENT_IDENTITY_MISMATCH: {
    ja: "開かれたページのエージェントが登録内容と一致しません。",
    en: "The page opened a different agent than the one registered."
  },
  AGENT_CONTEXT_CHANGED: {
    ja: "会話の途中でエージェントの文脈が変わりました。",
    en: "The agent context changed during the conversation."
  },
  AGENT_PAGE_UNAVAILABLE: {
    ja: "エージェントのページを開けませんでした。",
    en: "The agent page could not be opened."
  },
  BROKER_UNAVAILABLE: {
    ja: "ローカルブローカーに接続できません。",
    en: "The local broker is not reachable."
  },
  BROKER_START_FAILED: {
    ja: "ローカルブローカーを起動できませんでした。",
    en: "The local broker could not be started."
  },
  BROKER_AUTH_FAILED: {
    ja: "ローカルブローカーとの接続を認証できませんでした。",
    en: "The connection to the local broker could not be authenticated."
  },
  BROKER_VERSION_MISMATCH: {
    ja: "起動中のブローカーはこの拡張機能と別のバージョンです。",
    en: "The running broker is a different version than this extension."
  },
  BROKER_PROTOCOL_ERROR: {
    ja: "ブローカーとの通信でプロトコルエラーが発生しました。",
    en: "The broker reported a protocol-level error."
  },
  BROWSER_START_FAILED: {
    ja: "自動操作用のブラウザーを起動できませんでした。",
    en: "The automation browser could not be started."
  },
  BROWSER_PROFILE_INVALID: {
    ja: "専用ブラウザープロファイルの場所が正しくありません。",
    en: "The dedicated browser profile is not in a valid location."
  },
  BROWSER_PROFILE_LOCKED: {
    ja: "専用ブラウザープロファイルを別のプロセスが使用しています。",
    en: "Another process is using the dedicated browser profile.",
    remediation: {
      ja: "AgentPickLink のサインインウィンドウなど、専用プロファイルを使っているブラウザーを閉じてから、ブローカーを再起動してください。",
      en: "Close the browser using the dedicated profile (the AgentPickLink sign-in window, for example), then restart the broker."
    }
  },
  BROWSER_CRASHED: {
    ja: "自動操作用のブラウザーが異常終了しました。",
    en: "The automation browser crashed."
  },
  AUTH_REQUIRED: {
    ja: "Microsoft 365 のサインインが必要です。",
    en: "Microsoft 365 sign-in is required.",
    remediation: {
      ja: "AgentPickLink パネルの「サインイン」からサインインしてください。",
      en: "Sign in from the AgentPickLink panel in VS Code."
    }
  },
  AUTH_FAILED: {
    ja: "サインインが完了しませんでした。",
    en: "Sign-in did not complete."
  },
  POLICY_BLOCKED: {
    ja: "ローカルポリシーによりこの操作は許可されていません。",
    en: "Local policy blocked this operation."
  },
  UNSUPPORTED_UI: {
    ja: "この Microsoft 365 の画面には対応していません。",
    en: "This Microsoft 365 surface is not supported."
  },
  UI_CHANGED: {
    ja: "Microsoft 365 の画面構成がこのバージョンの想定と異なります。",
    en: "The Microsoft 365 page structure differs from what this version expects.",
    remediation: {
      ja: "パネルの「診断をコピー」で診断情報を取得し、開発者に報告してください。そのまま再試行しないでください。",
      en: "Copy the diagnostic from the AgentPickLink panel and report it to the developer. Do not retry blindly."
    }
  },
  CHAT_INPUT_NOT_FOUND: {
    ja: "チャットの入力欄が見つかりませんでした。",
    en: "The chat input box could not be found."
  },
  CHAT_INPUT_AMBIGUOUS: {
    ja: "チャットの入力欄の候補が複数見つかりました。",
    en: "More than one chat input box matched."
  },
  NEW_CONVERSATION_UNVERIFIED: {
    ja: "新しい会話を開始できたか確認できませんでした。",
    en: "Starting a new conversation could not be confirmed."
  },
  SUBMIT_FAILED: {
    ja: "プロンプトを送信できませんでした。",
    en: "The prompt could not be submitted."
  },
  SUBMIT_STATE_UNKNOWN: {
    ja: "プロンプトを送信できたかどうか確認できませんでした。",
    en: "Whether the prompt was submitted could not be confirmed."
  },
  RESPONSE_TIMEOUT: {
    ja: "応答が制限時間内に完了しませんでした。",
    en: "The response did not finish within the time budget.",
    remediation: {
      ja: "プロンプトは再送されていません。非表示のブラウザーで応答が続いている可能性があります。同じ会話ハンドルで続きを読むか、browser.responseTimeoutMs を延ばしてください。",
      en: "The prompt was not resubmitted. The response may still complete in the hidden browser; continue the same conversation handle to read it, or raise browser.responseTimeoutMs."
    }
  },
  RESPONSE_EXTRACTION_FAILED: {
    ja: "応答の本文を取り出せませんでした。",
    en: "The response text could not be extracted."
  },
  CONVERSATION_NOT_FOUND: {
    ja: "指定された会話が見つかりません。",
    en: "The conversation handle is unknown."
  },
  CONVERSATION_EXPIRED: {
    ja: "会話の有効期限が切れています。",
    en: "The conversation handle has expired."
  },
  CONVERSATION_OWNERSHIP_MISMATCH: {
    ja: "この会話は別のワークスペースのものです。",
    en: "The conversation belongs to a different workspace."
  },
  CONCURRENT_REQUEST: {
    ja: "他の操作が同じ会話またはブラウザープロファイルを使用中です。",
    en: "Another operation is already using this conversation or the browser profile."
  },
  RATE_LIMITED: {
    ja: "要求が多すぎます。しばらく待ってから再試行してください。",
    en: "Too many requests; wait before retrying."
  },
  INVALID_ARGUMENT: {
    ja: "入力値が正しくありません。",
    en: "The input is not valid."
  },
  INTERNAL_ERROR: {
    ja: "予期しない内部エラーが発生しました。",
    en: "An unexpected internal error occurred."
  }
} satisfies Record<ErrorCode, ErrorCodeEntry>;

/** Widened view of the dictionary, so a dynamic lookup has one uniform value type. */
const ERROR_CODE_ENTRIES: Record<ErrorCode, ErrorCodeEntry> = ERROR_CODE_TEXT;

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export type ErrorCodeDescription = {
  /** The localized one-liner the panel shows as the error banner's headline. */
  summary: string;
  /** A localized replacement for the English remediation, for the codes that have one. */
  remediation?: string;
};

/**
 * The localized description of an `ErrorCode`, or `undefined` for a string that is not one (the
 * panel then falls back to the English message the domain layer produced).
 */
export function describeErrorCode(locale: Locale, code: string): ErrorCodeDescription | undefined {
  if (!KNOWN_ERROR_CODES.has(code)) return undefined;
  const entry = ERROR_CODE_ENTRIES[code as ErrorCode];
  return {
    summary: entry[locale],
    ...(entry.remediation ? { remediation: entry.remediation[locale] } : {})
  };
}

/* ---------------------------------------------------------------- terminal setup host phases */

/** One line per `PanelPhase`, for the terminal `SetupHost` (WP-B) to print whenever the phase in a
 * `PanelState` it is handed changes -- the terminal's equivalent of the panel's header text. Kept
 * here (rather than duplicated in src/cli/setup-host-terminal.ts) so the `satisfies` check below
 * fails `npm run typecheck` the same way `ERROR_CODE_TEXT` does if a phase is ever added to
 * `PanelPhase` without a line for it. */
const PANEL_PHASE_TEXT = {
  idle: { ja: "待機中", en: "Idle" },
  checking: { ja: "状態を確認しています", en: "Checking status" },
  "signing-in": { ja: "サインインしています", en: "Signing in" },
  discovering: { ja: "エージェントを探索しています", en: "Discovering agents" },
  selecting: { ja: "エージェントを選択してください", en: "Select agents" },
  saving: { ja: "保存しています", en: "Saving" },
  done: { ja: "完了しました", en: "Done" },
  connected: { ja: "接続済み", en: "Connected" },
  error: { ja: "エラー", en: "Error" }
} satisfies Record<PanelPhase, Record<Locale, string>>;

export function describePanelPhase(locale: Locale, phase: PanelPhase): string {
  return PANEL_PHASE_TEXT[phase][locale];
}
