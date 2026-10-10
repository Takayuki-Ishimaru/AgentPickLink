# リリースノート

## v0.2.9 Beta

### 主な変更

- **送信直前に質問と宛先を確認します。** 送信ボタンを待つ間に、入力内容・エージェント・会話・ページのアドレスが変わった場合は、送信せず `UI_CHANGED` または `AGENT_CONTEXT_CHANGED` と未送信（`not-sent`）を返します。質問が別の操作で送信された可能性がある場合は、追加で送信せず `SUBMIT_STATE_UNKNOWN` を返します。
- **複数行の質問が入力途中で送信される不具合を修正しました。** Enter で送信する入力欄でも、改行は Shift+Enter で入力します。
- **送信結果が不明な質問を「未送信」と報告しないようにしました。** ボタンを押した後に質問の表示を確認できない場合は `SUBMIT_STATE_UNKNOWN` を返します。質問の失敗には `submissionState`（`not-sent` / `unknown` / `sent`）を付け、送信された可能性がある失敗を再試行可能とは扱いません。質問の処理中にローカル接続が切れた場合も、送信状態を `unknown` として返し、自動再送しません。
- **質問を送り直さずに会話を確認できます。** `SUBMIT_STATE_UNKNOWN` または `RESPONSE_TIMEOUT` に `error.conversationHandle` がある場合は、`m365_agent_session` の `action: "read"` とそのハンドルで、質問の表示状態と回答を取得できます。入力欄や送信ボタンは操作せず、回答にファイルがある場合は通常と同じ設定で保存します。
- **入力の確認待ちと回答待ちを分けました。** 入力欄の安定待ちは新しい設定 `browser.composerStabilityMs`（既定 500 ミリ秒）を使用します。回答の安定待ちは従来の設定を使用します。テキストだけの質問では `m365_agent_ask` に `expectFiles: false` を指定し、回答後に遅れて現れるファイルの待機を省けます。すでに表示されたファイルは引き続き保存します。
- **回答の完了判定と進捗表示を改善しました。** 生成中の表示が消えた時点から回答の安定を確認し直します。クライアントが進捗通知に対応している場合は、回答完了の確認と、遅れて現れるファイルの確認を表示します。
- **空白だけの質問と不要な引数を拒否します。** 空白・改行・タブだけの質問、および `m365_agent_session` の操作に関係のない引数は `INVALID_ARGUMENT` になります。質問内の空白は保持し、改行コードは LF にそろえます。
- **エージェント一覧の件数表示を改善しました。** 検索で絞り込んだ場合、全体の件数・表示中の件数・選択中の件数を分けて表示します。

会話の確認結果が `shown` なら質問が表示され、`differs` なら別の文面が表示されています。`not-shown` は未送信を確認できた状態です。`unconfirmed` は送信の有無を確認できず、`none` は確認対象の質問がありません。再送を検討できるのは `not-shown` の場合です。`unconfirmed` の場合は送り直さず、後で再度読むか Microsoft 365 の会話を確認してください。

回答は `reply: "complete"` / `"incomplete"` / `"none"` で区別します。失敗後の確認のために残した単発の会話は、読む操作で完了した回答を回収すると閉じます。残した会話も有効期限・会話数上限・ローカルプロセスの再起動の影響を受けるため、ハンドルを受け取ったら早めに確認してください。

### 更新方法

VS Code 拡張機能を使う場合は、`agent-pick-link-0.2.9.vsix` を **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続と、機械インストールで動いているローカルプロセスも、新しい版に更新・再起動してください。会話の確認を使うには、新しい MCP 接続とローカルプロセスの両方が必要です。古いローカルプロセスへの読む操作は `BROKER_VERSION_MISMATCH` になります。

ポータブル版は、お使いの OS・CPU 向けのアーカイブを展開し、`apl-setup <ワークスペース>` を実行します。既存の設定、ワークスペース承認、専用ブラウザープロファイルを引き続き利用できます。

新しい設定を手動で追加する必要はありません。`browser.composerStabilityMs` が未設定なら既定値を使用します。`expectFiles` を省略した場合は従来どおりファイルの出現を待ちます。詳しくは [設定ガイド](CONFIGURATION.md)、[トラブルシューティング](TROUBLESHOOTING.md) を参照してください。

### 配布物

- `agent-pick-link-0.2.9.vsix` — VS Code 拡張機能。
- `AgentPickLink-0.2.9-win-x64.zip` / `AgentPickLink-0.2.9-win-arm64.zip` — Windows 用ポータブル版。
- `AgentPickLink-0.2.9-darwin-arm64.tgz` / `AgentPickLink-0.2.9-darwin-x64.tgz` — macOS 用ポータブル版（開発・検証向け）。
- `AgentPickLink-0.2.9-linux-x64.tgz` — Linux 用アーカイブ（開発・CI 専用）。
- `agent-pick-link-0.2.9-source.zip` — ソースコード。
- `SHA256SUMS` — 配布ファイルの SHA-256 チェックサム。

ポータブル版には Node.js 24.21.0 を同梱します。

### 対応範囲

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向けです。Linux は開発・CI 専用で、標準の `serve` は `PLATFORM_UNSUPPORTED` を返します。対応環境に変更はありません。

v0.2.9 の変更について、Windows デスクトップ実機、実 Microsoft 365 テナント、実際の VS Code 画面での追加確認は行っていません。実際の AI クライアントの停止操作によるキャンセルと、最終配布物のすべての OS・CPU での実機動作も未確認です。利用する環境で質問・回答・会話の確認・ファイル取得を確認してください。[対応環境と検証範囲](RELEASE-CHECKLIST.md)、[導入手順](README.md) を参照してください。

