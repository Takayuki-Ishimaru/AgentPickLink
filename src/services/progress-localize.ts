import type { Locale } from "./setup-protocol.js";

const MESSAGES_JA: Record<string, string> = {
  Working: "処理中",
  "Preparing local state": "ローカルの設定を準備しています",
  "Connecting to broker": "バックグラウンド処理に接続しています",
  "Checking sign-in status": "サインインの状態を確認しています",
  "Waiting for sign-in confirmation": "サインインの確認を待っています",
  "Starting agent discovery": "エージェントの探索を開始しています",
  "Opening the Microsoft 365 landing page": "Microsoft 365 のホームページを開いています",
  "Waiting for the Microsoft 365 landing page to render": "Microsoft 365 のホームページの表示を待っています",
  "Reading the agent sidebar": "サイドバーのエージェントを読み取っています",
  "Reading direct agent links": "エージェントへのリンクを読み取っています",
  "Looking for the full agent list": "エージェントの一覧を探しています",
  "Reading the agent store": "エージェントのストアを読み取っています",
  "Retrying an agent description after the page has loaded": "ページの表示後に説明文を確認しています",
  "Waiting for sign-in in the AgentPickLink window": "AgentPickLink のウィンドウでサインインしてください",
  "Sign-in completed; closing the sign-in window": "サインインを確認しました。ウィンドウを閉じています",
  "Verifying the session in the hidden browser": "バックグラウンドのブラウザーでサインインを確認しています",
  "The dedicated automation profile is signed in": "自動操作用のプロファイルでサインインしました"
};

export function localizedProgressMessage(message: string, locale: Locale): string {
  if (locale !== "ja") return message;
  const heartbeat = message.endsWith(" (still working)");
  const base = heartbeat ? message.slice(0, -" (still working)".length) : message;
  const found = /^Found (\d+) agent candidate\(s\)$/.exec(base);
  return (
    (MESSAGES_JA[base] ?? (found ? `${found[1]} 件の候補が見つかりました` : base)) +
    (heartbeat ? "（処理中）" : "")
  );
}

export function progressPhaseLabel(phase: string, locale: Locale): string {
  if (locale !== "ja") return phase;
  const labels: Record<string, string> = {
    connecting: "接続中",
    discovering: "エージェントを探索中",
    verifying: "確認中",
    done: "完了",
    "login-waiting": "サインイン待ち",
    "login-closing": "サインイン確認済み"
  };
  return labels[phase] ?? "処理中";
}
