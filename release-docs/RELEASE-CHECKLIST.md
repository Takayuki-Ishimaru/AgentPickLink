# 対応環境と検証範囲

v0.2.2 Beta の対応環境と確認範囲を説明します。

## 対応環境

- **Windows 11 / Microsoft Edge**: 主な利用対象です。
- **macOS / Microsoft Edge または Google Chrome**: 開発・検証向けです。
- **Linux**: 開発・CI 専用です。通常の利用は対象外で、標準の `serve` は `PLATFORM_UNSUPPORTED` を返します。
- **VS Code**: ローカルで開いた単一フォルダーを対象とします。WSL、Remote SSH、Dev Containers、Codespaces、マルチルートのワークスペース、リモート MCP サーバー、無人運転には対応しません。

Windows ARM64、macOS Intel、Linux x64 のアーカイブも配布しますが、この版での各実機の動作は未確認です。配布物の有無は、すべての環境での動作保証を意味しません。

## 自動検証の範囲

公開 CI は Windows・macOS・Ubuntu、Node.js 22 / 24 で、型チェック、テスト、模擬ブラウザー画面の操作、設定スキーマ、配布パッケージの作成と起動を確認する構成です。結果は公開リポジトリの [GitHub Actions](https://github.com/Takayuki-Ishimaru/AgentPickLink/actions/workflows/ci.yml) で、対象バージョンまたはコミットを選んで確認してください。

ブラウザーの自動テストはローカルの模擬画面を使用し、VS Code のテストは API モックを使用します。実 Microsoft 365 テナントや実際の VS Code 画面を操作する試験ではありません。Windows の CI ランナーも Windows 11 のデスクトップ実機とは異なります。ソースからの確認方法は [開発者向けガイド](DEVELOPMENT.md) を参照してください。

## この版で未確認の範囲

この版では、Windows 実機、実 Microsoft 365 テナント、実際の VS Code 画面での追加確認は行っていません。以前の版での確認結果を、この版の動作保証として扱いません。

特に、AI クライアントからの質問・回答・生成ファイル取得、エージェントの種類や表示言語による差、MFA・条件付きアクセスを伴う再サインインは、利用するテナントで確認してください。セットアップでの保存完了は、実際の質問・回答やファイルの内容の正しさまで確認したことを意味しません。

SmartScreen、AppLocker / WDAC、Gatekeeper などの実行制御や、組織のクライアント設定によって起動・接続が制限される場合があります。導入方法と確認点は [管理者向けノート](MANAGED-ENVIRONMENTS.md) を参照してください。

## English

v0.2.2 Beta primarily targets Windows 11 with Microsoft Edge. macOS is for development and verification. Linux archives are for development/CI only; standard `serve` returns `PLATFORM_UNSUPPORTED`. Use a local, single-folder workspace. WSL, Remote SSH, Dev Containers, Codespaces, multi-root workspaces, remote MCP servers, and unattended operation are unsupported.

Public CI is configured for Windows, macOS, and Ubuntu with Node.js 22 / 24. It uses local mock browser pages and VS Code API mocks, and does not verify a live tenant or the actual VS Code interface. Select the relevant version or commit in [GitHub Actions](https://github.com/Takayuki-Ishimaru/AgentPickLink/actions/workflows/ci.yml) to view its results.

Additional Windows desktop, live-tenant, and actual VS Code interface checks have not been performed for this version. Native Windows ARM64, Intel Mac, and Linux x64 operation is unverified for this version. Earlier checks do not establish compatibility for the current version. Verify questions, answers, generated files, agent types, UI languages, and re-login with MFA or Conditional Access in your deployment environment. Saving setup settings does not verify live responses or file content.

See [Managed environments](MANAGED-ENVIRONMENTS.en.md) for execution controls and client policy considerations.
