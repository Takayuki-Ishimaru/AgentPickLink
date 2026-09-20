# リリースノート

## v0.2.2 Beta

### 主な変更

- **旧版整理の削除判定を強化。** `self prune` は保持版の実在・パッケージ同一性、ランチャー、版記録、削除対象を検証します。未知のファイルやディレクトリー、壊れた情報、リンク、不整合があれば、全体を無変更で拒否します。`--yes` でも検証し、操作確認後にも再検証します。
- **任意診断を総合判定へ反映。** `doctor --auth` はサインイン要求、対話認証、アクセス拒否を要対応、`unknown` を未確認として `ok: false`・終了コード `1` にします。`--agent` の無効・未確認・エラー結果も反映し、未指定の検査は失敗扱いしません。
- **完了条件欄を即時更新。** エージェント選択件数とクライアント連携の未保存状態を、画面全体を再描画せずに更新します。検索・スクロール位置を維持し、完了条件欄の開閉状態も再描画時に保持します。

保存完了の状態通知が再送された場合も、その後に行った未保存の変更を保持します。

### 更新方法

VS Code 拡張機能を使う場合は、`agent-pick-link-0.2.2.vsix` を **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続も再起動してください。

ポータブル版は、お使いの OS・CPU 向けのアーカイブを展開し、`apl-setup <ワークスペース>` を実行します。既存の設定、ワークスペース承認、専用ブラウザープロファイルを引き続き利用できます。

`self prune` が版情報の不整合や未知の項目を検出した場合は、`--home` と対象フォルダーを確認してください。必要なファイルは別の場所へ保管し、インストール情報が壊れている場合は同じ場所へ再インストールして修復します。`--yes` は操作確認だけを省略します。

### 配布物

- `agent-pick-link-0.2.2.vsix` — VS Code 拡張機能。
- `AgentPickLink-0.2.2-win-x64.zip` / `AgentPickLink-0.2.2-win-arm64.zip` — Windows 用ポータブル版。
- `AgentPickLink-0.2.2-darwin-arm64.tgz` / `AgentPickLink-0.2.2-darwin-x64.tgz` — macOS 用ポータブル版（開発・検証向け）。
- `AgentPickLink-0.2.2-linux-x64.tgz` — Linux 用アーカイブ（開発・CI 専用）。
- `agent-pick-link-0.2.2-source.zip` — ソースコード。
- `SHA256SUMS` — 配布ファイルの SHA-256 チェックサム。

ポータブル版には Node.js 24.21.0 を同梱します。

### 対応範囲

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向けです。Linux は開発・CI 専用で、標準の `serve` は `PLATFORM_UNSUPPORTED` を返します。対応環境に変更はありません。

この版では Windows デスクトップ実機、実 Microsoft 365 テナント、実際の VS Code 画面での追加確認は行っていません。セットアップの保存完了や `doctor` の正常判定は、実際の回答・生成ファイル取得を保証するものではありません。[対応環境と検証範囲](RELEASE-CHECKLIST.md)、[導入手順](README.md) を参照してください。

### English

- **Safer old-version cleanup.** `self prune` verifies installation ownership, the retained package, launcher and version records, and every deletion target. Unknown entries, damaged metadata, links or inconsistent records stop cleanup before any package is deleted. Checks run even with `--yes` and are repeated after confirmation.
- **Complete optional diagnostics.** `doctor --auth` reports sign-in requirements, interactive authentication, access denial and inconclusive states in its overall result. Failed or inconclusive `--agent` results are included too. These findings produce `ok: false` and exit `1`; unrequested checks do not cause a failure.
- **Up-to-date setup completion checks.** Agent counts and unsaved integration changes update immediately without rebuilding the panel. Search, scrolling and the expanded completion section are preserved. Repeated save-completion notifications retain subsequent unsaved edits.

To update, install `agent-pick-link-0.2.2.vsix`, reload VS Code, and restart external clients' MCP connections. For portable installations, extract the archive for your OS and CPU and run `apl-setup <workspace>`. Existing settings, workspace approvals and the dedicated browser profile can be reused.

If cleanup reports inconsistent metadata or unknown entries, check the selected installation directory, preserve any needed files separately, and reinstall to the same location to repair damaged metadata. `--yes` only skips confirmation.