PDF の案内は生成を依頼する AI クライアントへの助言です。生成物のフォント・レイアウト・ページ数の正しさを保証するものではなく、実ファイルの確認が必要です。

### English

- **Verify the question and recipient immediately before sending.** If the entered text, agent, conversation, or page address changes while waiting for the send button, the request returns `UI_CHANGED` or `AGENT_CONTEXT_CHANGED` with `not-sent`. If another operation may already have sent the question, no additional press is made and `SUBMIT_STATE_UNKNOWN` is returned.
- **Fixed premature submission of multiline questions.** Line breaks use Shift+Enter, including in editors where Enter sends the message.
- **Report uncertain submission accurately.** After a press, failure to confirm the question in the conversation returns `SUBMIT_STATE_UNKNOWN`. Failed questions include `submissionState` (`not-sent` / `unknown` / `sent`). Failures that may have sent the question are not marked retryable. A local connection lost during a question also reports `unknown`; questions are never resent automatically.
- **Read an existing conversation without resending.** When `SUBMIT_STATE_UNKNOWN` or `RESPONSE_TIMEOUT` carries `error.conversationHandle`, use `m365_agent_session` with `action: "read"` and that handle to inspect the question and collect its reply. The composer and send button are untouched; reply files are saved under the usual download settings.
- **Separate input verification from response waiting.** `browser.composerStabilityMs` defaults to 500 ms for input stability. Response stability retains its existing setting. Set `expectFiles: false` on a text-only `m365_agent_ask` to skip waiting for files that appear after the reply; files already displayed are still saved.
- **Improve completion checks and progress.** Response stability is checked again after generation indicators disappear. Clients supporting progress notifications can show confirmation of response completion and checks for files arriving after the reply.
- **Reject whitespace-only questions and irrelevant session fields.** Spaces, line breaks, or tabs alone, and fields unrelated to a session action, return `INVALID_ARGUMENT`. Whitespace within a question is preserved; line endings use LF.
- **Clarify agent counts.** Filtered lists display total, visible, and selected counts separately.

Reading reports `message: shown` when the question is displayed, `differs` for different text, `not-shown` when non-submission is confirmed, `unconfirmed` when submission cannot be determined, and `none` when no question is available to check. Only consider resending after `not-shown`; after `unconfirmed`, read again later or inspect the Microsoft 365 conversation. Replies are `complete`, `incomplete`, or `none`. A one-shot conversation retained after a failed ask closes when reading collects its complete reply. Retained handles remain subject to expiry, conversation limits, and local process restarts; read them promptly.

Install `agent-pick-link-0.2.9.vsix`, reload VS Code, and update and restart external clients' MCP connections and local processes used by machine installations. Reading requires both a new MCP connection and a new local process; older local processes return `BROKER_VERSION_MISMATCH`. For portable installations, extract the archive for your OS and CPU and run `apl-setup <workspace>`. Existing settings, workspace approvals, and the dedicated browser profile can be reused. No manual configuration addition is required: an absent `browser.composerStabilityMs` uses its default, and omitting `expectFiles` retains the existing file wait. See [Configuration](CONFIGURATION.md) and [Troubleshooting](TROUBLESHOOTING.md).

Downloads include the VSIX, Windows x64 / ARM64 and macOS Apple Silicon / Intel portable archives, a development/CI-only Linux x64 archive, source code, and `SHA256SUMS`. Portable archives bundle Node.js 24.21.0.

Support remains unchanged: Windows 11 with Microsoft Edge is the primary target; macOS is for development and verification, and Linux is for development/CI only. Standard Linux `serve` returns `PLATFORM_UNSUPPORTED`. Additional Windows desktop, live Microsoft 365 tenant, and actual VS Code interface checks have not been performed for v0.2.9. Cancellation through actual AI clients' stop controls and native execution of the final distribution on every OS/CPU remain unverified. Verify questions, answers, conversation reads, and file retrieval in your environment. See [Supported environments and validation scope](RELEASE-CHECKLIST.md) and the [English README](README.en.md). PDF guidance does not guarantee fonts, layout, or page counts; inspect the actual files.

## v0.2.8 Beta

### 主な変更

- **送信ボタンが一時的に押せない間のキャンセルを修正しました。** ボタンがほかの表示に覆われている、動いている、または一時的に無効になっている間にキャンセルすると、その後ボタンが押せる状態に戻った時点で質問が送信されることがありました。待機中のキャンセルは送信せず、未送信（`not-sent`）を返します。10 秒以内にボタンを押せることを確認できない場合も、送信せず `UI_CHANGED` と未送信を返します。
- **改行しない空白（NBSP、U+00A0）の入力を修正しました。** NBSP を保持する入力欄では、そのまま入力・確認します。NBSP が通常の空白に変換された場合は、変更された質問を送らず、理由と対処を示します。通常の空白がブラウザーの表示上 NBSP になる場合は受け付けます。
- **添付が保存されなかった理由を統一しました。** 回答のリンク・ファイルカード・ダウンロードボタンのいずれでも、同じ失敗に同じ `errorCode` と `stage` を返します。許可されていない取得元は `host-not-allowed / source-host-not-allowed` として報告します。通信エラー、空の応答、サイズ超過、保存失敗も段階を確認できます。
- **保存されていない添付の読み出しを修正しました。** MCP の添付リソースが見つからない場合は、リソース未検出として返します。
- **絵文字を含む質問の文字数判定を修正しました。** 公開スキーマと同じ Unicode コードポイント数で、MCP とローカル接続の両方が上限 12,000 文字を確認します。上限内の質問が絵文字を含むために拒否される不具合を修正しました。

