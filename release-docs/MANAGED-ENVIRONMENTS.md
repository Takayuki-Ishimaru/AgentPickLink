# 管理者向けノート: 拡張機能なしインストール

[日本語](MANAGED-ENVIRONMENTS.md) | [English](MANAGED-ENVIRONMENTS.en.md)

このページは、AgentPickLink の **拡張機能なしインストール経路**（GitHub Release からポータブルアーカイブを
ダウンロードして展開し、`apl-setup <ワークスペース>` を 1 回実行する方式。VS Code 拡張機能のインストール
は不要）を評価・展開する IT・セキュリティ管理者向けです。v0.2.1 の導入方法を説明します。
Windows 11 / Microsoft Edge を主な対象とし、macOS は開発・検証向け、Linux は開発・CI 専用です。
SmartScreen、AppLocker / WDAC などの実行制御やテナント設定による制限は、導入先で確認してください。
この版の対応範囲は [対応環境と検証範囲](RELEASE-CHECKLIST.md) を参照してください。

## 登録される内容と識別子

`apl-setup` は、その端末で検出した MCP クライアントごとに設定ファイルを 1 つずつ書き込みます。すべての
ファイルは、版に依存しない同じ固定識別子を使用します。

- Windows: `command` = `<home>\bin\node.exe`、`args` = `["<home>\bin\apl.js", "serve"]`
- macOS / Linux: `command` = `<home>/bin/node`、`args` = `["<home>/bin/apl.js", "serve"]`

識別子が版をまたいで変わらないため、アップグレード（新しいアーカイブで `apl-setup` を再実行すること）は
クライアントの設定ファイルを書き換えません。変わるのは `<home>` 配下のファイルだけです。`apl-setup` が
書き込むすべてのエントリには、次の 2 つの環境変数が含まれます。

- `M365_AGENT_MANAGED=1` — 所有権マーカーです。`apl integrations remove` と `apl self uninstall` は、この
  マーカーを持つエントリだけを変更・削除します。手書きや改名されたエントリはそのまま残り、警告として
  報告されます。
- `M365_AGENT_BUILD=<version>+<build>` — ワークスペース内のファイル（`.vscode/mcp.json`、`.mcp.json`）
  にのみ書き込まれます。VS Code 自身の起動ハッシュ・キャッシュに、アップグレード後のサーバーを「変更
  あり」と認識させ、ツール一覧を再取得させるためのものです。`serve` はこの変数を読み取らず、動作にも
  影響しません。

クライアント・プロセスが引き継ぐ環境にすでに存在する他の `M365_AGENT_*` 変数（例えばポリシーで端末全体
に設定されたもの）はそのまま渡されます。`apl-setup` が上記 2 つ以外の変数を追加することはありません。

**この識別子は VS Code 拡張機能とは異なるコマンド行です。** 拡張機能は VS Code 自身の MCP プロバイダー
API を通じて `<node> <拡張機能のインストール先>/dist/cli/index.js serve` を登録します。VSIX 向けにこの
コマンド行をすでに許可リストへ登録しているサイトで、両方の経路を共存させる場合は、アーカイブの
`<home>/bin/node` + `<home>/bin/apl.js serve` 識別子を別エントリとして追加する必要があります。

## 書き込まれる内容とその場所

`<home>` は、Windows では `%LOCALAPPDATA%\AgentPickLink\`、macOS・Linux では
`~/.local/share/AgentPickLink/` です。常にローカル・ユーザーごと・ローミングされないパスです。
`--home <dir>` オプションまたは `M365_AGENT_INSTALL_ROOT` 環境変数で変更できます。例えば、実行制御
ポリシーですでに許可されているパスを指定する場合に使います（後述）。

```
<home>/
  bin/node | bin/node.exe   同梱ランタイム（後述の「ランタイムの出所」を参照）
  bin/package.json          ランチャーを CommonJS として実行するための設定
  bin/apl.js                現在の app/<version>/dist/cli/index.js を読み込むランチャー
  bin/apl | bin/apl.cmd     doctor・self・integrations 用の人間向けシム。ホストが起動することはない
  app/<version>/            インストール済みパッケージ本体。旧版は `apl self prune` まで保持される
  install.json              { version, platform, nodeVersion, home, clients: [...], workspaces: [...] }