Downloads include the VSIX, Windows x64 / ARM64 and macOS Apple Silicon / Intel portable archives, a development/CI-only Linux x64 archive, source code and `SHA256SUMS`. Portable archives bundle Node.js 24.21.0.

Support remains unchanged: Windows 11 with Edge is the primary target; macOS is for development and verification. Linux is for development/CI only. Additional Windows desktop, live-tenant and actual VS Code interface checks have not been performed for this version. Setup completion and a healthy doctor result do not verify live answers or generated files. See the [English README](README.en.md) and [validation scope](RELEASE-CHECKLIST.md).

## v0.2.1 Beta

### 主な変更

- **アンインストール時の確認を強化しました。** インストール情報と削除対象のファイルを照合し、対象の接続プロセスが終了したことを確認してから削除します。別のインストールが使う連携設定や、無関係なファイルを保持します。
- **VS Code の設定を保持します。** MCP 登録の追加・更新・除去で、JSONC のコメント、末尾カンマ、他のサーバーや設定を保持します。構文に問題がある設定は上書きせず、エラーを表示します。
- **ブラウザーセットアップのエラー表示を改善しました。** 接続の拒否、セッションの期限切れ、処理の競合、サーバーエラー、通信断を表示し、復旧方法を案内します。処理中の重複操作を抑制し、結果が不明な操作は自動再送しません。
- **セットアップの準備状態を確認しやすくしました。** サインイン、エージェントの選択、承認、クライアント連携を個別に表示します。設定の保存完了と、エージェントから実際に回答を取得できることを区別します。
- **CLI をスクリプトから利用しやすくしました。** `--json` の結果を stdout の単一 JSON オブジェクトにし、進捗と確認は stderr に出力します。`doctor` の終了コードは正常 `0`、問題あり `1`、診断実行失敗 `2` です。ヘルプ・バージョン表示と MCP 通信用の `serve` は、この JSON 出力の対象外です。
- **ランチャーとバージョン切り替えを修正しました。** ESM プロジェクト内のインストール先でも `apl` が起動します。不正なバージョン名や不完全なパッケージへの切り替えを拒否し、更新・切り替え・削除の同時実行による競合を防ぎます。
- **AI クライアント向けの案内を整理しました。** 初期案内を簡潔にし、生成ファイルの形式ごとの確認方法を MCP リソース `apl://guidance/file-generation` で参照できるようにしました。

### 更新方法

VS Code 拡張機能を使う場合は、`agent-pick-link-0.2.1.vsix` を **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続も再起動してください。

ポータブル版を使う場合は、お使いの OS・CPU 向けのアーカイブを展開し、そのフォルダーで `apl-setup <ワークスペース>` を実行してください。既存の設定、ワークスペース承認、専用ブラウザープロファイルを引き続き利用できます。

アンインストール時にインストール情報の破損が報告された場合は、同じ場所へ再インストールして修復してから削除してください。`--yes` は操作確認だけを省略し、削除対象の検証は省略しません。`--purge-data` は共有データを使用中の別の接続プロセスがある場合、削除を拒否します。

### 配布物

- `agent-pick-link-0.2.1.vsix` — VS Code 拡張機能。
- `AgentPickLink-0.2.1-win-x64.zip` / `AgentPickLink-0.2.1-win-arm64.zip` — Windows 用ポータブル版。
- `AgentPickLink-0.2.1-darwin-arm64.tgz` / `AgentPickLink-0.2.1-darwin-x64.tgz` — macOS 用ポータブル版（開発・検証向け）。
- `AgentPickLink-0.2.1-linux-x64.tgz` — Linux 用アーカイブ（開発・CI 専用）。
- `agent-pick-link-0.2.1-source.zip` — ソースコード。
- `SHA256SUMS` — 配布ファイルの SHA-256 チェックサム。

ポータブル版には Node.js 24.21.0 を同梱します。

### 対応範囲

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向けです。Linux の通常利用は対象外で、標準の `serve` は `PLATFORM_UNSUPPORTED` を返します。WSL、Remote SSH、Dev Containers、Codespaces、マルチルートのワークスペース、無人運転には対応しません。

この版では Windows 実機、実 Microsoft 365 テナント、実際の VS Code 画面での追加確認は行っていません。自動テストやローカルの接続確認は、テナントごとの動作を保証するものではありません。詳しくは [対応環境と検証範囲](RELEASE-CHECKLIST.md)、導入手順は [README](README.md) を参照してください。