送信操作の最中にキャンセルした場合は、ページに届く前に押下を止められたことを確認できれば未送信を返します。送信された可能性を否定できない場合は `SUBMIT_STATE_UNKNOWN` を返し、自動再送しません。キャンセルは Microsoft 365 に送信済みの質問や生成処理を取り消すものではありません。キャンセル前に保存済みのファイルはディスクに残ります。クライアントがキャンセル通知を送らず待機だけをやめた場合は、処理が続くことがあります。

### 更新方法

VS Code 拡張機能を使う場合は、`agent-pick-link-0.2.8.vsix` を **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続と、機械インストールで動いているローカルプロセスも、新しい版に更新・再起動してください。

ポータブル版は、お使いの OS・CPU 向けのアーカイブを展開し、`apl-setup <ワークスペース>` を実行します。既存の設定、ワークスペース承認、専用ブラウザープロファイルを引き続き利用できます。

新しい設定項目の追加は不要です。NBSP を通常の空白に変える入力欄では、必要に応じて質問内の NBSP を通常の空白に置き換えてください。送信結果が不明な場合は、Microsoft 365 の会話を確認してから再送を判断してください。詳しくは [設定ガイド](CONFIGURATION.md)、[トラブルシューティング](TROUBLESHOOTING.md) を参照してください。

### 配布物

- `agent-pick-link-0.2.8.vsix` — VS Code 拡張機能。
- `AgentPickLink-0.2.8-win-x64.zip` / `AgentPickLink-0.2.8-win-arm64.zip` — Windows 用ポータブル版。
- `AgentPickLink-0.2.8-darwin-arm64.tgz` / `AgentPickLink-0.2.8-darwin-x64.tgz` — macOS 用ポータブル版（開発・検証向け）。
- `AgentPickLink-0.2.8-linux-x64.tgz` — Linux 用アーカイブ（開発・CI 専用）。
- `agent-pick-link-0.2.8-source.zip` — ソースコード。
- `SHA256SUMS` — 配布ファイルの SHA-256 チェックサム。

ポータブル版には Node.js 24.21.0 を同梱します。

### 対応範囲

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向けです。Linux は開発・CI 専用で、標準の `serve` は `PLATFORM_UNSUPPORTED` を返します。対応環境に変更はありません。

v0.2.8 の変更について、Windows デスクトップ実機、実 Microsoft 365 テナント、実際の VS Code 画面での追加確認は行っていません。実際の AI クライアントの停止操作によるキャンセルと、最終配布物のすべての OS・CPU での実機動作も未確認です。利用する環境で質問・回答・ファイル取得を確認してください。[対応環境と検証範囲](RELEASE-CHECKLIST.md)、[導入手順](README.md) を参照してください。

PDF の案内は生成を依頼する AI クライアントへの助言です。生成物のフォント・レイアウト・ページ数の正しさを保証するものではなく、実ファイルの確認が必要です。

### English

- **Fixed cancellation while the send button cannot be clicked.** Cancelling while the button was covered, moving, or temporarily disabled could still submit the question once it became clickable. Cancellation during that wait now returns `not-sent` without submitting. If the button cannot be confirmed clickable within 10 seconds, the request returns `UI_CHANGED` with `not-sent`.
- **Fixed entry of no-break spaces (NBSP, U+00A0).** Editors that preserve NBSP accept and verify it as entered. If an editor converts NBSP to an ordinary space, the changed question is not submitted and the reason and remedy are reported. Ordinary spaces represented as NBSP by the browser are accepted.
- **Made unsaved-attachment reasons consistent.** Response links, file cards, and download buttons return the same `errorCode` and `stage` for the same failure. A disallowed source reports `host-not-allowed / source-host-not-allowed`. Connection failures, empty responses, size limits, and write failures also report their stage.
- **Fixed reading missing attachment resources.** An unavailable MCP attachment resource returns a resource-not-found error.
- **Fixed question-length checks for emoji.** Both MCP and the local connection use Unicode code points, matching the published schema's 12,000-character limit. Questions within the limit are no longer rejected because they contain emoji.

If cancellation arrives during the click, `not-sent` is returned when the press is confirmed to have been blocked before reaching the page. If submission cannot be ruled out, the request returns `SUBMIT_STATE_UNKNOWN` and is not resent automatically. Cancellation does not retract questions already sent to Microsoft 365 or stop generation there. Saved files remain on disk. Processing may continue if a client stops waiting without sending a cancellation notification.

To update, install `agent-pick-link-0.2.8.vsix`, reload VS Code, and update and restart external clients' MCP connections and local processes used by machine installations. For portable installations, extract the archive for your OS and CPU and run `apl-setup <workspace>`. Existing settings, workspace approvals, and the dedicated browser profile can be reused. No new configuration setting is required. If an editor converts NBSP, replace it with an ordinary space where appropriate. Inspect the existing Microsoft 365 conversation before deciding to resend after an uncertain submission. See [Configuration](CONFIGURATION.md) and [Troubleshooting](TROUBLESHOOTING.md).

Downloads include the VSIX, Windows x64 / ARM64 and macOS Apple Silicon / Intel portable archives, a development/CI-only Linux x64 archive, source code, and `SHA256SUMS`. Portable archives bundle Node.js 24.21.0.

Support remains unchanged: Windows 11 with Microsoft Edge is the primary target; macOS is for development and verification, and Linux is for development/CI only. Standard Linux `serve` returns `PLATFORM_UNSUPPORTED`.

Additional Windows desktop, live Microsoft 365 tenant, and actual VS Code interface checks have not been performed for the v0.2.8 changes. Cancellation through actual AI clients' stop controls and native execution of the final distribution on every OS/CPU remain unverified. Verify questions, answers, and file retrieval in your deployment environment. See [Supported environments and validation scope](RELEASE-CHECKLIST.md) and the [English README](README.en.md).

PDF guidance advises the AI client requesting generation; it does not guarantee fonts, layout, or page counts. Inspect the actual files.