```

クライアントごとのファイルは、`apl-setup` がその端末で検出したクライアントに対してのみ書き込まれ、
各クライアント自身が期待する名前で保存されます。

| クライアント                                | ファイル                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| VS Code（ワークスペース、既定）             | `<workspace>/.vscode/mcp.json`                                                      |
| VS Code（ユーザープロファイル、オプトイン） | `%APPDATA%\Code\User\mcp.json` / `~/Library/Application Support/Code/User/mcp.json` |
| Claude Code                                 | `<workspace>/.mcp.json`                                                             |
| Codex                                       | `~/.codex/config.toml`（`[mcp_servers.m365-agents]`）                               |

`apl-setup` はワークスペースごとに `<workspace>/.m365-agents.json`（そのフォルダで利用したいエージェント
のエイリアス）も書き込み、そのワークスペースを `<home>/install.json` に記録します。どちらのファイルも
それ単体では利用を許可しません。エージェントを呼び出す前に、別途記録される明示的なローカル承認が必要です
（後述の「承認はワークスペースごと」を参照）。

## ネットワーク動作

CLI は、Microsoft 365 へのサインインとエージェントとの通信そのものに本質的に必要な通信を除き、独自の
通信は行いません。唯一のオプトイン例外が `apl doctor --check-updates` で、公開 GitHub Releases API を
確認しますが、自動実行されることも `serve` から呼ばれることもありません。オフライン・隔離環境でも
動作します。アーカイブにはランタイムと依存関係がすべて含まれるため、`apl-setup` はローカルディスクだけ
で完結します。

## ランタイムの出所と検証

- **同梱される Node.js。** ダウンロードしたリリースで固定されているバージョンは、`apl doctor` が報告し
  `install.json` にも記録されます。`nodejs.org` が配布する公式バイナリであり、アーカイブのビルド時に
  `nodejs.org` 自身の `SHASUMS256.txt` と照合済みです。独自ビルドや改変版ではありません。
- **コード署名。** Windows では、同梱の `node.exe` は Authenticode 署名済みで、発行者は OpenJS
  Foundation です。本書の記載をそのまま信頼せず、Sysinternals の `sigcheck -a bin\node.exe`
  などで各自確認してください。macOS では、同梱の `node` バイナリはコード署名済みで、
  `codesign -dv --verbose=4 bin/node` で確認できます。
- **アーカイブの整合性。** すべての GitHub Release には、アーカイブと並んで `SHA256SUMS` が含まれます。
  展開する前に、ダウンロードそのものを信頼するのではなく、これと照合してください（macOS・Linux は
  `shasum -a 256 -c SHA256SUMS`、Windows は `CertUtil -hashfile <file> SHA256` で得た値を目視比較）。
- **ランチャー・スクリプトは平文で読めます。** `apl-setup` / `apl-setup.cmd` は、パイプ実行させる不透明な
  インストーラーではなく、短くコンパイルされていないスクリプトです。実行する前に中身を読んでください。
  それぞれ、隣接する同梱ランタイムで隣接するパッケージを起動するだけの数行のラッパーで、それ自体が
  ネットワークへアクセスすることはありません。

## 実行制御ポリシー（AppLocker / WDAC）

`<home>/bin` はユーザーごとの、`Program Files` 以外のディレクトリです。既定の AppLocker/WDAC 実行可能
ファイル規則は、多くの場合 `Program Files` と `Windows` 配下しか許可しないため、`<home>\bin\node.exe`
はそのままではブロックされます。次のどちらかで対応してください。

1. Node.js の署名証明書（前述の「コード署名」を参照）に対する発行者規則を追加する。同梱ランタイムが
   どこにインストールされても、この規則でカバーされます。
2. ポリシーですでに許可されているパスへインストール先を変更する: `apl-setup --home <承認済みパス>`
   または `M365_AGENT_INSTALL_ROOT` 環境変数を使用します。

`apl doctor` は、この起動失敗を黙って隠さず、明示的に報告します。

## MCP ポリシーとクライアントごとの許可リスト

VS Code・Claude Code・Codex は、それぞれ独自のポリシーで MCP サーバーの利用を制御します。拡張機能経由
とファイル経由のどちらで登録されたサーバーかは関係ありません。

- **VS Code。** VS Code の ADMX/Intune テンプレートを通じて配布される `ChatMCP` ポリシー
  （`chat.mcp.access`）は、MCP の利用を無効化・社内レジストリのみ・明示的な許可/拒否リストのいずれかに
  制限できます。この値が確認できる場合（ユーザーの `settings.json`、または
  `HKCU`/`HKLM\SOFTWARE\Policies\Microsoft\VSCode` 配下のポリシーキー）、`apl doctor` とセットアップの
  計画表示は、汎用的な失敗としてではなく、この設定名を明示して報告します。配布されているが手元から
  読み取れないポリシー値は検出できず、セットアップはその旨を伝えます。
- **Claude Code。** `managed-mcp.json` と `allowedMcpServers` 設定で、どの MCP サーバーエントリを有効に
  するか制限できます。
- **Codex。** `config.toml` のエントリそのもの以外に、MCP サーバー向けの別建ての端末ポリシー層は文書化
  されていません。エントリが存在すること自体が有効化の仕組みです。

インストール済みだがポリシーでブロックされているクライアントは、黙ってスキップされるのではなく、その
旨が報告されます。

## ブラウザープロファイルと、承認がワークスペースごとである理由

Microsoft 365 へのサインインは、`<home>` とは別のアプリケーションデータ・ディレクトリ配下にある専用の
隔離されたブラウザープロファイルを使用します。何を保持し、どう保護されるかは
[`SECURITY.md`](SECURITY.md) を参照してください（アーカイブ経由のインストールにもそのまま当てはまり
ます）。`apl-setup` がクライアントの設定ファイルを書き込むこと自体は、エージェントの利用に同意した
ことを意味しません。ワークスペースで実際に使えるエージェントを持つには、その端末上でエージェントを
明示的に承認する必要があり、その承認は承認時に指定した正規化済みワークスペースのパスだけに適用され
ます。ワークスペースの `.vscode/mcp.json`・`.mcp.json` を別の端末や別のフォルダへコピーしても、承認は
一緒には移動しません。

## VS Code のワークスペース信頼と MCP の起動

VS Code は `mcp.json` 由来のサーバー定義をすべて「信頼済み」として扱い、サーバーごとの信頼ダイアログは出しません。
ただし、作業領域スコープのファイル（`<workspace>/.vscode/mcp.json`、`<workspace>/.mcp.json`）に定義された
サーバーは、そのフォルダーがまだ信頼されていないと、起動時に VS Code がフォルダーの信頼を求めます。ユーザープロファイルの
`mcp.json`（`%APPDATA%\Code\User\mcp.json`）に定義されたサーバーにはこのゲートがなく、既定の
`chat.mcp.autostart` によりチャットへの最初の送信時に自動で起動します。

このため `apl-setup` の既定は、VS Code をユーザープロファイルの `mcp.json` に、Claude Code をユーザー
スコープ（`claude mcp add-json … --scope user`）に登録します。作業領域ファイルへの登録は
`--clients vscode-workspace` / `--clients claude-project` の明示指定でのみ行い、その場合は VS Code が
初回起動時にフォルダーの信頼を、Claude Code がプロジェクトのサーバー承認を求めます。VS Code が
「初めて開くフォルダー」に対して行う信頼確認は MCP とは無関係に発生し、既に利用中のフォルダーでは
表示されません。

登録は承認ではありません。どの方法で登録されていても、すべてのツール呼び出しは前述のローカル・
ワークスペースごとの承認（`.m365-agents.json` とアプリデータ内の承認記録）を必要とし、セットアップして
いないフォルダー、空のウィンドウ、マルチルート・ワークスペースでは呼び出しごとに `WORKSPACE_NOT_CONFIGURED`
を返します。承認とデータ保護の詳細は [セキュリティ](SECURITY.md) を参照してください。

## 展開前に確認すること

1. `apl-setup` / `apl-setup.cmd` の中身を自分で読む。短くコンパイルされていません。
2. 配布しようとしているアーカイブを `SHA256SUMS` と照合する。
3. エンドユーザーへ展開する前に、AppLocker/WDAC の対応方針（発行者規則か `--home` か）を決める。
4. ポリシーで許可されている VS Code・Claude Code・Codex のどれを使うか確認し、対応する許可リストの
   エントリを事前に準備する。
5. エンドユーザー向けの手順は [`README.md`](README.md)、ブロックや設定ミスが発生した際の見え方は
   [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) を参照してください。

### vscode-user の対象フォルダー

`--clients vscode-user` は単一フォルダー専用です。`cwd` はそのフォルダーに固定されます。
複数フォルダー指定は書き込み前に拒否します。複数のワークスペースには `--clients vscode` で
各フォルダーに設定してください。空ウィンドウやマルチルートの動的なフォルダー切替には対応しません。
別フォルダーへの再登録では変更の警告が出ます。`code --add-mcp` フォールバックは使用せず、
書き込めない場合はスニペットを表示します。`apl doctor` で登録結果を確認してください。