### English

- **Safer uninstall.** Validate installation metadata and owned files, wait for the matching connection process to exit, and preserve unrelated files and settings belonging to other installations.
- **Preserve VS Code settings.** Adding, updating, or removing MCP entries retains JSONC comments, trailing commas, other servers, and unrelated settings. Invalid configuration is reported without overwriting it.
- **Clearer browser setup errors.** Show access denial, expired sessions, conflicts, server errors, and connection failures with recovery guidance. Prevent duplicate pending operations and never automatically resend operations with an uncertain result.
- **Clearer setup readiness.** Show sign-in, agent selection, approval, and client integration separately. Saving settings does not imply that a live agent response has been verified.
- **Consistent CLI output.** `--json` returns one JSON object on stdout, with progress and prompts on stderr. `doctor` exits `0` for healthy, `1` for findings, and `2` for execution failure. Help, version display, and the MCP-only `serve` command are excluded from this JSON contract.
- **Reliable launchers and version changes.** Run the launcher from installation paths inside ESM projects, reject invalid version names and incomplete packages, and coordinate concurrent updates, version changes, and removal.
- **Focused AI client guidance.** Keep initial instructions concise and expose format-specific generated-file checks through the `apl://guidance/file-generation` MCP resource.

To update, install `agent-pick-link-0.2.1.vsix`, reload VS Code, and restart external clients' MCP connections. For portable installations, extract the archive for your OS and CPU and run `apl-setup <workspace>`. Existing settings, workspace approvals, and the dedicated browser profile can be reused.

If uninstall reports damaged installation metadata, reinstall to the same location before removing it. `--yes` skips confirmation only. `--purge-data` refuses to remove shared data while another connection process uses it.

Downloads include the VSIX, portable archives for Windows x64 / ARM64 and macOS Apple Silicon / Intel, a development/CI-only Linux x64 archive, source code, and `SHA256SUMS`. Portable archives bundle Node.js 24.21.0.

This beta primarily targets Windows 11 with Edge; macOS is for development and verification. Linux is not supported for normal use, and standard `serve` returns `PLATFORM_UNSUPPORTED`. WSL, Remote SSH, Dev Containers, Codespaces, multi-root workspaces, and unattended operation remain unsupported.

Additional Windows desktop, live Microsoft 365 tenant, and actual VS Code interface checks have not been performed for this version. Automated tests and local connection checks do not establish tenant compatibility. See the [English README](README.en.md) and [validation scope](RELEASE-CHECKLIST.md).

## v0.2.0 Beta

### 主な変更

- **拡張機能なしで導入できます。** Node.js 同梱のポータブルアーカイブを追加しました。`apl-setup <ワークスペース>` でサインイン、エージェントの選択と承認、対応 AI クライアントへの MCP 登録、接続確認を行えます。Node.js の別途インストールは不要です。
- **ブラウザーでセットアップできます。** `apl-setup --browser` でセットアップ画面を開けます。エージェントの利用承認は端末で確認します。`--dry-run` では設定を変更せずに導入内容を確認できます。
- **更新と切り戻しを改善しました。** VS Code 拡張機能とポータブル版が同じインストール先を共有します。`apl self use <バージョン>` で以前の版へ戻せます。`apl self prune` は旧版を削除する前に確認します。
- **接続とエージェント一覧の取得を安定化しました。** 更新後の接続プロセスの再起動、ブラウザーの終了処理、一覧の追加読み込みを改善しました。Windows の一部環境で Edge の初回起動が失敗する問題も修正しました。
- **問題を調べやすくしました。** `apl doctor` で導入状態を確認できます。セットアップや接続に失敗した場合は、エラーの理由と対処方法、診断ログを確認できます。

### 更新方法

VS Code 拡張機能を使う場合は、`agent-pick-link-0.2.0.vsix` を **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続も再起動してください。

ポータブル版を使う場合は、お使いの OS・CPU 向けのアーカイブを展開し、そのフォルダーで `apl-setup <ワークスペース>` を実行してください。更新時も、新しいアーカイブを展開して同じコマンドを実行します。

