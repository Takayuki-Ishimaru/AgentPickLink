# リリース時の検証範囲

v0.2.0 の検証範囲を示します。公開 CI の結果は [GitHub Actions](https://github.com/Takayuki-Ishimaru/AgentPickLink/actions/workflows/ci.yml) から確認できます。ローカルの自動テストと実機確認は、公開 CI の結果を代替しません。

## CI に定義した検証

| 確認項目                                                                   | 対象                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------ |
| 型チェック、lint、単体・契約・結合テスト                                   | Windows / macOS / Ubuntu                         |
| TOML の対象外設定の保持、バックアップ、保存失敗時の動作                    | Windows / macOS / Ubuntu                         |
| 実ブラウザー上の模擬画面による完了判定・添付取得                           | Windows: Edge / macOS: Chromium / Ubuntu: Chrome |
| JSON Schema と実装の同期                                                   | Windows / macOS / Ubuntu                         |
| VSIX の作成・展開、同梱 CLI / MCP の接続とローカル接続プロセスの起動・停止 | Windows / macOS / Ubuntu                         |
| ポータブルアーカイブの組み立てと、同梱 Node.js による CLI / MCP の起動確認 | Windows x64 / macOS arm64 / Ubuntu x64           |

CI は Node.js 22 / 24 を対象とし、Node.js 24 の各 OS ジョブで、その OS 向けのポータブルアーカイブを作成して起動確認します。他の CPU アーキテクチャ向けのアーカイブは CI では作成しません。

Windows の CI は Windows Server を使用します。Ubuntu は実験的な検証対象です。これらの成功は、すべての OS バージョンや実際の VS Code 画面での動作確認を意味しません。

## 確認済みの利用環境

- Windows 11 x64 と Microsoft Edge: アーカイブからの導入、診断、VS Code / Codex 設定からの MCP 接続、別のワークスペースへの導入、アップグレード、以前の版への切り戻し、VSIX との共存、旧形式の連携設定の移行を確認しています。アンインストール後も設定と専用ブラウザープロファイルは保持されます。
- macOS（Apple Silicon）: アーカイブからの導入、Gatekeeper と隔離属性の扱い、Claude Code / Codex CLI への登録と除去、同梱 Node.js による MCP 接続を確認しています。
- macOS（Intel）: Rosetta 上での起動確認のみです。
- Windows ARM64 / Linux x64: 配布アーカイブを用意していますが、実機での動作は未確認です。

SmartScreen、AppLocker / WDAC、Windows の Explorer からのダブルクリック起動は未確認です。組織での導入前に、[管理者向けノート](MANAGED-ENVIRONMENTS.md) に沿って利用環境で確認してください。

## 実 Microsoft 365 テナント

このリリースで確認した範囲（Windows 11 x64、Edge、日本語 UI、職場アカウント、アーカイブからの導入）: サインイン（既存セッションの再利用を含む）、エージェント一覧の取得、選択したエージェントの承認・保存、`doctor`、VS Code / Codex 設定からの MCP 接続、会話の作成・終了、VS Code のチャットでの 3 ツール表示。

このリリースでは、次の確認は未実施です。

- 質問の送信と回答・生成ファイルの取得（AI クライアント経由）。単一ファイル・複数 PDF・PDF と ZIP が混在する応答。
- 英語 UI と、Agent Builder / Copilot Studio（M365 公開）などのエージェント種別ごとの会話。
- MFA や条件付きアクセスを伴う再サインイン。
- 拡張機能のパネルからのサインイン・一覧取得・承認保存の一連の操作（実 VS Code 画面）。拡張機能の起動と MCP 登録は Windows で確認済み。
- Claude Code / Codex 本体からの利用。
- macOS での実テナント確認（この版）。

実ブラウザーの自動テストはローカルの模擬画面を使用します。テナント固有の設定、アクセス権限、Microsoft 365 の画面変更による影響は別途確認が必要です。