## v0.2.7 Beta

### 主な変更

- **複数行の質問の入力確認を修正しました。** 段落・改行・空行・コードの字下げを含む入力を確認します。全角文字、丸数字、ゼロ幅文字、前後の空白などが変更されていれば一致扱いにせず、確認できない質問は送信しません。改行コードの CRLF / CR は LF として比較します。
- **送信前のキャンセルを改善しました。** 入力中、入力内容の確認待ち、送信ボタン待ちでもキャンセルを受け取り、入力を止めて下書きを消去します。送信前のキャンセルは未送信（`not-sent`）を返します。
- **保存されなかった添付の理由を確認できます。** 保存件数上限を超えたファイルも、`not-saved` と `attachment-count-limit` を含む結果として返します。許可されていないホストへの転送は `host-not-allowed / redirect-host-not-allowed` として報告します。
- **添付取得全体に待機上限を追加しました。** 複数ファイルや再試行を含む添付取得全体に `browser.attachmentPhaseTimeoutMs`（既定 45 秒）を適用します。期限を超えた未取得分は `attachment-phase-timeout` として返し、保存済みのファイルは保持します。
- **長いファイル名の保存を修正しました。** 長い日本語・絵文字の名前は、文字の途中で分割せず保存できる長さに短縮します。拡張子と、同名の別ファイルを区別する接尾辞を保持します。
- **MCP の不正引数を構造化されたエラーで返します。** 不正な型、必須項目の欠落、未知の項目は `requestId` を含む `INVALID_ARGUMENT` として返します。

キャンセルは AgentPickLink 側の処理を終了するもので、Microsoft 365 に送信済みの質問や生成処理を取り消すものではありません。キャンセル前に保存済みのファイルはディスクに残ります。クライアントがキャンセル通知を送らず待機だけをやめた場合は、処理が続くことがあります。

### 更新方法

VS Code 拡張機能を使う場合は、`agent-pick-link-0.2.7.vsix` を **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続と、機械インストールで動いているローカルプロセスも、新しい版に更新・再起動してください。

ポータブル版は、お使いの OS・CPU 向けのアーカイブを展開し、`apl-setup <ワークスペース>` を実行します。既存の設定、ワークスペース承認、専用ブラウザープロファイルを引き続き利用できます。

`browser.attachmentPhaseTimeoutMs` は既存設定に項目がなくても既定の 45 秒で有効になります。大きなファイルや遅い接続で期限に達する場合は、設定を調整してください。回答待ち時間とは別の設定です。詳しくは [設定ガイド](CONFIGURATION.md)、[トラブルシューティング](TROUBLESHOOTING.md) を参照してください。

### 配布物

- `agent-pick-link-0.2.7.vsix` — VS Code 拡張機能。
- `AgentPickLink-0.2.7-win-x64.zip` / `AgentPickLink-0.2.7-win-arm64.zip` — Windows 用ポータブル版。
- `AgentPickLink-0.2.7-darwin-arm64.tgz` / `AgentPickLink-0.2.7-darwin-x64.tgz` — macOS 用ポータブル版（開発・検証向け）。
- `AgentPickLink-0.2.7-linux-x64.tgz` — Linux 用アーカイブ（開発・CI 専用）。
- `agent-pick-link-0.2.7-source.zip` — ソースコード。
- `SHA256SUMS` — 配布ファイルの SHA-256 チェックサム。

ポータブル版には Node.js 24.21.0 を同梱します。

### 対応範囲

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向けです。Linux は開発・CI 専用で、標準の `serve` は `PLATFORM_UNSUPPORTED` を返します。対応環境に変更はありません。

v0.2.7 の変更について、Windows デスクトップ実機、実 Microsoft 365 テナント、実際の VS Code 画面での追加確認は行っていません。実際の AI クライアントの停止操作によるキャンセルと、最終配布物のすべての OS・CPU での実機動作も未確認です。利用する環境で質問・回答・ファイル取得を確認してください。[対応環境と検証範囲](RELEASE-CHECKLIST.md)、[導入手順](README.md) を参照してください。

PDF の案内は生成を依頼する AI クライアントへの助言です。生成物のフォント・レイアウト・ページ数の正しさを保証するものではなく、実ファイルの確認が必要です。

### English

- **Fixed verification of multiline question entry.** Paragraphs, line breaks, blank lines, and code indentation are checked. Changes to full-width characters, circled numbers, zero-width characters, or leading/trailing whitespace are rejected. Questions that cannot be verified are not submitted. CRLF / CR line endings are compared as LF.
- **Improved cancellation before submission.** Cancellation reaches typing, text-verification waits, and send-button waits. Input stops and the draft is cleared. Cancellation before submission returns `not-sent`.
- **Unsaved attachments include a reason.** Files beyond the saving limit are also returned as `not-saved` with `attachment-count-limit`. Redirects to disallowed hosts report `host-not-allowed / redirect-host-not-allowed`.
- **Added an overall attachment-retrieval deadline.** `browser.attachmentPhaseTimeoutMs` (default 45 seconds) covers multiple files and retries. Files still pending when it expires return `attachment-phase-timeout`; already saved files are retained.
- **Fixed saving long filenames.** Long Japanese and emoji filenames are shortened without splitting characters, while preserving extensions and suffixes that distinguish files with the same name.
- **Invalid MCP arguments return structured errors.** Invalid types, missing required fields, and unknown fields return `INVALID_ARGUMENT` with a `requestId`.

Cancellation ends AgentPickLink's local processing; it does not retract questions already sent to Microsoft 365 or stop generation there. Files saved before cancellation remain on disk. If a client stops waiting without sending a cancellation notification, processing may continue.

