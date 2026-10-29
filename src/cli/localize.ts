import { Help, type Command } from "commander";
import type { Locale } from "../services/setup-protocol.js";

const HELP_JA: Record<string, string> = {
  "emit machine-readable JSON": "スクリプト向けの JSON を出力",
  "confirm explicitly requested operations": "明示的に要求した操作を承認",
  "output the version number": "バージョンを表示",
  "display help for command": "コマンドのヘルプを表示",
  "Create the global configuration and local state files.": "共通設定とローカルの状態ファイルを作成します。",
  "Sign in to Microsoft 365 using the managed browser.":
    "専用ブラウザーで Microsoft 365 にサインインします。",
  "Sign out and close the managed browser session.": "サインアウトし、専用ブラウザーのセッションを閉じます。",
  "Check local setup, workspace approval, integrations, and broker health.":
    "ローカル設定・ワークスペースの承認・連携・ブローカーを診断します。",
  "validate one configured agent without sending a message":
    "メッセージを送信せず、指定したエージェントを確認",
  "check the current browser sign-in state": "ブラウザーのサインイン状態を確認",
  "Inspect and control the local background broker.": "ローカルのバックグラウンド処理を確認・操作します。",
  "Show whether the broker is running and its health.": "ブローカーの起動状態と診断結果を表示します。",
  "Restart the local broker.": "ブローカーを再起動します。",
  "Stop the local broker.": "ブローカーを停止します。",
  "Discover, register, and validate agents.": "エージェントを探索・登録・確認します。",
  "Register an agent from a browser page or direct URL.":
    "ブラウザーのページまたは直接 URL からエージェントを登録します。",
  "capture the current agent page in a dedicated Edge window":
    "専用 Edge ウィンドウのエージェントページから取得",
  "register the specified direct agent URL": "指定した直接 URL のエージェントを登録",
  "replace an existing agent with the same alias": "同じ別名の登録を置き換え",
  "Remove a registered agent by alias.": "別名を指定してエージェントの登録を削除します。",
  "List registered agents and their readiness.": "登録済みのエージェントと利用状態を表示します。",
  "Find available agents in Microsoft 365.": "Microsoft 365 の利用可能なエージェントを探索します。",
  "open the sign-in window if needed": "必要な場合はサインインのウィンドウを表示",
  "Validate an agent; optionally send a test message.":
    "エージェントを確認します。指定した場合のみテストを送信します。",
  "send a test message (requires --yes to confirm)": "テストメッセージを送信（承認には --yes が必要）",
  "Manage this repository's agent assignments and approvals.":
    "このリポジトリのエージェントの割り当てと承認を管理します。",
  "Select verified agents for this workspace.": "このワークスペースに確認済みのエージェントを割り当てます。",
  "List agents assigned to this workspace.": "このワークスペースの割り当てを表示します。",
  "Check workspace assignments and approvals.": "ワークスペースの割り当てと承認を確認します。",
  "Review and approve the assigned agents.": "割り当てを確認して承認します。",
  "Show the current approval state.": "現在の承認状態を表示します。",
  "Revoke this workspace's agent approvals.": "このワークスペースの承認を取り消します。",
  "Set up AgentPickLink for one or more workspaces. Use --verbose to echo metadata-only diagnostic lines (broker-release waits, restart-and-retry outcomes) to stderr, prefixed [log].":
    "ワークスペースに AgentPickLink を設定します。--verbose で診断ログを標準エラー出力にも表示します。",
  "workspace folder(s) to set up": "設定するワークスペースのフォルダー",
  "another workspace folder (repeatable)": "追加のワークスペース（繰り返し指定可）",
  "echo metadata-only diagnostic lines (broker-release waits, restart-and-retry outcomes) to stderr, prefixed [log]":
    "診断ログを [log] 付きで標準エラー出力にも表示",
  "stage the invoking extension and retain existing agent approvals":
    "起動元の拡張機能を配置し、既存の承認を保持",
  "use the browser setup page; confirmations stay in the terminal":
    "ブラウザーの設定画面を使用（承認操作は端末で実施）",
  "display the one-shot browser URL without opening it": "ブラウザーを開かず、一度限りの URL を表示",
  "print the plan and stop; nothing is written": "計画のみ表示して終了（書き込みなし）",
  "auto (default: vscode/vscode-user + claude/claude-user user-scope + codex) | none | vscode,vscode-user,vscode-workspace,claude,claude-user,claude-project,codex":
    "auto（既定: VS Code・Claude Code はユーザー全体、Codex）| none | vscode,vscode-user,vscode-workspace,claude,claude-user,claude-project,codex",
  "comma-separated aliases/keys (or key=alias); skips the interactive prompt":
    "別名・キー（key=alias も可）をカンマ区切りで指定し、対話選択を省略",
  "install location, overriding the platform default": "既定のインストール先を変更",
  "confirm the agent-roster approval in a non-interactive run (separate from --yes)":
    "端末なしでエージェントの一覧を承認（--yes とは別）",
  "confirm the capability-widening consent non-interactively, for a plan with an actions-possible agent":
    "端末なしでファイル生成・アクションの能力拡大を承認",
  "allow installing an older version than the one currently installed":
    "現在より古いバージョンのインストールを許可",
  "register this checkout as the machine install instead of staging a copy":
    "この開発用チェックアウトをインストール先として登録",
  "Manage the portable CLI installation.": "ポータブル CLI のインストールを管理します。",
  "Show the installed CLI version, runtime, and launcher path.":
    "CLI のバージョン、実行環境、設定・ログの保存先を表示します。",
  "Switch the active CLI installation to a staged version.": "配置済みのバージョンに切り替えます。",
  "Remove unused staged versions.": "未使用のバージョンを削除します。",
  "Remove the portable CLI installation.": "ポータブル CLI をアンインストールします。",
  "also remove agents.yaml, approvals.json and the browser profile":
    "agents.yaml・approvals.json・ブラウザープロファイルも削除",
  "Write, inspect, remove, or print AI client configuration.":
    "AI クライアントの設定を登録・確認・削除・表示します。",
  "Register AgentPickLink with the selected AI clients.":
    "選択した AI クライアントに AgentPickLink を登録します。",
  "client list: vscode, vscode-user, vscode-workspace, claude, claude-user, claude-project, codex (default: vscode,claude,codex)":
    "連携先: vscode,vscode-user,vscode-workspace,claude,claude-user,claude-project,codex（既定: vscode,claude,codex）",
  "workspace folder (default: the current directory)": "ワークスペースのフォルダー（既定: 現在のフォルダー）",
  "overwrite a foreign (not AgentPickLink-owned) entry too, after backing it up":
    "バックアップを作成して、他の設定の項目も上書き",
  "Show whether each selected client has a current AgentPickLink entry.":
    "各クライアントの AgentPickLink の登録状態を表示します。",
  "comma-separated client names (default: vscode,claude,codex)":
    "連携先をカンマ区切りで指定（既定: vscode,claude,codex）",
  "Remove AgentPickLink entries from the selected clients.":
    "指定したクライアントから AgentPickLink の登録を削除します。",
  "remove a foreign (not AgentPickLink-owned) entry too, after backing it up":
    "バックアップを作成して、他の設定の項目も削除",
  "Print ready-to-paste configuration for selected clients.":
    "クライアントに貼り付けられる設定を表示します。",
  "Run the MCP server over standard input and output.": "標準入出力で MCP サーバーを実行します。"
};

export function localizeCliHelp(command: Command, locale: Locale): void {
  if (locale !== "ja") return;
  command.description(HELP_JA[command.description()] ?? command.description());
  for (const option of command.options)
    option.description = HELP_JA[option.description] ?? option.description;
  for (const argument of command.registeredArguments)
    argument.description = HELP_JA[argument.description] ?? argument.description;
  command.helpOption("-h, --help", "コマンドのヘルプを表示");
  command.addHelpCommand("help [command]", "コマンドのヘルプを表示");
  command.configureHelp({
    formatHelp: (cmd, helper) =>
      Help.prototype.formatHelp
        .call(helper, cmd, helper)
        .replace(/^Usage:/m, "使い方:")
        .replace(/^Arguments:/m, "引数:")
        .replace(/^Options:/m, "オプション:")
        .replace(/^Commands:/m, "コマンド:")
  });
  command.commands.forEach((child) => localizeCliHelp(child, locale));
}
