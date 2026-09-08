<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/readme-header-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="media/readme-header-light.png">
  <img alt="AgentPickLink for M365" src="media/readme-header-dark.png" width="100%">
</picture>

# AgentPickLink for M365

[日本語](release-docs/README.md) | [English](README.en.md)

**v0.1.0 Beta** — VS Code から、利用を承認した Microsoft 365 エージェントへ質問するためのローカル MCP ブリッジです。

Microsoft 365 にサインインしてエージェントを選び、ワークスペース単位で利用を承認すると、MCP 対応の AI クライアントから質問できるようになります。回答テキストや引用に加え、エージェントが生成したファイルを保存できます。

AgentPickLink は **MIT ライセンスのオープンソースソフトウェア（OSS）** です。利用している第三者ソフトウェアには、それぞれのライセンスが適用されます。

本ソフトウェアは Microsoft の公式製品ではありません。ベータ版のため、Microsoft 365 の画面変更やテナントの設定によって接続・取得に失敗する場合があります。

## 利用環境

- ローカルの VS Code 1.101 以降と、単一フォルダのワークスペース。
- Windows 11 と Microsoft Edge を主な対象としています。macOS は開発・検証向けで、Edge または Google Chrome を使用します。
- 対象エージェントを利用できる Microsoft 365 の職場または学校アカウント。必要なライセンス・利用権限は別途用意してください。
- MCP に対応した AI クライアント。

Node.js 22 以降を別途インストールすると実行環境を明示できます。未導入の場合、拡張機能は VS Code 内蔵ランタイムの利用を試みます。ソースからビルドする場合は Node.js 22 以降と npm が必要です。

WSL、Remote SSH、Dev Containers、Codespaces、複数ルートのワークスペース、リモート MCP サーバー、無人実行は対象外です。すべての Microsoft 365 エージェントや画面構成への対応を保証するものではありません。

## インストール

1. GitHub の **Releases → v0.1.0 (Beta)** で `agent-pick-link-0.1.0.vsix` をダウンロードします。
2. VS Code のコマンドパレットから **Extensions: Install from VSIX… / 拡張機能: VSIX からのインストール…** を実行し、ダウンロードしたファイルを選びます。
3. 再読み込みを求められた場合は、VS Code を再読み込みします。

ターミナルからもインストールできます。

```sh
code --install-extension agent-pick-link-0.1.0.vsix
```

VSIX には拡張機能、CLI、ローカル接続プロセス、MCP サーバーを同梱しています。npm パッケージや Marketplace からのインストールは、このベータ版の配布手順には含みません。

## 最初のセットアップ

1. 利用するフォルダを VS Code で開き、内容を確認したうえでワークスペースを信頼します。
2. アクティビティバーの **AgentPickLink** を開き、**環境をセットアップする / Set up environment** を選びます。
3. サインイン画面が開いたら、職場または学校アカウントでサインインします。追加認証が必要な場合も、この専用ブラウザーで操作してください。
4. 一覧から、このワークスペースで利用するエージェントを選びます。
5. **クライアント・ファイル設定 / Client and file settings** で、必要なクライアント連携とファイル保存設定を選びます。
6. **承認して保存 / Approve and save** を押し、確認画面で利用対象を承認します。

VS Code の MCP 定義は拡張機能から提供されます。追加で有効にした連携は、対応するクライアント設定に反映されます。外部クライアントが変更を認識しない場合は、そのクライアントを再起動してください。

設定済みのワークスペースを再度開くと、保存したエージェントと接続状態を復元します。新しいエージェントを取得したい場合は **接続して更新 / Connect and refresh** を選びます。

## AI クライアントからの利用

クライアントで `m365-agents` の MCP ツールを有効にし、例えば「利用可能な Microsoft 365 エージェントを確認し、選んだエージェントにこの質問を送って」と依頼します。実際の呼び出し可否は、クライアント側のツール設定と承認にも従います。

| ツール               | 用途                                 |
| -------------------- | ------------------------------------ |
| `m365_agent_list`    | 利用対象と準備状態を確認する         |
| `m365_agent_ask`     | 承認したエージェントに質問する       |
| `m365_agent_session` | 継続する会話の作成・一覧・終了を行う |

単発の質問では、回答取得後に会話を自動的に閉じます。複数ターンの会話では、作成したセッションを指定して質問を続け、終了時に閉じます。回答やファイル生成には数分かかることがあります。送信結果が不明な場合は自動再送しません。

## 生成ファイル

ファイル保存は初期設定で有効です。許可されたダウンロード先は、標準では `*.sharepoint.com` と `onedrive.live.com` です。保存先は、開いているワークスペースの `APL_downloads/<workspace-key>/<request-id>/` です。

初期上限は 1 回の回答につき 10 ファイル、1 ファイル 25 MiB、合計 100 MiB です。保存したファイルを自動実行・変換することはありません。ファイルの正確さや安全性は、利用前に確認してください。保存先に機密情報が含まれる可能性があるため、Git への追加や外部同期に注意してください。

## データと承認

質問は選択した Microsoft 365 エージェントへ送信され、取得した回答は呼び出し元の AI クライアントへ返されます。組織の規程に従い、必要最小限の情報だけを送ってください。ワークスペースの設定ファイルだけでは利用許可にならず、この端末での明示的な承認が必要です。

サインインには専用ブラウザープロファイルを使用します。通常のブラウザープロファイルを指定しないでください。プロファイルや承認情報はローカルに保存されます。詳細は [セキュリティとデータの扱い](release-docs/SECURITY.md) を参照してください。

## ドキュメント・ソース

- [設定ガイド](release-docs/CONFIGURATION.md)
- [トラブルシューティング](release-docs/TROUBLESHOOTING.md)
- [開発者向けビルド・テスト手順](release-docs/DEVELOPMENT.md)
- [リリースノート](release-docs/CHANGELOG.md)
- [ライセンス: MIT](LICENSE)
- [利用 OSS・第三者ソフトウェア一覧](release-docs/OSS-LICENSES.md)
- [第三者ソフトウェアの著作権・ライセンス全文](release-docs/THIRD-PARTY-NOTICES.txt)

開発者向けには `agent-pick-link-0.1.0-source.zip` を配布します。依存関係は `package-lock.json` に固定しており、展開したソースのみでインストール・テスト・ビルドできます。