To update, install `agent-pick-link-0.2.7.vsix`, reload VS Code, and update and restart external clients' MCP connections and local processes used by machine installations. For portable installations, extract the archive for your OS and CPU and run `apl-setup <workspace>`. Existing settings, workspace approvals, and the dedicated browser profile can be reused.

The new `browser.attachmentPhaseTimeoutMs` default of 45 seconds applies even when the setting is absent from existing configurations. Adjust it if large files or slow connections reach the deadline. It is separate from the response-wait timeout. See [Configuration](CONFIGURATION.md) and [Troubleshooting](TROUBLESHOOTING.md).

Downloads include the VSIX, Windows x64 / ARM64 and macOS Apple Silicon / Intel portable archives, a development/CI-only Linux x64 archive, source code, and `SHA256SUMS`. Portable archives bundle Node.js 24.21.0.

Support remains unchanged: Windows 11 with Microsoft Edge is the primary target; macOS is for development and verification, and Linux is for development/CI only. Standard Linux `serve` returns `PLATFORM_UNSUPPORTED`.

Additional Windows desktop, live Microsoft 365 tenant, and actual VS Code interface checks have not been performed for the v0.2.7 changes. Cancellation through actual AI clients' stop controls and native execution of the final distribution on every OS/CPU remain unverified. Verify questions, answers, and file retrieval in your deployment environment. See [Supported environments and validation scope](RELEASE-CHECKLIST.md) and the [English README](README.en.md).

PDF guidance is advice to the calling AI client. It does not guarantee correct fonts, layout, or page counts; inspect the actual file.

## v0.2.6 Beta

### 主な変更

- **VS Code 拡張機能の起動不具合を修正しました。** v0.2.5 で `Cannot find module './impl/format'` が発生し、拡張機能が読み込めない問題を解消しました。
- **質問の入力を改善しました。** 文字ごとの待ち時間の既定値を短縮し、長文の入力には質問の長さに応じた時間上限を設けました。入力内容が一致・安定しない場合は低速で一度入力し直します。確認できない場合や入力が時間切れになった場合は、送信せず `UI_CHANGED` と未送信（`not-sent`）を返します。
- **添付保存の余分な再試行を減らしました。** 認証が必要な応答やサインイン画面では、専用ブラウザー内で接続状態を確認して取得を一度再試行します。SharePoint 共有リンクのプレビュー画面でも、ファイルの取得先を解決するためにこの処理を使います。容量超過、404 / 5xx、許可されていない転送先など、認証を再試行しても解決しない失敗は未保存として返します。
- **PDF 生成時の案内を改善しました。** 呼び出し元の AI クライアントに、日本語フォントの実データの埋め込み、見出し・本文に合った行間、表紙・結論を含む指定総ページ数、実ファイルのページ数と表示の確認を促します。

PDF の案内は生成を依頼する AI クライアントへの助言です。AgentPickLink は、利用者の質問や生成元のエージェントの指示、受信したファイルを自動で書き換えません。案内を追加するだけで、生成物のフォント・レイアウト・ページ数の正しさを保証するものではありません。実ファイルを確認してください。

### 更新方法

VS Code 拡張機能を使う場合は、`agent-pick-link-0.2.6.vsix` を **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続と、機械インストールで動いているローカルプロセスも、新しい版に更新・再起動してください。

ポータブル版は、お使いの OS・CPU 向けのアーカイブを展開し、`apl-setup <ワークスペース>` を実行します。既存の設定、ワークスペース承認、専用ブラウザープロファイルを引き続き利用できます。

`browser.typingDelayMs` の既定値は `0` です。既存の設定に保存された正の値は更新時にも保持します。新しい入力速度を使うには `config.yaml` の値を `0` に変更し、接続プロセスを再起動してください。`0` では最初の入力を待ち時間なしで行い、入力内容の確認に失敗した場合だけ 20 ミリ秒で一度入力し直します。詳しくは [設定ガイド](CONFIGURATION.md)、[トラブルシューティング](TROUBLESHOOTING.md) を参照してください。

### 配布物

- `agent-pick-link-0.2.6.vsix` — VS Code 拡張機能。
- `AgentPickLink-0.2.6-win-x64.zip` / `AgentPickLink-0.2.6-win-arm64.zip` — Windows 用ポータブル版。
- `AgentPickLink-0.2.6-darwin-arm64.tgz` / `AgentPickLink-0.2.6-darwin-x64.tgz` — macOS 用ポータブル版（開発・検証向け）。
- `AgentPickLink-0.2.6-linux-x64.tgz` — Linux 用アーカイブ（開発・CI 専用）。
- `agent-pick-link-0.2.6-source.zip` — ソースコード。
- `SHA256SUMS` — 配布ファイルの SHA-256 チェックサム。

ポータブル版には Node.js 24.21.0 を同梱します。

### 対応範囲

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向けです。Linux は開発・CI 専用で、標準の `serve` は `PLATFORM_UNSUPPORTED` を返します。対応環境に変更はありません。

今回の修正は公開前の修正版を使って Windows 上の VS Code 起動、質問入力、実 Microsoft 365 テナントでの PDF 生成・取得を限定的に確認しました。この確認は、すべてのエージェント・テナント・画面構成の動作保証ではありません。最終配布物のすべての OS・CPU での実機動作や、実際の AI クライアントの停止操作によるキャンセルは未確認です。[対応環境と検証範囲](RELEASE-CHECKLIST.md)、[導入手順](README.md) を参照してください。

### English

