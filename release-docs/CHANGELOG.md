# リリースノート

## v0.1.1 Beta

- SharePoint / OneDrive の個人向け・サイト向け共有リンクから、PDF などのファイルを認識する処理を修正しました。同じ表示名の異なるリンクも取得対象になります。
- ファイル取得時にサインインの転送完了を待ち、転送先のビューアーから実ファイルを保存する処理を改善しました。
- Windows + Edge のバックグラウンド処理で、新しいタブの作成やファイル保存時に画面が一瞬表示されたり、入力フォーカスが移ったりする問題を修正しました。次のサインインでは専用ウィンドウを操作できる位置に開きます。
- VS Code 起動時に GitHub の新リリースを確認し、更新を通知する機能を追加しました。`agentpicklink.checkForUpdates` で無効にできます。

### 更新方法・配布物

`agent-pick-link-0.1.1.vsix` を VS Code の **拡張機能: VSIX からのインストール…** でインストールし、再読み込みしてください。既存の設定・ワークスペース承認・専用ブラウザープロファイルはそのまま利用できます。外部 AI クライアントの MCP 接続も再起動してください。

- `agent-pick-link-0.1.1.vsix` — VS Code 拡張機能。
- `agent-pick-link-0.1.1-source.zip` — テスト・ビルドに必要なソース。
- `SHA256SUMS.txt` — 上記ファイルの SHA-256 チェックサム。

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向けです。Microsoft 365 の画面変更、テナント設定、アクセス権限によって接続・ファイル取得に失敗する場合があります。利用手順と対応範囲は [README](README.md) を参照してください。

### English

- Recognize personal and site SharePoint / OneDrive sharing links for PDF and other files, including different links with the same display label.
- Wait for passive sign-in redirects and download the actual file from the resolved viewer.
- Fix Edge windows briefly appearing or taking input focus during background tab creation and file saving on Windows. Subsequent sign-in windows open in a visible position.
- Check GitHub releases on VS Code startup and notify once per newer version. Disable with `agentpicklink.checkForUpdates`.

Install `agent-pick-link-0.1.1.vsix` using **Extensions: Install from VSIX…**, reload VS Code, and restart external clients' MCP connections. Existing settings, workspace approvals, and the dedicated browser profile can be reused. Source is provided as `agent-pick-link-0.1.1-source.zip`, with checksums in `SHA256SUMS.txt`.

This beta primarily targets Windows 11 with Microsoft Edge; macOS is intended for development and verification. Microsoft 365 interface changes, tenant settings, and access permissions may affect connections and downloads. See the [English README](README.en.md) for setup and support boundaries.

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
