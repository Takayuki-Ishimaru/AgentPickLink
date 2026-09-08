# リリースノート

## v0.1.0 Beta

AgentPickLink for M365 の初回ベータ版です。

### 主な機能

- VS Code パネルからの Microsoft 365 サインイン、エージェント一覧取得、選択とワークスペース単位の承認。
- MCP によるエージェント一覧、質問、継続会話の管理。
- 回答テキスト・引用の取得と、許可された取得先からの生成ファイル保存。
- VS Code の MCP 定義提供と、任意で有効にする Codex・Claude Code・VS Code JSON 設定連携。
- 接続の復元、診断情報、承認取消、サインアウト。

### 配布物

- `agent-pick-link-0.1.0.vsix` — 一般利用者向け VS Code 拡張機能。
- `agent-pick-link-0.1.0-source.zip` — テスト・ビルドに必要な開発者向けソース。
- `SHA256SUMS.txt` — 上記ファイルの SHA-256 チェックサム。

### ベータ版の制限

Windows 11 と Microsoft Edge を主な対象とし、macOS は開発・検証向けです。Microsoft 365 の画面変更、テナントの設定、エージェントの種類によって、一覧取得・質問・添付ファイル保存に失敗する場合があります。

WSL、Remote SSH、Dev Containers、Codespaces、複数ルートのワークスペース、リモート MCP サーバー、無人実行は対象外です。

送信結果が不明な場合は自動再送しません。回答・生成ファイルの内容は利用者側で確認してください。詳しい手順は [README](README.md) を参照してください。