- **Fixed the VS Code extension failing to load.** v0.2.5 could fail with `Cannot find module './impl/format'`.
- **Improved question entry.** The default per-character delay is shorter, and long prompts use a length-based typing time limit. If the entered text fails exact-match and stability checks, it retries once with slower typing. Failed verification or a typing timeout returns `UI_CHANGED` with `not-sent`, without submitting the question.
- **Reduced unnecessary attachment retries.** Authentication failures and detected sign-in pages receive one retry after checking the session in the dedicated browser. SharePoint sharing viewers also use this step to resolve the actual file URL. Failures such as size limits, 404 / 5xx responses, or disallowed redirects are reported as not saved without an authentication retry.
- **Improved PDF generation guidance.** Calling AI clients are advised to embed actual Japanese font data, use suitable line spacing, respect the requested total page count including covers and conclusions, and inspect the actual file's page count and rendering.

This guidance does not automatically rewrite user questions, agent instructions, or received files, and does not guarantee correct fonts, layout, or page counts. Check the actual output.

To update, install `agent-pick-link-0.2.6.vsix`, reload VS Code, and update and restart external clients' MCP connections and local processes used by machine installations. For portable installations, extract the archive for your OS and CPU and run `apl-setup <workspace>`. Existing settings, workspace approvals, and the dedicated browser profile can be reused.

`browser.typingDelayMs` defaults to `0`. Existing positive values are preserved on upgrade. To use faster entry, set the value to `0` in `config.yaml` and restart the local process. Zero starts without a per-character delay and retries once at 20 ms only when text verification fails. See [Configuration](CONFIGURATION.md).

Portable archives bundle Node.js 24.21.0. Windows 11 with Microsoft Edge remains the primary target; macOS is for development and verification, and Linux is for development/CI only. Standard Linux `serve` returns `PLATFORM_UNSUPPORTED`.

The fixes received limited checks on a pre-publication patched build for Windows VS Code startup, question entry, and PDF generation and retrieval in a live Microsoft 365 tenant. This does not establish compatibility with every agent, tenant, or interface. Native execution of the final distribution across every OS/CPU and cancellation through actual AI clients' stop controls remain unverified. See [Supported environments and validation scope](RELEASE-CHECKLIST.md).

## v0.2.5 Beta

### 主な変更

- **添付ファイルの保存で待ち続ける問題を修正しました。** ダウンロード操作やファイルカードが応答しない場合、またはダウンロードが完了しない場合に、待機を打ち切ります。完了しないダウンロードは取り消し、そのファイルは未保存（`not-saved`）として理由を返します。許可されていない保存元からのダウンロードは、開始した時点で拒否します。
- **依頼のキャンセルがローカルの処理にも伝わります。** MCP クライアントからのキャンセルを受け取ると、回答待ちや添付ファイルの保存を終了し、保存中のダウンロードも取り消します。待ち行列にある依頼は送信しません。クライアントとのローカル接続が切れた場合も、その接続からの依頼を取り消します。

ファイル保存の各操作には `browser.navigationTimeoutMs`（既定 45 秒）の待機上限を適用します。ダウンロード開始待ちは最大 30 秒です。これらは回答全体の制限時間ではなく、複数の操作やファイルの処理では合計時間が長くなる場合があります。上限を超えるダウンロードは未保存になります。理由の確認方法は [トラブルシューティング](TROUBLESHOOTING.md) を参照してください。

キャンセルは AgentPickLink 側の処理を終了するもので、Microsoft 365 に送信済みの質問や生成処理を取り消すものではありません。キャンセル前に保存済みのファイルはディスクに残ります。

### 更新方法

VS Code 拡張機能を使う場合は、`agent-pick-link-0.2.5.vsix` を **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続も再起動してください。キャンセル伝達を利用するには、接続先のローカルプロセスも新しい版で起動している必要があります。

ポータブル版は、お使いの OS・CPU 向けのアーカイブを展開し、`apl-setup <ワークスペース>` を実行します。既存の設定、ワークスペース承認、専用ブラウザープロファイルを引き続き利用できます。

### 配布物

- `agent-pick-link-0.2.5.vsix` — VS Code 拡張機能。
- `AgentPickLink-0.2.5-win-x64.zip` / `AgentPickLink-0.2.5-win-arm64.zip` — Windows 用ポータブル版。
- `AgentPickLink-0.2.5-darwin-arm64.tgz` / `AgentPickLink-0.2.5-darwin-x64.tgz` — macOS 用ポータブル版（開発・検証向け）。
- `AgentPickLink-0.2.5-linux-x64.tgz` — Linux 用アーカイブ（開発・CI 専用）。
- `agent-pick-link-0.2.5-source.zip` — ソースコード。
- `SHA256SUMS` — 配布ファイルの SHA-256 チェックサム。

ポータブル版には Node.js 24.21.0 を同梱します。

### 対応範囲

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向けです。Linux は開発・CI 専用で、標準の `serve` は `PLATFORM_UNSUPPORTED` を返します。対応環境に変更はありません。

この版では Windows デスクトップ実機、実 Microsoft 365 テナント、実際の VS Code 画面での追加確認は行っていません。実際の AI クライアントの停止操作からキャンセルが伝わることも未確認です。セットアップの保存完了や `doctor` の正常判定は、実際の回答・生成ファイル取得を保証するものではありません。[対応環境と検証範囲](RELEASE-CHECKLIST.md)、[導入手順](README.md) を参照してください。

### English

- **Fixed indefinite waits while saving attachments.** Waiting now stops when a download control or file card does not respond, or a download does not finish. An unfinished download is cancelled and the file is reported as `not-saved` with a reason. Downloads from disallowed sources are rejected as soon as they start.
- **Request cancellation now reaches local processing.** When AgentPickLink receives a cancellation from an MCP client, it ends response waiting and attachment saving, including cancelling the download being saved. Requests still queued are not submitted. Closing the local client connection also cancels requests from that connection.

