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
