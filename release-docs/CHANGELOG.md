# リリースノート

## v0.1.3 Beta — 2026-09-09

- 添付ファイルを保存する際、Microsoft 365 が提供する元のファイル名を優先するよう改善しました。日本語・空白・丸数字を保持し、同名の別ファイルは連番を付けて保存します。
- PDF・Office 文書・画像・音声・動画・圧縮ファイルが、拡張子なしの名前で保存される問題を修正しました。取得元の情報と対応する形式の識別情報を使って、欠けた拡張子を補います。
- 旧版で拡張子なしのまま保存したファイルも、MCP 経由で読み出す際に形式を識別する処理を改善しました。
- AI クライアント向けに、保存した PDF の読み出しと表示確認の案内を改善しました。

### 更新方法・配布物

`agent-pick-link-0.1.3.vsix` を VS Code の **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続も再起動してください。既存の設定・ワークスペース承認・専用ブラウザープロファイルを引き続き利用できます。

- `agent-pick-link-0.1.3.vsix` — VS Code 拡張機能。
- `agent-pick-link-0.1.3-source.zip` — テスト・ビルドに必要なソース。
- `SHA256SUMS.txt` — 上記ファイルの SHA-256 チェックサム。

### ファイルの扱い・対応範囲

保存済みファイルの名前や内容は自動変更しません。新しく保存するファイルも、元の名前を取得できない場合は代替名を使用します。パス要素や OS で使えない文字は取り除きます。既存の拡張子や、README などの意図的な拡張子なしテキストは保持します。

形式の識別は、文書の内容・表示・再生の正しさを保証しません。対応する文書リーダーや表示ツールは別途必要です。詳しくは [トラブルシューティング](TROUBLESHOOTING.md) を参照してください。

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向け、Ubuntu は実験的な検証対象です。公開 CI はローカルの模擬画面を使用し、実 Microsoft 365 テナントや実際の VS Code 画面の確認は含みません。このリリースでの実テナントの追加確認は未実施です。利用手順は [README](README.md)、自動テストの範囲は [検証範囲](RELEASE-CHECKLIST.md) を参照してください。

### English

- Improved attachment naming to prefer the original filename supplied by Microsoft 365. Japanese characters, spaces, and circled numbers are preserved; different files with the same name receive a numeric suffix.
- Fixed PDF, Office, image, audio, video, and archive attachments being saved without an extension. Missing extensions are filled using source metadata and supported file-format signatures.
- Improved media-type detection when reading files saved without an extension by an earlier version through MCP.
- Improved guidance for AI clients on reading saved PDFs and checking their rendering.

Install `agent-pick-link-0.1.3.vsix` using **Extensions: Install from VSIX…**, reload VS Code, and restart external clients' MCP connections. Existing settings, workspace approvals, and the dedicated browser profile can be reused. Source is available as `agent-pick-link-0.1.3-source.zip`, with checksums in `SHA256SUMS.txt`.

Previously saved files are not renamed or modified automatically. New downloads use a fallback name only when the original name is unavailable. Path components and characters that cannot be used in filenames are removed. Existing extensions and intentionally extensionless text files such as README are preserved.

Format detection does not validate document content, rendering, or playback. Compatible readers and rendering tools are still required separately.

This beta primarily targets Windows 11 with Microsoft Edge. macOS is intended for development and verification; Ubuntu remains experimental. Public CI uses local mock pages and does not cover a live Microsoft 365 tenant or the actual VS Code interface. Additional live-tenant checks have not been performed for this release. See the [English README](README.en.md) for setup.

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