Individual file-saving operations use `browser.navigationTimeoutMs` (default 45 seconds); waiting for a download to start is capped at 30 seconds. These are not a deadline for the entire answer: multiple operations or files can take longer in total. Downloads that exceed the limit are not saved. See [Troubleshooting](TROUBLESHOOTING.md) for failure reasons.

Cancellation ends AgentPickLink's local processing; it does not retract questions already sent to Microsoft 365 or stop generation there. Files saved before cancellation remain on disk.

To update, install `agent-pick-link-0.2.5.vsix`, reload VS Code, and restart external clients' MCP connections. The local process handling requests must also run the new version for cancellation forwarding to work. For portable installations, extract the archive for your OS and CPU and run `apl-setup <workspace>`. Existing settings, workspace approvals and the dedicated browser profile can be reused.

Downloads include the VSIX, Windows x64 / ARM64 and macOS Apple Silicon / Intel portable archives, a development/CI-only Linux x64 archive, source code and `SHA256SUMS`. Portable archives bundle Node.js 24.21.0.

Support remains unchanged: Windows 11 with Edge is the primary target; macOS is for development and verification. Linux is for development/CI only. Additional Windows desktop, live-tenant and actual VS Code interface checks have not been performed for this version. Cancellation through actual AI clients' stop controls has not been verified either. Setup completion and a healthy doctor result do not verify live answers or generated files. See the [English README](README.en.md) and [validation scope](RELEASE-CHECKLIST.md).

## v0.2.4 Beta

### 主な変更

- **診断がエラー表示後に終了しない問題を修正しました。** `doctor --auth` / `--agent` でブラウザーを起動できない場合や接続エラーが起きた場合に、エラー表示後もコマンドが終了しないことがありました。接続を閉じ、失敗した検査は該当項目に理由を含む診断結果として返します（`ok: false`、終了コード `1`）。
- **壊れた連携設定があっても診断を続けます。** `doctor` は解析できないクライアント設定を `invalid` として報告し、他の検査を続けます。空の設定ファイルは設定なしとして扱います。`integrations status` でも解析できない設定を `invalid` と確認できます。
- **解析できない設定の削除を成功扱いしません。** `integrations remove` は該当ファイルを変更せず、`errors` の `invalid-configuration` と終了コード `1` で報告します。`--force` を付けても解析エラーは回避できません。`self uninstall` は削除できない連携設定を理由付きの `skippedIntegrations` に記録し、アンインストールを続行します。

スクリプトから `doctor` を使う場合、接続・認証・エージェント検査の失敗は通常の診断結果と終了コード `1` で判定してください。終了コード `2` は診断結果自体を作れない場合です。解析できない連携設定は構文を修正してから削除を再実行してください。

### 更新方法

VS Code 拡張機能を使う場合は、`agent-pick-link-0.2.4.vsix` を **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続も再起動してください。

ポータブル版は、お使いの OS・CPU 向けのアーカイブを展開し、`apl-setup <ワークスペース>` を実行します。既存の設定、ワークスペース承認、専用ブラウザープロファイルを引き続き利用できます。

### 配布物

- `agent-pick-link-0.2.4.vsix` — VS Code 拡張機能。
- `AgentPickLink-0.2.4-win-x64.zip` / `AgentPickLink-0.2.4-win-arm64.zip` — Windows 用ポータブル版。
- `AgentPickLink-0.2.4-darwin-arm64.tgz` / `AgentPickLink-0.2.4-darwin-x64.tgz` — macOS 用ポータブル版（開発・検証向け）。
- `AgentPickLink-0.2.4-linux-x64.tgz` — Linux 用アーカイブ（開発・CI 専用）。
- `agent-pick-link-0.2.4-source.zip` — ソースコード。
- `SHA256SUMS` — 配布ファイルの SHA-256 チェックサム。

ポータブル版には Node.js 24.21.0 を同梱します。

### 対応範囲

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向けです。Linux は開発・CI 専用で、標準の `serve` は `PLATFORM_UNSUPPORTED` を返します。対応環境に変更はありません。

この版では Windows デスクトップ実機、実 Microsoft 365 テナント、実際の VS Code 画面での追加確認は行っていません。セットアップの保存完了や `doctor` の正常判定は、実際の回答・生成ファイル取得を保証するものではありません。[対応環境と検証範囲](RELEASE-CHECKLIST.md)、[導入手順](README.md) を参照してください。

### English

- **Fixed diagnostics staying open after an error.** `doctor --auth` / `--agent` could remain running after a browser startup failure or a connection error. The connection is now closed, and failed checks return a normal diagnostic result with the reason in the affected item (`ok: false`, exit `1`).
- **Malformed client settings no longer stop the whole diagnosis.** `doctor` reports an unparseable client configuration as `invalid` and continues other checks. Blank files count as no configuration. `integrations status` also reports unparseable settings as `invalid`.
- **Removing unparseable settings is no longer reported as success.** `integrations remove` leaves the file unchanged and reports `invalid-configuration` in `errors` with exit `1`. `--force` does not bypass parsing errors. `self uninstall` records settings it could not remove in `skippedIntegrations`, with a reason, and continues uninstalling.

Scripts calling `doctor` should handle connection, authentication and agent-check failures through the normal diagnostic report and exit `1`. Exit `2` is reserved for failures that prevent creating the report itself. Fix malformed client configuration syntax before retrying removal.

To update, install `agent-pick-link-0.2.4.vsix`, reload VS Code, and restart external clients' MCP connections. For portable installations, extract the archive for your OS and CPU and run `apl-setup <workspace>`. Existing settings, workspace approvals and the dedicated browser profile can be reused.

Downloads include the VSIX, Windows x64 / ARM64 and macOS Apple Silicon / Intel portable archives, a development/CI-only Linux x64 archive, source code and `SHA256SUMS`. Portable archives bundle Node.js 24.21.0.

