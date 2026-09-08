/**
 * A deliberately tiny message dictionary for the host-side UI (commands' notifications, the modal
 * approval prompt, the status bar). Japanese when VS Code runs in Japanese, English otherwise.
 * The webview carries its own copy of the strings it renders (media/setup.js).
 */
import { ERROR_CODES, type ErrorCode } from "../domain/errors.js";
import type { Locale } from "./protocol.js";

export function pickLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("ja") ? "ja" : "en";
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
  restartNow: { ja: "今すぐ再起動", en: "Restart now" }
} as const satisfies Record<string, Record<Locale, string>>;

export type MessageKey = keyof typeof MESSAGES;

export function translate(locale: Locale, key: MessageKey): string {
  return MESSAGES[key][locale];
}

/** A bound translator, so call sites read as `t("reload")`. */
export function translator(locale: Locale): (key: MessageKey) => string {
  return (key) => translate(locale, key);
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
