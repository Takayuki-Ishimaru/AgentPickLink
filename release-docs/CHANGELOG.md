# リリースノート

## v0.1.2 Beta

- Codex 連携の設定更新で、配列テーブルなどの無関係な設定が消える問題を修正しました。変更前のバックアップを保存し、対象外の設定を保持します。
- 質問・回答・履歴に「生成を停止」や「Stop generating」が含まれると、回答の完了待ちがタイムアウトする問題を修正しました。
- 添付リンクが順に表示される場合に、後から現れるファイルを取りこぼす問題を改善しました。同名でもリンクが異なるファイルを取得対象にします。
- 複数の MCP クライアントを同時に起動した際、初期設定の待機に失敗する問題を修正しました。
- Windows・macOS・Ubuntu で、テスト、実ブラウザーによる模擬画面の操作、VSIX 作成と同梱 CLI・MCP の起動確認を行う公開 CI を追加しました。

### 更新方法・配布物

`agent-pick-link-0.1.2.vsix` を VS Code の **拡張機能: VSIX からのインストール…** でインストールし、再読み込みしてください。既存の設定・ワークスペース承認・専用ブラウザープロファイルを引き続き利用できます。外部 AI クライアントの MCP 接続も再起動してください。

Codex 設定を変更すると、設定ファイルと同じ場所に `config.toml.agentpicklink-<ランダムID>.bak` を保存します。旧版ですでに失われた設定は自動復元できません。必要に応じて、以前のバックアップから復元してください。

- `agent-pick-link-0.1.2.vsix` — VS Code 拡張機能。
- `agent-pick-link-0.1.2-source.zip` — テスト・ビルドに必要なソース。
- `SHA256SUMS.txt` — 上記ファイルの SHA-256 チェックサム。

### 確認範囲

公開 CI は Windows・macOS・Ubuntu 上で、型チェック、lint、単体・結合・回帰テスト、実ブラウザー上の模擬画面操作、スキーマ同期、VSIX の作成・展開と CLI / MCP の接続を確認します。

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向け、Ubuntu は実験的な検証対象です。CI の Windows 環境は Windows Server であり、Windows 11 実機での確認を代替しません。このリリースでは、実 M365 テナントの日本語・英語 UI、エージェント種別ごとの単発・継続会話、再ログイン、単一・複数ファイルの追加確認は未実施です。実際の VS Code 画面も CI の確認範囲に含みません。利用手順は [README](README.md) を参照してください。

### English

- Fixed Codex integration updates deleting unrelated settings such as TOML array tables. Updates preserve unrelated settings and save a backup before replacement.
- Fixed response completion timing out when a question, response, or conversation history contains “生成を停止” or “Stop generating”.
- Improved collection of attachments whose links appear in stages, including different file links with the same display name.
- Fixed initialization failing when multiple MCP clients start simultaneously.
- Added public CI on Windows, macOS, and Ubuntu, covering tests, real-browser interaction with local mock pages, VSIX packaging, and startup of the packaged CLI and MCP server.

Install `agent-pick-link-0.1.2.vsix` using **Extensions: Install from VSIX…**, reload VS Code, and restart external clients' MCP connections. Existing settings, workspace approvals, and the dedicated browser profile can be reused. Source is available as `agent-pick-link-0.1.2-source.zip`, with checksums in `SHA256SUMS.txt`.

Codex configuration updates save `config.toml.agentpicklink-<random-ID>.bak` alongside the original file. Settings already lost by an earlier version cannot be restored automatically; use an earlier backup if needed.

This beta primarily targets Windows 11 with Microsoft Edge. macOS is intended for development and verification; Ubuntu remains experimental. CI uses Windows Server and local mock Microsoft 365 pages. It does not replace Windows 11 desktop testing, live-tenant checks, or testing in the actual VS Code interface. Additional live-tenant checks of Japanese/English interfaces, agent types, single/ongoing conversations, re-login, and single/multiple files have not been performed for this release. See the [English README](README.en.md) for setup.

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