Support remains unchanged: Windows 11 with Edge is the primary target; macOS is for development and verification. Linux is for development/CI only. Additional Windows desktop, live-tenant and actual VS Code interface checks have not been performed for this version. Setup completion and a healthy doctor result do not verify live answers or generated files. See the [English README](README.en.md) and [validation scope](RELEASE-CHECKLIST.md).

## v0.2.3 Beta

### 主な変更

- **回答中のコードや記号が欠落する問題を修正しました。** Markdown への変換時に、`Array<string>`、`a < b && c > d`、コード例中の `<script>` などが欠落する問題を修正しました。見出し・表・リスト・引用内の文字列も対象です。入れ子のリスト、表の列揃え、コードブロックの言語名の変換も改善しました。
- **連携設定の書き込み失敗を成功扱いしません。** `integrations write` / `remove` は `ok` と `errors`（クライアント・ファイル・理由コード・メッセージ）を返し、要求したクライアントの設定を書き込み・削除できなかった場合は終了コード `1` です。`install` も、選択したクライアントの書き込みに失敗した場合は `clientErrors` を報告し、終了コード `3` になります。セットアップ画面の完了条件も同じ判定を使います。壊れた設定や他のツールが作成した項目は、これまでどおり上書きしません。
- **使い方のヒントを空欄にして保存できます。** セットアップ画面でヒントを消して保存すると、登録情報からも削除されます。編集していないヒントは従来どおり保持します。
- **ダウンロードを許可するホストの入力を検証します。** 使えない値は理由とともに入力欄の下に表示し、修正するまで保存しません。実際に保存されるホストも表示します。

スクリプトから `integrations write` / `remove` を使う場合、書き込みや削除の失敗は `skipped` ではなく `errors` に入ります。終了コードまたは `ok` で判定してください。

### 更新方法

VS Code 拡張機能を使う場合は、`agent-pick-link-0.2.3.vsix` を **拡張機能: VSIX からのインストール…** でインストールし、VS Code を再読み込みしてください。外部 AI クライアントの MCP 接続も再起動してください。

ポータブル版は、お使いの OS・CPU 向けのアーカイブを展開し、`apl-setup <ワークスペース>` を実行します。既存の設定、ワークスペース承認、専用ブラウザープロファイルを引き続き利用できます。

### 配布物

- `agent-pick-link-0.2.3.vsix` — VS Code 拡張機能。
- `AgentPickLink-0.2.3-win-x64.zip` / `AgentPickLink-0.2.3-win-arm64.zip` — Windows 用ポータブル版。
- `AgentPickLink-0.2.3-darwin-arm64.tgz` / `AgentPickLink-0.2.3-darwin-x64.tgz` — macOS 用ポータブル版（開発・検証向け）。
- `AgentPickLink-0.2.3-linux-x64.tgz` — Linux 用アーカイブ（開発・CI 専用）。
- `agent-pick-link-0.2.3-source.zip` — ソースコード。
- `SHA256SUMS` — 配布ファイルの SHA-256 チェックサム。

ポータブル版には Node.js 24.21.0 を同梱します。

### 対応範囲

Windows 11 と Microsoft Edge を主な対象とするベータ版です。macOS は開発・検証向けです。Linux は開発・CI 専用で、標準の `serve` は `PLATFORM_UNSUPPORTED` を返します。対応環境に変更はありません。

この版では Windows デスクトップ実機、実 Microsoft 365 テナント、実際の VS Code 画面での追加確認は行っていません。回答の変換は Microsoft 365 の画面構造に合わせた試験用の回答で確認しており、実際の回答での確認は行っていません。セットアップの保存完了や `doctor` の正常判定は、実際の回答・生成ファイル取得を保証するものではありません。[対応環境と検証範囲](RELEASE-CHECKLIST.md)、[導入手順](README.md) を参照してください。

### English

- **Fixed missing code and symbols in answers.** Fixed Markdown conversion losing text such as `Array<string>`, `a < b && c > d`, and `<script>` in code examples, including text inside headings, tables, lists and quotes. Conversion of nested lists, table column alignment and code-block language labels has also been improved.
- **Failed client configuration writes are no longer reported as success.** `integrations write` / `remove` return `ok` and `errors` (client, file, reason code, message) and exit `1` when a requested client configuration could not be written or removed. `install` reports `clientErrors` and exits `3` when a selected client fails, and the setup panel's completion check uses the same verdict. Malformed settings and entries created by other tools are still never overwritten.
- **Usage hints can be cleared.** Clearing a hint in the setup panel and saving removes it from the registration; unedited hints are kept.
- **Download host input is validated.** Unusable entries are shown with their reason under the field and block saving until fixed; the hosts that will actually be saved are shown too.

Scripts that call `integrations write` / `remove` now find failed writes and removals in `errors`, not `skipped`; check the exit code or `ok`.

To update, install `agent-pick-link-0.2.3.vsix`, reload VS Code, and restart external clients' MCP connections. For portable installations, extract the archive for your OS and CPU and run `apl-setup <workspace>`. Existing settings, workspace approvals and the dedicated browser profile can be reused.

Downloads include the VSIX, Windows x64 / ARM64 and macOS Apple Silicon / Intel portable archives, a development/CI-only Linux x64 archive, source code and `SHA256SUMS`. Portable archives bundle Node.js 24.21.0.

Support remains unchanged: Windows 11 with Edge is the primary target; macOS is for development and verification. Linux is for development/CI only. Additional Windows desktop, live-tenant and actual VS Code interface checks have not been performed for this version. Answer conversion was verified with test answers modelled on the Microsoft 365 page structure, not with live answers. Setup completion and a healthy doctor result do not verify live answers or generated files. See the [English README](README.en.md) and [validation scope](RELEASE-CHECKLIST.md).

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