既存の設定、ワークスペース承認、専用ブラウザープロファイルは引き続き利用できます。v0.1.x の拡張機能で有効にした連携設定は、起動時に新しい形式へ移行します。手動で作成した連携設定は保持します。

### 配布物

- `agent-pick-link-0.2.0.vsix` — VS Code 拡張機能。
- `AgentPickLink-0.2.0-win-x64.zip` / `AgentPickLink-0.2.0-win-arm64.zip` — Windows 用ポータブル版。
- `AgentPickLink-0.2.0-darwin-arm64.tgz` / `AgentPickLink-0.2.0-darwin-x64.tgz` — macOS 用ポータブル版。
- `AgentPickLink-0.2.0-linux-x64.tgz` — Linux 用ポータブル版（実験的）。
- `agent-pick-link-0.2.0-source.zip` — ソースコード。
- `SHA256SUMS` — 配布ファイルの SHA-256 チェックサム。

ポータブル版には Node.js 24.21.0 を同梱します。

### 対応範囲と制限

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向け、Linux は実験的な提供です。Windows ARM64 / Linux x64 の実機動作と macOS Intel のネイティブ動作は未確認です。

VS Code のユーザープロファイルへの登録は単一フォルダー向けです。複数のフォルダーで使う場合は、各フォルダーで `--clients vscode-workspace` を指定してください。マルチルートのワークスペースは対象外です。

今回の版では、AI クライアント経由の質問・回答・生成ファイル取得、英語 UI、MFA・条件付きアクセスを伴う再サインイン、エージェント種別ごとの会話、実際の拡張パネルでの一連のセットアップ操作は未確認です。自動テストはローカルの模擬画面を使用し、実テナントでの動作を保証しません。確認済みの操作とその他の未確認項目は [検証範囲](RELEASE-CHECKLIST.md) を参照してください。

導入手順は [README](README.md)、組織での導入は [管理者向けノート](MANAGED-ENVIRONMENTS.md) を参照してください。

### English

- **Install without the VS Code extension.** Portable archives bundle Node.js. Run `apl-setup <workspace>` to sign in, select and approve agents, register MCP with supported AI clients, and check the connection.
- **Set up in your browser.** Use `apl-setup --browser` to open the setup page; agent approvals are confirmed in the terminal. Use `--dry-run` to preview the installation without changing settings.
- **Update or roll back.** The extension and portable edition share one installation. Use `apl self use <version>` to return to an earlier version. `apl self prune` asks before deleting old versions.
- **More reliable connections and discovery.** Improved connection-process restarts, browser shutdown, and loading additional agents. Fixed Edge failing to launch for the first time in some Windows environments.
- **Clearer diagnostics.** `apl doctor` checks the installation. Setup and connection failures provide error details, suggested remedies, and diagnostic logs.

To update the extension, install `agent-pick-link-0.2.0.vsix` using **Extensions: Install from VSIX…**, reload VS Code, and restart external clients' MCP connections. For the portable edition, extract the archive for your OS and CPU and run `apl-setup <workspace>` from that folder. Repeat with the new archive when upgrading.

Existing settings, workspace approvals, and the dedicated browser profile can be reused. Integrations enabled by the v0.1.x extension migrate at startup; manually created entries are preserved.

Downloads include the VSIX, portable archives for Windows x64 / ARM64, macOS Apple Silicon / Intel, and Linux x64, plus `agent-pick-link-0.2.0-source.zip` and `SHA256SUMS`. Portable archives bundle Node.js 24.21.0.

This beta primarily targets Windows 11 with Microsoft Edge. macOS is intended for development and verification; Linux support is experimental. Native operation on Windows ARM64, Linux x64, and Intel Macs has not been verified. VS Code user-profile registration supports one folder; use `--clients vscode-workspace` for each folder when working with several folders. Multi-root workspaces are unsupported.

For this version, sending questions and retrieving answers or generated files through AI clients, the English UI, re-login with MFA or Conditional Access, conversations across agent types, and the complete setup flow in the actual extension panel have not been verified. Automated tests use local mock pages and do not establish live-tenant compatibility. The [verification scope](RELEASE-CHECKLIST.md) lists confirmed operations and remaining limitations, including client application and OS policy checks.

See the [English README](README.en.md) and [Managed environments](MANAGED-ENVIRONMENTS.en.md) for installation details.

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
