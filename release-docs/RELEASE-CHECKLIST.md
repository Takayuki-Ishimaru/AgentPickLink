# リリース時の検証範囲

v0.1.2 の自動検証と、実環境で追加確認が必要な範囲を示します。公開 CI の結果は [GitHub Actions](https://github.com/Takayuki-Ishimaru/AgentPickLink/actions/workflows/ci.yml) から確認できます。

## 自動検証

| 確認項目 | 対象 |
| --- | --- |
| 型チェック、lint、単体・契約・結合テスト | Windows / macOS / Ubuntu |
| TOML の対象外設定の保持、バックアップ、保存失敗時の動作 | Windows / macOS / Ubuntu |
| 実ブラウザー上の模擬画面による完了判定・添付取得 | Windows: Edge / macOS: Chromium / Ubuntu: Chrome |
| JSON Schema と実装の同期 | Windows / macOS / Ubuntu |
| VSIX の作成・展開、同梱 CLI / MCP の接続とローカル接続プロセスの起動・停止 | Windows / macOS / Ubuntu |

Windows の CI は Windows Server を使用します。Ubuntu は実験的な検証対象です。これらの成功は、すべての OS バージョンや実際の VS Code 画面での動作確認を意味しません。

## 実 Microsoft 365 テナント

このリリースでは、次の組み合わせの追加確認は未実施です。

- 日本語・英語 UI と、Agent Builder / Copilot Studio（M365 公開）などのエージェント種別。
- 単発質問・継続会話、MFA や条件付きアクセスを伴う再ログイン。
- 単一ファイル・複数 PDF・PDF と ZIP が混在する応答。
- Windows 11 と Edge の可視ウィンドウ、および実際の VS Code パネルからの一連の操作。

実ブラウザーの自動テストはローカルの模擬画面を使用します。テナント固有の設定、アクセス権限、Microsoft 365 の画面変更による影響は別途確認が必要です。
