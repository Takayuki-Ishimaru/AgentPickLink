# 開発者向けガイド

v0.1.1 Beta のソースを取得して、テストと VSIX ビルドを行う手順です。

## 準備

Node.js 22 以降と npm をインストールし、`agent-pick-link-0.1.1-source.zip` を展開します。以降のコマンドは、展開先の `package.json` があるフォルダで実行してください。

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run schemas:check
npm run package:vsix
```

生成物は `dist-vsix/agent-pick-link-0.1.1.vsix` です。`npm run package:vsix` は既存の `dist/` と `dist-vsix/` を削除してからビルドします。インストール手順は [README](README.md) を参照してください。

ビルドだけを行う場合は `npm run build`、開発中にテストを再実行する場合は `npm run test:watch` を使用します。

## テストの環境差

テストはローカルのモックと一時データを使用します。Microsoft 365 アカウント、実テナント、サインイン済みプロファイルは不要です。

ブラウザーを使用するテストには、インストール済みの Edge または Chrome が必要です。標準のインストール先以外を使用する場合は、環境変数 `M365_AGENT_TEST_BROWSER` に実行ファイルの絶対パスを指定してください。ブラウザーが見つからない場合、そのテストはスキップされます。

Windows のストレージ・権限テストは Windows でのみ実行されます。対話ウィンドウを開く一部のテストは、`CI` 環境変数が設定された環境ではスキップされます。テスト成功だけで、全 OS や実テナントの動作確認を代替することはできません。

## ソースの構成

| パス            | 内容                                                              |
| --------------- | ----------------------------------------------------------------- |
| `src/`          | VS Code 拡張機能、CLI、MCP サーバー、ローカル接続、ブラウザー操作 |
| `tests/`        | 単体・契約・結合テスト、ローカルモック、VS Code API モック        |
| `media/`        | パネルの JavaScript・CSS、配布用アイコンと画像                    |
| `schemas/`      | 設定ファイルの JSON Schema                                        |
| `examples/`     | 設定例                                                            |
| `scripts/`      | スキーマ生成、パッケージの動作確認                                |
| `release-docs/` | 利用者・開発者向けドキュメント                                    |

ルートには依存関係の定義とロックファイル、TypeScript・Vitest・ESLint・Prettier の設定、拡張機能のバンドル設定、README とライセンスを含みます。

## CLI とパッケージの確認

```sh
npm run build
node dist/cli/index.js --help
node dist/cli/index.js --version
```

拡張機能を介さず MCP クライアントに接続する場合は、`examples/mcp.json` の CLI パスをビルド先の絶対パスに置き換えて使用できます。Node.js の `node` コマンドがクライアントから利用できることを確認してください。

VSIX を ZIP として別のフォルダへ展開した後、その `extension/` ディレクトリに対して次を実行できます。

```sh
npm run smoke:package -- /absolute/path/to/extracted/extension
```

この確認は CLI、MCP 接続、ローカル接続プロセスの起動・停止を検証します。ブラウザーを起動せず、Microsoft 365 へ接続しません。

ソースを変更した場合は、関連テストと型チェック・lint を実行してください。設定スキーマを変更した場合は `npm run schemas:generate` で JSON Schema を更新します。書式の確認には `npm run format:check` を使用できます。

## 公開CIとリリース確認

`.github/workflows/ci.yml` は push / pull request / 手動実行で、Windows・macOS・Ubuntuの各ランナー上で次を実行します。Node.jsは22系です。

| 確認項目                                         | Windows | macOS    | Ubuntu |
| ------------------------------------------------ | ------- | -------- | ------ |
| 依存関係のクリーンインストール・型チェック・lint | 実行    | 実行     | 実行   |
| 単体・契約・結合・設定保全・添付回帰テスト       | 実行    | 実行     | 実行   |
| 実ブラウザー上の模擬UI・会話・ダウンロード       | Edge    | Chromium | Chrome |
| JSON Schemaと実装の同期                          | 実行    | 実行     | 実行   |
| VSIX作成・展開・同梱ファイル検証                 | 実行    | 実行     | 実行   |
| 展開したCLI・MCPの接続、brokerの起動・終了       | 実行    | 実行     | 実行   |

UbuntuはOSのサンドボックス設定に対応する公式Chromeを使用します（[Chromiumの説明](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)）。ブラウザーの存在とサンドボックス付き起動を先に確認し、未導入によるDOMテストのスキップを防ぎます。各OSの実行ログにOS・CPUアーキテクチャ・Node.js・ブラウザーバージョンを出力し、テスト結果をActionsのartifactに保存します。

これはOSごとの自動動作検証です。VS Code拡張機能ホストのテストはAPIモックを使用し、ブラウザーはローカルの模擬Microsoft 365画面を操作します。実際のVS Code画面、実M365テナント、MFA・条件付きアクセス・可視ウィンドウでの再ログインはこのCIでは確認しません。OS固有のテストは該当OSで実行し、対話ウィンドウを必要とするテストはCIでは対象外です。成功件数だけでなくスキップ件数も確認してください。ランナーのOSバージョンはGitHubの `*-latest` に従うため、すべてのOSバージョンやWindowsデスクトップ実機での確認を保証するものではありません。

ワークフローを公開リポジトリへ反映すると、Actions タブから結果を確認できます。実テナント検証は [リリース確認表](RELEASE-CHECKLIST.md) に別途記録してください。

Codex 設定の更新はTOMLパーサーで対象テーブルを特定し、更新前後の対象外設定を照合します。構文エラーや安全に扱えない inline / dotted 定義は保存せず報告します。変更時は同じディレクトリに `config.toml.agentpicklink-<ランダムID>.bak` を作成し、一時ファイルの同期後に置換します。バックアップには設定全体が含まれるため、復元の必要がなくなったものは利用者が削除してください。起動時の古い連携設定の更新にも同じ保存処理を使用します。
