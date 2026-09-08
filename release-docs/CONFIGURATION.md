# 設定ガイド

通常は AgentPickLink パネルから設定します。エージェントの選択後は **承認して保存 / Approve and save**、ブラウザーなどの設定変更後はパネルに表示される保存・適用操作を行ってください。

## クライアント連携

VS Code には拡張機能から MCP 定義を提供します。追加の連携は、希望するものだけを有効にします。

| 連携                 | 書き込み先                          |
| -------------------- | ----------------------------------- |
| Codex                | `~/.codex/config.toml`              |
| Claude Code          | ワークスペースの `.mcp.json`        |
| VS Code の JSON 設定 | ワークスペースの `.vscode/mcp.json` |

既存のクライアント設定に `m365-agents` の起動設定を統合します。クライアント側でも MCP ツールの利用許可が必要な場合があります。

Codex 設定は、AgentPickLink の対象外設定を保持したうえで更新します。変更前の内容を同じ場所の `config.toml.agentpicklink-<ランダムID>.bak` に保存します。構文エラーや安全に編集できない定義がある場合は保存を中止します。バックアップは設定全体を含むため、適切に管理し、不要になったら削除してください。

## VS Code 設定

| 設定                                       | 初期値  | 用途                                                              |
| ------------------------------------------ | ------- | ----------------------------------------------------------------- |
| `agentpicklink.nodePath`                   | 空      | Node.js 22 以降の実行ファイルを絶対パスで指定。空の場合は自動検出 |
| `agentpicklink.autoStartBroker`            | `true`  | ローカル接続プロセスを起動                                        |
| `agentpicklink.autoConnect`                | `true`  | 承認・設定済みワークスペースを再度開いた際に接続状態を確認        |
| `agentpicklink.integrations.codex`         | `false` | Codex 設定の更新を有効化                                          |
| `agentpicklink.integrations.claudeCode`    | `false` | Claude Code 設定の更新を有効化                                    |
| `agentpicklink.integrations.vscodeMcpJson` | `false` | VS Code の MCP JSON 設定の更新を有効化                            |

`agentpicklink.checkForUpdates` は初期値 `true` です。VS Code 起動時に GitHub の新リリース（ベータ版を含む）を確認し、バージョンごとに一度通知します。ユーザー設定で無効にできます。自動インストールは行いません。

## ローカルデータ

Windows の標準保存先は `%LOCALAPPDATA%\M365AgentWorkspace\`、macOS は `~/.local/share/M365AgentWorkspace/` です。設定ファイルはその中の `config.yaml` です。`M365_AGENT_APP_DATA` で変更する場合は、専用のローカル保存先を指定してください。

プロファイル、登録情報、承認情報、ログを保存します。ブラウザープロファイルに通常利用中のプロファイル、共有フォルダ、クラウド同期フォルダを使用しないでください。

直接 `config.yaml` を編集した場合は、変更反映のため接続プロセスを再起動してください。開発者向け CLI では `node dist/cli/index.js broker restart` を実行できます。

## ブラウザーとファイル

| 設定                              | 初期値                                  | 用途                                                |
| --------------------------------- | --------------------------------------- | --------------------------------------------------- |
| `browser.channel`                 | `msedge`                                | 使用するブラウザー。`chrome`、`chromium` も設定可能 |
| `browser.responseTimeoutMs`       | `300000`                                | 質問送信後、回答を待つ上限時間（ミリ秒）            |
| `browser.acceptDownloads`         | `true`                                  | 回答に添付されたファイルを保存                      |
| `browser.maxAttachments`          | `10`                                    | 1 回の回答から保存する最大ファイル数                |
| `browser.maxAttachmentBytes`      | `26214400`                              | 1 ファイルの上限（25 MiB）                          |
| `browser.maxTotalAttachmentBytes` | `104857600`                             | 1 回の回答の合計上限（100 MiB）                     |
| `navigation.downloadHosts`        | `*.sharepoint.com`, `onedrive.live.com` | ファイル取得を許可するホスト                        |

時間のかかる回答・ファイル生成では、回答待ち時間とクライアント側のツール待ち時間を調整してください。生成された Codex 連携設定では、ツール呼び出しに 15 分を設定します。

ダウンロード先のワイルドカード `*.example.com` は配下のホストに一致し、`example.com` 自体には一致しません。ファイルは `APL_downloads/<workspace-key>/<request-id>/` に保存されます。このワークスペース内のファイルは自動削除されないため、不要になったら利用者が削除してください。ローカルアプリデータ側の添付ファイル保存期間・容量設定は、このフォルダには適用されません。

## 承認の変更

利用するエージェントを追加・変更した場合は、選択内容を確認して再承認します。チェックを外して保存すると、そのワークスペースの利用対象から外れます。詳細設定の **このワークスペースの承認を取り消す / Revoke this workspace's approval** で、ローカルの利用承認を取り消せます。

`.m365-agents.json` は利用したいエージェントの指定です。他の端末にコピーしても承認は引き継がれません。
