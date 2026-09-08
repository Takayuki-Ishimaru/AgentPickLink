# 利用 OSS・第三者ソフトウェア / Open-source and third-party software

[日本語 README](README.md) | [English README](README.en.md)

AgentPickLink 本体は [MIT ライセンス](../LICENSE) の OSS です。依存ソフトウェアのライセンスは変更しません。
The AgentPickLink project is MIT licensed. Third-party software retains its original license terms.

この一覧は v0.1.0 の [package-lock.json](../package-lock.json) に固定されたパッケージ名・バージョン・ライセンス宣言から生成しています。Runtime は実行時依存、Development はビルド・テスト・パッケージ作成用です。間接依存と OS 別の任意依存も含むため、全項目が同時にインストールされたり VSIX に含まれたりするわけではありません。同じパッケージの異なる依存位置は別行です。
This inventory uses the names, pinned versions and license declarations in the lockfile. It includes direct, transitive and platform-specific optional dependencies. Not every entry is installed on every platform or shipped in the VSIX; separate installation paths have separate rows.

実行時に配布するソフトウェアの著作権表示・ライセンス全文・同梱コンポーネントの通知は [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) に収録しています。VSIX 内の各パッケージの LICENSE / NOTICE も保持しています。
Full runtime license texts, copyright notices and bundled component notices are included in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt). Original package license files are also retained in the VSIX.

## 直接利用する OSS / Direct OSS dependencies

MCP SDK はクライアント連携、Playwright はブラウザー操作、Commander は CLI、Zod はデータ検証、YAML は設定の読書き、proper-lockfile はローカルロックに使用します。Development のツールはコンパイル、バンドル、テスト、静的チェック、書式整形、VSIX 作成に使用します。
The MCP SDK provides protocol integration; Playwright controls the browser; Commander handles the CLI; Zod validates data; YAML reads and writes configuration; proper-lockfile manages local locks. Development tools provide compilation, bundling, tests, linting, formatting and VSIX packaging.

| Package                                                                                            | Version | License    | Scope       | Dependency |
| -------------------------------------------------------------------------------------------------- | ------- | ---------- | ----------- | ---------- |
| [@eslint/js](https://www.npmjs.com/package/@eslint/js/v/10.0.1)                                    | 10.0.1  | MIT        | Development | Direct     |
| [@modelcontextprotocol/client](https://www.npmjs.com/package/@modelcontextprotocol/client/v/2.0.0) | 2.0.0   | MIT        | Development | Direct     |
| [@modelcontextprotocol/core](https://www.npmjs.com/package/@modelcontextprotocol/core/v/2.0.0)     | 2.0.0   | MIT        | Runtime     | Direct     |
| [@modelcontextprotocol/server](https://www.npmjs.com/package/@modelcontextprotocol/server/v/2.0.0) | 2.0.0   | MIT        | Runtime     | Direct     |
| [@types/node](https://www.npmjs.com/package/@types/node/v/22.20.1)                                 | 22.20.1 | MIT        | Development | Direct     |
| [@types/proper-lockfile](https://www.npmjs.com/package/@types/proper-lockfile/v/4.1.4)             | 4.1.4   | MIT        | Development | Direct     |
| [@types/vscode](https://www.npmjs.com/package/@types/vscode/v/1.101.0)                             | 1.101.0 | MIT        | Development | Direct     |
| [@vscode/vsce](https://www.npmjs.com/package/@vscode/vsce/v/3.9.2)                                 | 3.9.2   | MIT        | Development | Direct     |
| [commander](https://www.npmjs.com/package/commander/v/14.0.3)                                      | 14.0.3  | MIT        | Runtime     | Direct     |
| [esbuild](https://www.npmjs.com/package/esbuild/v/0.28.2)                                          | 0.28.2  | MIT        | Development | Direct     |
| [eslint](https://www.npmjs.com/package/eslint/v/10.9.1)                                            | 10.9.1  | MIT        | Development | Direct     |
| [playwright-core](https://www.npmjs.com/package/playwright-core/v/1.62.1)                          | 1.62.1  | Apache-2.0 | Runtime     | Direct     |
| [prettier](https://www.npmjs.com/package/prettier/v/3.9.6)                                         | 3.9.6   | MIT        | Development | Direct     |
| [proper-lockfile](https://www.npmjs.com/package/proper-lockfile/v/4.1.2)                           | 4.1.2   | MIT        | Runtime     | Direct     |
| [typescript](https://www.npmjs.com/package/typescript/v/5.9.3)                                     | 5.9.3   | Apache-2.0 | Development | Direct     |
| [typescript-eslint](https://www.npmjs.com/package/typescript-eslint/v/8.69.0)                      | 8.69.0  | MIT        | Development | Direct     |
| [vitest](https://www.npmjs.com/package/vitest/v/3.2.7)                                             | 3.2.7   | MIT        | Development | Direct     |
| [yaml](https://www.npmjs.com/package/yaml/v/2.9.0)                                                 | 2.9.0   | ISC        | Runtime     | Direct     |
| [zod](https://www.npmjs.com/package/zod/v/4.5.4)                                                   | 4.5.4   | MIT        | Runtime     | Direct     |

## 実行時の間接依存 / Transitive runtime dependencies

| Package                                                           | Version | License | Scope   | Dependency |
| ----------------------------------------------------------------- | ------- | ------- | ------- | ---------- |
| [graceful-fs](https://www.npmjs.com/package/graceful-fs/v/4.2.11) | 4.2.11  | ISC     | Runtime | Transitive |
| [retry](https://www.npmjs.com/package/retry/v/0.12.0)             | 0.12.0  | MIT     | Runtime | Transitive |
| [signal-exit](https://www.npmjs.com/package/signal-exit/v/3.0.7)  | 3.0.7   | ISC     | Runtime | Transitive |

## Playwright 同梱 OSS / OSS bundled inside Playwright

次は Playwright が配布するバンドル通知から取得した一覧です。lockfile の独立パッケージ一覧には現れないものもあります。各コンポーネントの許諾条件は、全文通知内の対応する名前の節を参照してください。
These entries come from Playwright's bundled notices and may not appear as standalone lockfile packages. See each named section in the full notices for its license terms.

| Component                                                                           | Version                         | License text                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| [@hono/node-server](https://github.com/honojs/node-server)                          | 1.19.14                         | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 1.29.0                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [@sec-ant/readable-stream](https://github.com/Sec-ant/readable-stream)              | 0.4.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [agent-base](https://github.com/TooTallNate/proxy-agents)                           | 9.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [ajv](https://github.com/ajv-validator/ajv)                                         | 8.20.0                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [ajv-formats](https://github.com/ajv-validator/ajv-formats)                         | 3.0.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [ansi-colors](https://github.com/doowb/ansi-colors)                                 | 4.1.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [ansi-regex](https://github.com/chalk/ansi-regex)                                   | 5.0.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [anymatch](https://github.com/micromatch/anymatch)                                  | 3.1.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [balanced-match](https://github.com/juliangruber/balanced-match)                    | 4.0.4                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [binary-extensions](https://github.com/sindresorhus/binary-extensions)              | 2.3.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [brace-expansion](https://github.com/juliangruber/brace-expansion)                  | 5.0.7                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [braces](https://github.com/micromatch/braces)                                      | 3.0.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [buffer-crc32](https://github.com/brianloveswords/buffer-crc32)                     | 1.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [buffer-from](https://github.com/LinusU/buffer-from)                                | 1.1.2                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [bundle-name](https://github.com/sindresorhus/bundle-name)                          | 4.1.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [bytes](https://github.com/visionmedia/bytes.js)                                    | 3.1.2                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [chokidar](https://github.com/paulmillr/chokidar)                                   | 3.6.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [colors](https://github.com/Marak/colors.js)                                        | 1.4.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [commander](https://github.com/tj/commander.js)                                     | 15.0.0                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [content-type](https://github.com/jshttp/content-type)                              | 1.0.5                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [cross-spawn](https://github.com/moxystudio/node-cross-spawn)                       | 7.0.6                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [debug](https://github.com/debug-js/debug)                                          | 4.4.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [default-browser](https://github.com/sindresorhus/default-browser)                  | 5.5.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [default-browser-id](https://github.com/sindresorhus/default-browser-id)            | 5.0.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [define-lazy-prop](https://github.com/sindresorhus/define-lazy-prop)                | 3.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [diff](https://github.com/kpdecker/jsdiff)                                          | 9.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [dotenv](https://github.com/motdotla/dotenv)                                        | 17.4.2                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [enquirer](https://github.com/enquirer/enquirer)                                    | 2.4.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [eventsource](https://github.com/EventSource/eventsource)                           | 3.0.7                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [eventsource-parser](https://github.com/rexxars/eventsource-parser)                 | 3.1.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [fast-deep-equal](https://github.com/epoberezkin/fast-deep-equal)                   | 3.1.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [fast-uri](https://github.com/fastify/fast-uri)                                     | 3.1.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [fill-range](https://github.com/jonschlinkert/fill-range)                           | 7.1.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [get-east-asian-width](https://github.com/sindresorhus/get-east-asian-width)        | 1.6.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [get-stream](https://github.com/sindresorhus/get-stream)                            | 9.0.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [glob-parent](https://github.com/gulpjs/glob-parent)                                | 5.1.2                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [graceful-fs](https://github.com/isaacs/node-graceful-fs)                           | 4.2.11                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [has-flag](https://github.com/sindresorhus/has-flag)                                | 4.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [https-proxy-agent](https://github.com/TooTallNate/proxy-agents)                    | 9.1.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [ini](https://github.com/npm/ini)                                                   | 7.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [ip-address](https://github.com/beaugunderson/ip-address)                           | 10.2.0                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [is-binary-path](https://github.com/sindresorhus/is-binary-path)                    | 2.1.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [is-docker](https://github.com/sindresorhus/is-docker)                              | 3.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [is-extglob](https://github.com/jonschlinkert/is-extglob)                           | 2.1.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [is-glob](https://github.com/micromatch/is-glob)                                    | 4.0.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [is-in-ssh](https://github.com/sindresorhus/is-in-ssh)                              | 1.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [is-inside-container](https://github.com/sindresorhus/is-inside-container)          | 1.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [is-number](https://github.com/jonschlinkert/is-number)                             | 7.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [is-stream](https://github.com/sindresorhus/is-stream)                              | 4.0.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [is-wsl](https://github.com/sindresorhus/is-wsl)                                    | 3.1.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [isexe](https://github.com/isaacs/isexe)                                            | 2.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [jpeg-js](https://github.com/eugeneware/jpeg-js)                                    | 0.4.4                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [json-schema-traverse](https://github.com/epoberezkin/json-schema-traverse)         | 1.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [json5](https://github.com/json5/json5)                                             | 2.2.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [mime](https://github.com/broofa/mime)                                              | 4.1.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [minimatch](https://github.com/isaacs/minimatch)                                    | 10.2.5                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [ms](https://github.com/vercel/ms)                                                  | 2.1.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [normalize-path](https://github.com/jonschlinkert/normalize-path)                   | 3.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [open](https://github.com/sindresorhus/open)                                        | 11.0.0                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [path-key](https://github.com/sindresorhus/path-key)                                | 3.1.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [pend](https://github.com/andrewrk/node-pend)                                       | 1.2.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [picomatch](https://github.com/micromatch/picomatch)                                | 2.3.2                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [pkce-challenge](https://github.com/crouchcd/pkce-challenge)                        | 5.0.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [pngjs](https://github.com/pngjs/pngjs)                                             | 7.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [powershell-utils](https://github.com/sindresorhus/powershell-utils)                | 0.1.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [progress](https://github.com/visionmedia/node-progress)                            | 2.0.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [proxy-agent-negotiate](https://github.com/TooTallNate/proxy-agents)                | 1.1.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [proxy-from-env](https://github.com/Rob--W/proxy-from-env)                          | 2.1.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [readdirp](https://github.com/paulmillr/readdirp)                                   | 3.6.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [retry](https://github.com/tim-kos/node-retry)                                      | 0.13.1                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [run-applescript](https://github.com/sindresorhus/run-applescript)                  | 7.1.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [shebang-command](https://github.com/kevva/shebang-command)                         | 2.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [shebang-regex](https://github.com/sindresorhus/shebang-regex)                      | 3.0.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [signal-exit](https://github.com/tapjs/signal-exit)                                 | 4.1.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [smart-buffer](https://github.com/JoshGlazebrook/smart-buffer)                      | 4.2.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [socks](https://github.com/JoshGlazebrook/socks)                                    | 2.8.9                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [socks-proxy-agent](https://github.com/TooTallNate/proxy-agents)                    | 10.1.0                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [source-map](https://github.com/mozilla/source-map)                                 | 0.6.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [source-map-support](https://github.com/evanw/node-source-map-support)              | 0.5.21                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [strip-ansi](https://github.com/chalk/strip-ansi)                                   | 6.0.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [supports-color](https://github.com/chalk/supports-color)                           | 7.2.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [to-regex-range](https://github.com/micromatch/to-regex-range)                      | 5.0.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [which](https://github.com/isaacs/node-which)                                       | 2.0.2                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [ws](https://github.com/websockets/ws)                                              | 8.21.0                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [wsl-utils](https://github.com/sindresorhus/wsl-utils)                              | 0.3.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [yaml](https://github.com/eemeli/yaml)                                              | 2.9.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [yauzl](https://github.com/thejoshwolfe/yauzl)                                      | 3.4.0                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [yazl](https://github.com/thejoshwolfe/yazl)                                        | 3.3.1                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [zod](https://github.com/colinhacks/zod)                                            | 4.4.3                           | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| [zod-to-json-schema](https://github.com/StefanTerdell/zod-to-json-schema)           | 3.25.2                          | [Bundled notices](THIRD-PARTY-NOTICES.txt)                            |
| libwebp                                                                             | Not specified in bundled notice | BSD-3-Clause and patent grant; [full notice](THIRD-PARTY-NOTICES.txt) |
| Emscripten runtime and included components                                          | Not specified in bundled notice | [WebP codec notices](THIRD-PARTY-NOTICES.txt)                         |

## 開発用の間接 OSS 依存 / Transitive development OSS dependencies

| Package                                                                                                                             | Version | License                             | Scope       | Dependency |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------- | ----------- | ---------- |
| [@azu/format-text](https://www.npmjs.com/package/@azu/format-text/v/1.0.2)                                                          | 1.0.2   | BSD-3-Clause                        | Development | Transitive |
| [@azu/style-format](https://www.npmjs.com/package/@azu/style-format/v/1.0.1)                                                        | 1.0.1   | WTFPL                               | Development | Transitive |
| [@azure/abort-controller](https://www.npmjs.com/package/@azure/abort-controller/v/2.2.0)                                            | 2.2.0   | MIT                                 | Development | Transitive |
| [@azure/core-auth](https://www.npmjs.com/package/@azure/core-auth/v/1.11.0)                                                         | 1.11.0  | MIT                                 | Development | Transitive |
| [@azure/core-client](https://www.npmjs.com/package/@azure/core-client/v/1.11.1)                                                     | 1.11.1  | MIT                                 | Development | Transitive |
| [@azure/core-process](https://www.npmjs.com/package/@azure/core-process/v/1.0.0)                                                    | 1.0.0   | MIT                                 | Development | Transitive |
| [@azure/core-rest-pipeline](https://www.npmjs.com/package/@azure/core-rest-pipeline/v/1.25.0)                                       | 1.25.0  | MIT                                 | Development | Transitive |
| [@azure/core-tracing](https://www.npmjs.com/package/@azure/core-tracing/v/1.4.0)                                                    | 1.4.0   | MIT                                 | Development | Transitive |
| [@azure/core-util](https://www.npmjs.com/package/@azure/core-util/v/1.14.0)                                                         | 1.14.0  | MIT                                 | Development | Transitive |
| [@azure/identity](https://www.npmjs.com/package/@azure/identity/v/4.13.2)                                                           | 4.13.2  | MIT                                 | Development | Transitive |
| [@azure/logger](https://www.npmjs.com/package/@azure/logger/v/1.4.0)                                                                | 1.4.0   | MIT                                 | Development | Transitive |
| [@azure/msal-browser](https://www.npmjs.com/package/@azure/msal-browser/v/5.21.0)                                                   | 5.21.0  | MIT                                 | Development | Transitive |
| [@azure/msal-common](https://www.npmjs.com/package/@azure/msal-common/v/16.14.0)                                                    | 16.14.0 | MIT                                 | Development | Transitive |
| [@azure/msal-node](https://www.npmjs.com/package/@azure/msal-node/v/5.6.0)                                                          | 5.6.0   | MIT                                 | Development | Transitive |
| [@azure/msal-common](https://www.npmjs.com/package/@azure/msal-common/v/16.13.0)                                                    | 16.13.0 | MIT                                 | Development | Transitive |
| [@babel/code-frame](https://www.npmjs.com/package/@babel/code-frame/v/7.29.7)                                                       | 7.29.7  | MIT                                 | Development | Transitive |
| [js-tokens](https://www.npmjs.com/package/js-tokens/v/4.0.0)                                                                        | 4.0.0   | MIT                                 | Development | Transitive |
| [@babel/helper-validator-identifier](https://www.npmjs.com/package/@babel/helper-validator-identifier/v/7.29.7)                     | 7.29.7  | MIT                                 | Development | Transitive |
| [@esbuild/aix-ppc64](https://www.npmjs.com/package/@esbuild/aix-ppc64/v/0.28.2)                                                     | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/android-arm](https://www.npmjs.com/package/@esbuild/android-arm/v/0.28.2)                                                 | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/android-arm64](https://www.npmjs.com/package/@esbuild/android-arm64/v/0.28.2)                                             | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/android-x64](https://www.npmjs.com/package/@esbuild/android-x64/v/0.28.2)                                                 | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/darwin-arm64](https://www.npmjs.com/package/@esbuild/darwin-arm64/v/0.28.2)                                               | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/darwin-x64](https://www.npmjs.com/package/@esbuild/darwin-x64/v/0.28.2)                                                   | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/freebsd-arm64](https://www.npmjs.com/package/@esbuild/freebsd-arm64/v/0.28.2)                                             | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/freebsd-x64](https://www.npmjs.com/package/@esbuild/freebsd-x64/v/0.28.2)                                                 | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/linux-arm](https://www.npmjs.com/package/@esbuild/linux-arm/v/0.28.2)                                                     | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/linux-arm64](https://www.npmjs.com/package/@esbuild/linux-arm64/v/0.28.2)                                                 | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/linux-ia32](https://www.npmjs.com/package/@esbuild/linux-ia32/v/0.28.2)                                                   | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/linux-loong64](https://www.npmjs.com/package/@esbuild/linux-loong64/v/0.28.2)                                             | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/linux-mips64el](https://www.npmjs.com/package/@esbuild/linux-mips64el/v/0.28.2)                                           | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/linux-ppc64](https://www.npmjs.com/package/@esbuild/linux-ppc64/v/0.28.2)                                                 | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/linux-riscv64](https://www.npmjs.com/package/@esbuild/linux-riscv64/v/0.28.2)                                             | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/linux-s390x](https://www.npmjs.com/package/@esbuild/linux-s390x/v/0.28.2)                                                 | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/linux-x64](https://www.npmjs.com/package/@esbuild/linux-x64/v/0.28.2)                                                     | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/netbsd-arm64](https://www.npmjs.com/package/@esbuild/netbsd-arm64/v/0.28.2)                                               | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/netbsd-x64](https://www.npmjs.com/package/@esbuild/netbsd-x64/v/0.28.2)                                                   | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/openbsd-arm64](https://www.npmjs.com/package/@esbuild/openbsd-arm64/v/0.28.2)                                             | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/openbsd-x64](https://www.npmjs.com/package/@esbuild/openbsd-x64/v/0.28.2)                                                 | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/openharmony-arm64](https://www.npmjs.com/package/@esbuild/openharmony-arm64/v/0.28.2)                                     | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/sunos-x64](https://www.npmjs.com/package/@esbuild/sunos-x64/v/0.28.2)                                                     | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/win32-arm64](https://www.npmjs.com/package/@esbuild/win32-arm64/v/0.28.2)                                                 | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/win32-ia32](https://www.npmjs.com/package/@esbuild/win32-ia32/v/0.28.2)                                                   | 0.28.2  | MIT                                 | Development | Transitive |
| [@esbuild/win32-x64](https://www.npmjs.com/package/@esbuild/win32-x64/v/0.28.2)                                                     | 0.28.2  | MIT                                 | Development | Transitive |
| [@eslint-community/eslint-utils](https://www.npmjs.com/package/@eslint-community/eslint-utils/v/4.10.1)                             | 4.10.1  | MIT                                 | Development | Transitive |
| [eslint-visitor-keys](https://www.npmjs.com/package/eslint-visitor-keys/v/3.4.3)                                                    | 3.4.3   | Apache-2.0                          | Development | Transitive |
| [@eslint-community/regexpp](https://www.npmjs.com/package/@eslint-community/regexpp/v/4.12.2)                                       | 4.12.2  | MIT                                 | Development | Transitive |
| [@eslint/config-array](https://www.npmjs.com/package/@eslint/config-array/v/0.23.5)                                                 | 0.23.5  | Apache-2.0                          | Development | Transitive |
| [@eslint/config-helpers](https://www.npmjs.com/package/@eslint/config-helpers/v/0.7.0)                                              | 0.7.0   | Apache-2.0                          | Development | Transitive |
| [@eslint/core](https://www.npmjs.com/package/@eslint/core/v/1.2.1)                                                                  | 1.2.1   | Apache-2.0                          | Development | Transitive |
| [@eslint/object-schema](https://www.npmjs.com/package/@eslint/object-schema/v/3.0.5)                                                | 3.0.5   | Apache-2.0                          | Development | Transitive |
| [@eslint/plugin-kit](https://www.npmjs.com/package/@eslint/plugin-kit/v/0.7.3)                                                      | 0.7.3   | Apache-2.0                          | Development | Transitive |
| [@humanfs/core](https://www.npmjs.com/package/@humanfs/core/v/0.19.2)                                                               | 0.19.2  | Apache-2.0                          | Development | Transitive |
| [@humanfs/node](https://www.npmjs.com/package/@humanfs/node/v/0.16.8)                                                               | 0.16.8  | Apache-2.0                          | Development | Transitive |
| [@humanfs/types](https://www.npmjs.com/package/@humanfs/types/v/0.15.0)                                                             | 0.15.0  | Apache-2.0                          | Development | Transitive |
| [@humanwhocodes/module-importer](https://www.npmjs.com/package/@humanwhocodes/module-importer/v/1.0.1)                              | 1.0.1   | Apache-2.0                          | Development | Transitive |
| [@humanwhocodes/retry](https://www.npmjs.com/package/@humanwhocodes/retry/v/0.4.3)                                                  | 0.4.3   | Apache-2.0                          | Development | Transitive |
| [@jridgewell/sourcemap-codec](https://www.npmjs.com/package/@jridgewell/sourcemap-codec/v/1.6.0)                                    | 1.6.0   | MIT                                 | Development | Transitive |
| [@napi-rs/lzma-linux-x64-gnu](https://www.npmjs.com/package/@napi-rs/lzma-linux-x64-gnu/v/1.5.1)                                    | 1.5.1   | MIT                                 | Development | Transitive |
| [@nodelib/fs.scandir](https://www.npmjs.com/package/@nodelib/fs.scandir/v/2.1.5)                                                    | 2.1.5   | MIT                                 | Development | Transitive |
| [@nodelib/fs.stat](https://www.npmjs.com/package/@nodelib/fs.stat/v/2.0.5)                                                          | 2.0.5   | MIT                                 | Development | Transitive |
| [@nodelib/fs.walk](https://www.npmjs.com/package/@nodelib/fs.walk/v/1.2.8)                                                          | 1.2.8   | MIT                                 | Development | Transitive |
| [@rollup/rollup-android-arm-eabi](https://www.npmjs.com/package/@rollup/rollup-android-arm-eabi/v/4.63.1)                           | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-android-arm64](https://www.npmjs.com/package/@rollup/rollup-android-arm64/v/4.63.1)                                 | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-darwin-arm64](https://www.npmjs.com/package/@rollup/rollup-darwin-arm64/v/4.63.1)                                   | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-darwin-x64](https://www.npmjs.com/package/@rollup/rollup-darwin-x64/v/4.63.1)                                       | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-freebsd-arm64](https://www.npmjs.com/package/@rollup/rollup-freebsd-arm64/v/4.63.1)                                 | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-freebsd-x64](https://www.npmjs.com/package/@rollup/rollup-freebsd-x64/v/4.63.1)                                     | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-arm-gnueabihf](https://www.npmjs.com/package/@rollup/rollup-linux-arm-gnueabihf/v/4.63.1)                     | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-arm-musleabihf](https://www.npmjs.com/package/@rollup/rollup-linux-arm-musleabihf/v/4.63.1)                   | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-arm64-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-arm64-gnu/v/4.63.1)                             | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-arm64-musl](https://www.npmjs.com/package/@rollup/rollup-linux-arm64-musl/v/4.63.1)                           | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-loong64-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-loong64-gnu/v/4.63.1)                         | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-loong64-musl](https://www.npmjs.com/package/@rollup/rollup-linux-loong64-musl/v/4.63.1)                       | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-ppc64-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-ppc64-gnu/v/4.63.1)                             | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-ppc64-musl](https://www.npmjs.com/package/@rollup/rollup-linux-ppc64-musl/v/4.63.1)                           | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-riscv64-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-riscv64-gnu/v/4.63.1)                         | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-riscv64-musl](https://www.npmjs.com/package/@rollup/rollup-linux-riscv64-musl/v/4.63.1)                       | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-s390x-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-s390x-gnu/v/4.63.1)                             | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-x64-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-x64-gnu/v/4.63.1)                                 | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-linux-x64-musl](https://www.npmjs.com/package/@rollup/rollup-linux-x64-musl/v/4.63.1)                               | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-openbsd-x64](https://www.npmjs.com/package/@rollup/rollup-openbsd-x64/v/4.63.1)                                     | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-openharmony-arm64](https://www.npmjs.com/package/@rollup/rollup-openharmony-arm64/v/4.63.1)                         | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-win32-arm64-msvc](https://www.npmjs.com/package/@rollup/rollup-win32-arm64-msvc/v/4.63.1)                           | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-win32-ia32-msvc](https://www.npmjs.com/package/@rollup/rollup-win32-ia32-msvc/v/4.63.1)                             | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-win32-x64-gnu](https://www.npmjs.com/package/@rollup/rollup-win32-x64-gnu/v/4.63.1)                                 | 4.63.1  | MIT                                 | Development | Transitive |
| [@rollup/rollup-win32-x64-msvc](https://www.npmjs.com/package/@rollup/rollup-win32-x64-msvc/v/4.63.1)                               | 4.63.1  | MIT                                 | Development | Transitive |
| [@secretlint/config-creator](https://www.npmjs.com/package/@secretlint/config-creator/v/10.2.2)                                     | 10.2.2  | MIT                                 | Development | Transitive |
| [@secretlint/config-loader](https://www.npmjs.com/package/@secretlint/config-loader/v/10.2.2)                                       | 10.2.2  | MIT                                 | Development | Transitive |
| [ajv](https://www.npmjs.com/package/ajv/v/8.20.0)                                                                                   | 8.20.0  | MIT                                 | Development | Transitive |
| [json-schema-traverse](https://www.npmjs.com/package/json-schema-traverse/v/1.0.0)                                                  | 1.0.0   | MIT                                 | Development | Transitive |
| [@secretlint/core](https://www.npmjs.com/package/@secretlint/core/v/10.2.2)                                                         | 10.2.2  | MIT                                 | Development | Transitive |
| [@secretlint/formatter](https://www.npmjs.com/package/@secretlint/formatter/v/10.2.2)                                               | 10.2.2  | MIT                                 | Development | Transitive |
| [chalk](https://www.npmjs.com/package/chalk/v/5.6.2)                                                                                | 5.6.2   | MIT                                 | Development | Transitive |
| [@secretlint/node](https://www.npmjs.com/package/@secretlint/node/v/10.2.2)                                                         | 10.2.2  | MIT                                 | Development | Transitive |
| [@secretlint/profiler](https://www.npmjs.com/package/@secretlint/profiler/v/10.2.2)                                                 | 10.2.2  | MIT                                 | Development | Transitive |
| [@secretlint/resolver](https://www.npmjs.com/package/@secretlint/resolver/v/10.2.2)                                                 | 10.2.2  | MIT                                 | Development | Transitive |
| [@secretlint/secretlint-formatter-sarif](https://www.npmjs.com/package/@secretlint/secretlint-formatter-sarif/v/10.2.2)             | 10.2.2  | MIT                                 | Development | Transitive |
| [@secretlint/secretlint-rule-no-dotenv](https://www.npmjs.com/package/@secretlint/secretlint-rule-no-dotenv/v/10.2.2)               | 10.2.2  | MIT                                 | Development | Transitive |
| [@secretlint/secretlint-rule-preset-recommend](https://www.npmjs.com/package/@secretlint/secretlint-rule-preset-recommend/v/10.2.2) | 10.2.2  | MIT                                 | Development | Transitive |
| [@secretlint/source-creator](https://www.npmjs.com/package/@secretlint/source-creator/v/10.2.2)                                     | 10.2.2  | MIT                                 | Development | Transitive |
| [@secretlint/types](https://www.npmjs.com/package/@secretlint/types/v/10.2.2)                                                       | 10.2.2  | MIT                                 | Development | Transitive |
| [@sindresorhus/merge-streams](https://www.npmjs.com/package/@sindresorhus/merge-streams/v/2.3.0)                                    | 2.3.0   | MIT                                 | Development | Transitive |
| [@textlint/ast-node-types](https://www.npmjs.com/package/@textlint/ast-node-types/v/15.8.0)                                         | 15.8.0  | MIT                                 | Development | Transitive |
| [@textlint/linter-formatter](https://www.npmjs.com/package/@textlint/linter-formatter/v/15.8.0)                                     | 15.8.0  | MIT                                 | Development | Transitive |
| [ansi-regex](https://www.npmjs.com/package/ansi-regex/v/5.0.1)                                                                      | 5.0.1   | MIT                                 | Development | Transitive |
| [pluralize](https://www.npmjs.com/package/pluralize/v/2.0.0)                                                                        | 2.0.0   | MIT                                 | Development | Transitive |
| [strip-ansi](https://www.npmjs.com/package/strip-ansi/v/6.0.1)                                                                      | 6.0.1   | MIT                                 | Development | Transitive |
| [@textlint/module-interop](https://www.npmjs.com/package/@textlint/module-interop/v/15.8.0)                                         | 15.8.0  | MIT                                 | Development | Transitive |
| [@textlint/resolver](https://www.npmjs.com/package/@textlint/resolver/v/15.8.0)                                                     | 15.8.0  | MIT                                 | Development | Transitive |
| [@textlint/types](https://www.npmjs.com/package/@textlint/types/v/15.8.0)                                                           | 15.8.0  | MIT                                 | Development | Transitive |
| [@types/chai](https://www.npmjs.com/package/@types/chai/v/5.2.3)                                                                    | 5.2.3   | MIT                                 | Development | Transitive |
| [@types/deep-eql](https://www.npmjs.com/package/@types/deep-eql/v/4.0.2)                                                            | 4.0.2   | MIT                                 | Development | Transitive |
| [@types/esrecurse](https://www.npmjs.com/package/@types/esrecurse/v/4.3.1)                                                          | 4.3.1   | MIT                                 | Development | Transitive |
| [@types/estree](https://www.npmjs.com/package/@types/estree/v/1.0.9)                                                                | 1.0.9   | MIT                                 | Development | Transitive |
| [@types/json-schema](https://www.npmjs.com/package/@types/json-schema/v/7.0.15)                                                     | 7.0.15  | MIT                                 | Development | Transitive |
| [@types/normalize-package-data](https://www.npmjs.com/package/@types/normalize-package-data/v/2.4.4)                                | 2.4.4   | MIT                                 | Development | Transitive |
| [@types/retry](https://www.npmjs.com/package/@types/retry/v/0.12.5)                                                                 | 0.12.5  | MIT                                 | Development | Transitive |
| [@types/sarif](https://www.npmjs.com/package/@types/sarif/v/2.1.7)                                                                  | 2.1.7   | MIT                                 | Development | Transitive |
| [@typescript-eslint/eslint-plugin](https://www.npmjs.com/package/@typescript-eslint/eslint-plugin/v/8.69.0)                         | 8.69.0  | MIT                                 | Development | Transitive |
| [ignore](https://www.npmjs.com/package/ignore/v/7.0.8)                                                                              | 7.0.8   | MIT                                 | Development | Transitive |
| [@typescript-eslint/parser](https://www.npmjs.com/package/@typescript-eslint/parser/v/8.69.0)                                       | 8.69.0  | MIT                                 | Development | Transitive |
| [@typescript-eslint/project-service](https://www.npmjs.com/package/@typescript-eslint/project-service/v/8.69.0)                     | 8.69.0  | MIT                                 | Development | Transitive |
| [@typescript-eslint/scope-manager](https://www.npmjs.com/package/@typescript-eslint/scope-manager/v/8.69.0)                         | 8.69.0  | MIT                                 | Development | Transitive |
| [@typescript-eslint/tsconfig-utils](https://www.npmjs.com/package/@typescript-eslint/tsconfig-utils/v/8.69.0)                       | 8.69.0  | MIT                                 | Development | Transitive |
| [@typescript-eslint/type-utils](https://www.npmjs.com/package/@typescript-eslint/type-utils/v/8.69.0)                               | 8.69.0  | MIT                                 | Development | Transitive |
| [@typescript-eslint/types](https://www.npmjs.com/package/@typescript-eslint/types/v/8.69.0)                                         | 8.69.0  | MIT                                 | Development | Transitive |
| [@typescript-eslint/typescript-estree](https://www.npmjs.com/package/@typescript-eslint/typescript-estree/v/8.69.0)                 | 8.69.0  | MIT                                 | Development | Transitive |
| [@typescript-eslint/utils](https://www.npmjs.com/package/@typescript-eslint/utils/v/8.69.0)                                         | 8.69.0  | MIT                                 | Development | Transitive |
| [@typescript-eslint/visitor-keys](https://www.npmjs.com/package/@typescript-eslint/visitor-keys/v/8.69.0)                           | 8.69.0  | MIT                                 | Development | Transitive |
| [@typespec/ts-http-runtime](https://www.npmjs.com/package/@typespec/ts-http-runtime/v/0.3.9)                                        | 0.3.9   | MIT                                 | Development | Transitive |
| [@vitest/expect](https://www.npmjs.com/package/@vitest/expect/v/3.2.7)                                                              | 3.2.7   | MIT                                 | Development | Transitive |
| [@vitest/mocker](https://www.npmjs.com/package/@vitest/mocker/v/3.2.7)                                                              | 3.2.7   | MIT                                 | Development | Transitive |
| [@vitest/pretty-format](https://www.npmjs.com/package/@vitest/pretty-format/v/3.2.7)                                                | 3.2.7   | MIT                                 | Development | Transitive |
| [@vitest/runner](https://www.npmjs.com/package/@vitest/runner/v/3.2.7)                                                              | 3.2.7   | MIT                                 | Development | Transitive |
| [@vitest/snapshot](https://www.npmjs.com/package/@vitest/snapshot/v/3.2.7)                                                          | 3.2.7   | MIT                                 | Development | Transitive |
| [@vitest/spy](https://www.npmjs.com/package/@vitest/spy/v/3.2.7)                                                                    | 3.2.7   | MIT                                 | Development | Transitive |
| [@vitest/utils](https://www.npmjs.com/package/@vitest/utils/v/3.2.7)                                                                | 3.2.7   | MIT                                 | Development | Transitive |
| [commander](https://www.npmjs.com/package/commander/v/12.1.0)                                                                       | 12.1.0  | MIT                                 | Development | Transitive |
| [acorn](https://www.npmjs.com/package/acorn/v/8.18.0)                                                                               | 8.18.0  | MIT                                 | Development | Transitive |
| [acorn-jsx](https://www.npmjs.com/package/acorn-jsx/v/5.3.2)                                                                        | 5.3.2   | MIT                                 | Development | Transitive |
| [agent-base](https://www.npmjs.com/package/agent-base/v/7.1.4)                                                                      | 7.1.4   | MIT                                 | Development | Transitive |
| [ajv](https://www.npmjs.com/package/ajv/v/6.15.0)                                                                                   | 6.15.0  | MIT                                 | Development | Transitive |
| [ansi-escapes](https://www.npmjs.com/package/ansi-escapes/v/7.3.0)                                                                  | 7.3.0   | MIT                                 | Development | Transitive |
| [ansi-regex](https://www.npmjs.com/package/ansi-regex/v/6.3.0)                                                                      | 6.3.0   | MIT                                 | Development | Transitive |
| [ansi-styles](https://www.npmjs.com/package/ansi-styles/v/4.3.0)                                                                    | 4.3.0   | MIT                                 | Development | Transitive |
| [argparse](https://www.npmjs.com/package/argparse/v/2.0.1)                                                                          | 2.0.1   | Python-2.0                          | Development | Transitive |
| [assertion-error](https://www.npmjs.com/package/assertion-error/v/2.0.1)                                                            | 2.0.1   | MIT                                 | Development | Transitive |
| [astral-regex](https://www.npmjs.com/package/astral-regex/v/2.0.0)                                                                  | 2.0.0   | MIT                                 | Development | Transitive |
| [asynckit](https://www.npmjs.com/package/asynckit/v/0.4.0)                                                                          | 0.4.0   | MIT                                 | Development | Transitive |
| [azure-devops-node-api](https://www.npmjs.com/package/azure-devops-node-api/v/12.5.0)                                               | 12.5.0  | MIT                                 | Development | Transitive |
| [balanced-match](https://www.npmjs.com/package/balanced-match/v/4.0.4)                                                              | 4.0.4   | MIT                                 | Development | Transitive |
| [base64-js](https://www.npmjs.com/package/base64-js/v/1.5.1)                                                                        | 1.5.1   | MIT                                 | Development | Transitive |
| [binaryextensions](https://www.npmjs.com/package/binaryextensions/v/6.11.0)                                                         | 6.11.0  | Artistic-2.0                        | Development | Transitive |
| [bl](https://www.npmjs.com/package/bl/v/4.1.0)                                                                                      | 4.1.0   | MIT                                 | Development | Transitive |
| [boolbase](https://www.npmjs.com/package/boolbase/v/1.0.0)                                                                          | 1.0.0   | ISC                                 | Development | Transitive |
| [boundary](https://www.npmjs.com/package/boundary/v/2.0.0)                                                                          | 2.0.0   | BSD-2-Clause                        | Development | Transitive |
| [brace-expansion](https://www.npmjs.com/package/brace-expansion/v/5.0.9)                                                            | 5.0.9   | MIT                                 | Development | Transitive |
| [braces](https://www.npmjs.com/package/braces/v/3.0.3)                                                                              | 3.0.3   | MIT                                 | Development | Transitive |
| [buffer](https://www.npmjs.com/package/buffer/v/5.7.1)                                                                              | 5.7.1   | MIT                                 | Development | Transitive |
| [buffer-crc32](https://www.npmjs.com/package/buffer-crc32/v/0.2.13)                                                                 | 0.2.13  | MIT                                 | Development | Transitive |
| [buffer-equal-constant-time](https://www.npmjs.com/package/buffer-equal-constant-time/v/1.0.1)                                      | 1.0.1   | BSD-3-Clause                        | Development | Transitive |
| [bundle-name](https://www.npmjs.com/package/bundle-name/v/4.1.0)                                                                    | 4.1.0   | MIT                                 | Development | Transitive |
| [cac](https://www.npmjs.com/package/cac/v/6.7.14)                                                                                   | 6.7.14  | MIT                                 | Development | Transitive |
| [call-bind-apply-helpers](https://www.npmjs.com/package/call-bind-apply-helpers/v/1.0.2)                                            | 1.0.2   | MIT                                 | Development | Transitive |
| [call-bound](https://www.npmjs.com/package/call-bound/v/1.0.4)                                                                      | 1.0.4   | MIT                                 | Development | Transitive |
| [chai](https://www.npmjs.com/package/chai/v/5.3.3)                                                                                  | 5.3.3   | MIT                                 | Development | Transitive |
| [chalk](https://www.npmjs.com/package/chalk/v/4.1.2)                                                                                | 4.1.2   | MIT                                 | Development | Transitive |
| [check-error](https://www.npmjs.com/package/check-error/v/2.1.3)                                                                    | 2.1.3   | MIT                                 | Development | Transitive |
| [cheerio](https://www.npmjs.com/package/cheerio/v/1.2.0)                                                                            | 1.2.0   | MIT                                 | Development | Transitive |
| [cheerio-select](https://www.npmjs.com/package/cheerio-select/v/2.1.0)                                                              | 2.1.0   | BSD-2-Clause                        | Development | Transitive |
| [chownr](https://www.npmjs.com/package/chownr/v/1.1.4)                                                                              | 1.1.4   | ISC                                 | Development | Transitive |
| [cockatiel](https://www.npmjs.com/package/cockatiel/v/3.2.1)                                                                        | 3.2.1   | MIT                                 | Development | Transitive |
| [color-convert](https://www.npmjs.com/package/color-convert/v/2.0.1)                                                                | 2.0.1   | MIT                                 | Development | Transitive |
| [color-name](https://www.npmjs.com/package/color-name/v/1.1.4)                                                                      | 1.1.4   | MIT                                 | Development | Transitive |
| [combined-stream](https://www.npmjs.com/package/combined-stream/v/1.0.8)                                                            | 1.0.8   | MIT                                 | Development | Transitive |
| [cross-spawn](https://www.npmjs.com/package/cross-spawn/v/7.0.6)                                                                    | 7.0.6   | MIT                                 | Development | Transitive |
| [css-select](https://www.npmjs.com/package/css-select/v/5.2.2)                                                                      | 5.2.2   | BSD-2-Clause                        | Development | Transitive |
| [css-what](https://www.npmjs.com/package/css-what/v/6.2.2)                                                                          | 6.2.2   | BSD-2-Clause                        | Development | Transitive |
| [debug](https://www.npmjs.com/package/debug/v/4.4.3)                                                                                | 4.4.3   | MIT                                 | Development | Transitive |
| [decompress-response](https://www.npmjs.com/package/decompress-response/v/6.0.0)                                                    | 6.0.0   | MIT                                 | Development | Transitive |
| [deep-eql](https://www.npmjs.com/package/deep-eql/v/5.0.2)                                                                          | 5.0.2   | MIT                                 | Development | Transitive |
| [deep-extend](https://www.npmjs.com/package/deep-extend/v/0.6.0)                                                                    | 0.6.0   | MIT                                 | Development | Transitive |
| [deep-is](https://www.npmjs.com/package/deep-is/v/0.1.4)                                                                            | 0.1.4   | MIT                                 | Development | Transitive |
| [default-browser](https://www.npmjs.com/package/default-browser/v/5.5.1)                                                            | 5.5.1   | MIT                                 | Development | Transitive |
| [default-browser-id](https://www.npmjs.com/package/default-browser-id/v/5.0.1)                                                      | 5.0.1   | MIT                                 | Development | Transitive |
| [define-lazy-prop](https://www.npmjs.com/package/define-lazy-prop/v/3.0.0)                                                          | 3.0.0   | MIT                                 | Development | Transitive |
| [delayed-stream](https://www.npmjs.com/package/delayed-stream/v/1.0.0)                                                              | 1.0.0   | MIT                                 | Development | Transitive |
| [detect-libc](https://www.npmjs.com/package/detect-libc/v/2.1.2)                                                                    | 2.1.2   | Apache-2.0                          | Development | Transitive |
| [dom-serializer](https://www.npmjs.com/package/dom-serializer/v/2.0.0)                                                              | 2.0.0   | MIT                                 | Development | Transitive |
| [domelementtype](https://www.npmjs.com/package/domelementtype/v/2.3.0)                                                              | 2.3.0   | BSD-2-Clause                        | Development | Transitive |
| [domhandler](https://www.npmjs.com/package/domhandler/v/5.0.3)                                                                      | 5.0.3   | BSD-2-Clause                        | Development | Transitive |
| [domutils](https://www.npmjs.com/package/domutils/v/3.2.2)                                                                          | 3.2.2   | BSD-2-Clause                        | Development | Transitive |
| [dunder-proto](https://www.npmjs.com/package/dunder-proto/v/1.0.1)                                                                  | 1.0.1   | MIT                                 | Development | Transitive |
| [ecdsa-sig-formatter](https://www.npmjs.com/package/ecdsa-sig-formatter/v/1.0.11)                                                   | 1.0.11  | Apache-2.0                          | Development | Transitive |
| [editions](https://www.npmjs.com/package/editions/v/6.22.0)                                                                         | 6.22.0  | Artistic-2.0                        | Development | Transitive |
| [emoji-regex](https://www.npmjs.com/package/emoji-regex/v/8.0.0)                                                                    | 8.0.0   | MIT                                 | Development | Transitive |
| [encoding-sniffer](https://www.npmjs.com/package/encoding-sniffer/v/0.2.1)                                                          | 0.2.1   | MIT                                 | Development | Transitive |
| [end-of-stream](https://www.npmjs.com/package/end-of-stream/v/1.4.5)                                                                | 1.4.5   | MIT                                 | Development | Transitive |
| [entities](https://www.npmjs.com/package/entities/v/4.5.0)                                                                          | 4.5.0   | BSD-2-Clause                        | Development | Transitive |
| [environment](https://www.npmjs.com/package/environment/v/1.1.0)                                                                    | 1.1.0   | MIT                                 | Development | Transitive |
| [es-define-property](https://www.npmjs.com/package/es-define-property/v/1.0.1)                                                      | 1.0.1   | MIT                                 | Development | Transitive |
| [es-errors](https://www.npmjs.com/package/es-errors/v/1.3.0)                                                                        | 1.3.0   | MIT                                 | Development | Transitive |
| [es-module-lexer](https://www.npmjs.com/package/es-module-lexer/v/1.7.0)                                                            | 1.7.0   | MIT                                 | Development | Transitive |
| [es-object-atoms](https://www.npmjs.com/package/es-object-atoms/v/1.1.2)                                                            | 1.1.2   | MIT                                 | Development | Transitive |
| [es-set-tostringtag](https://www.npmjs.com/package/es-set-tostringtag/v/2.1.0)                                                      | 2.1.0   | MIT                                 | Development | Transitive |
| [escape-string-regexp](https://www.npmjs.com/package/escape-string-regexp/v/4.0.0)                                                  | 4.0.0   | MIT                                 | Development | Transitive |
| [eslint-scope](https://www.npmjs.com/package/eslint-scope/v/9.1.2)                                                                  | 9.1.2   | BSD-2-Clause                        | Development | Transitive |
| [eslint-visitor-keys](https://www.npmjs.com/package/eslint-visitor-keys/v/5.0.1)                                                    | 5.0.1   | Apache-2.0                          | Development | Transitive |
| [espree](https://www.npmjs.com/package/espree/v/11.2.0)                                                                             | 11.2.0  | BSD-2-Clause                        | Development | Transitive |
| [esquery](https://www.npmjs.com/package/esquery/v/1.7.0)                                                                            | 1.7.0   | BSD-3-Clause                        | Development | Transitive |
| [esrecurse](https://www.npmjs.com/package/esrecurse/v/4.3.0)                                                                        | 4.3.0   | BSD-2-Clause                        | Development | Transitive |
| [estraverse](https://www.npmjs.com/package/estraverse/v/5.3.0)                                                                      | 5.3.0   | BSD-2-Clause                        | Development | Transitive |
| [estree-walker](https://www.npmjs.com/package/estree-walker/v/3.0.3)                                                                | 3.0.3   | MIT                                 | Development | Transitive |
| [esutils](https://www.npmjs.com/package/esutils/v/2.0.3)                                                                            | 2.0.3   | BSD-2-Clause                        | Development | Transitive |
| [eventsource](https://www.npmjs.com/package/eventsource/v/3.0.7)                                                                    | 3.0.7   | MIT                                 | Development | Transitive |
| [eventsource-parser](https://www.npmjs.com/package/eventsource-parser/v/3.1.1)                                                      | 3.1.1   | MIT                                 | Development | Transitive |
| [expand-template](https://www.npmjs.com/package/expand-template/v/2.0.3)                                                            | 2.0.3   | (MIT OR WTFPL)                      | Development | Transitive |
| [expect-type](https://www.npmjs.com/package/expect-type/v/1.4.0)                                                                    | 1.4.0   | Apache-2.0                          | Development | Transitive |
| [fast-deep-equal](https://www.npmjs.com/package/fast-deep-equal/v/3.1.3)                                                            | 3.1.3   | MIT                                 | Development | Transitive |
| [fast-glob](https://www.npmjs.com/package/fast-glob/v/3.3.3)                                                                        | 3.3.3   | MIT                                 | Development | Transitive |
| [glob-parent](https://www.npmjs.com/package/glob-parent/v/5.1.2)                                                                    | 5.1.2   | ISC                                 | Development | Transitive |
| [fast-json-stable-stringify](https://www.npmjs.com/package/fast-json-stable-stringify/v/2.1.0)                                      | 2.1.0   | MIT                                 | Development | Transitive |
| [fast-levenshtein](https://www.npmjs.com/package/fast-levenshtein/v/2.0.6)                                                          | 2.0.6   | MIT                                 | Development | Transitive |
| [fast-uri](https://www.npmjs.com/package/fast-uri/v/3.1.7)                                                                          | 3.1.7   | BSD-3-Clause                        | Development | Transitive |
| [fastq](https://www.npmjs.com/package/fastq/v/1.20.3)                                                                               | 1.20.3  | ISC                                 | Development | Transitive |
| [fdir](https://www.npmjs.com/package/fdir/v/6.5.0)                                                                                  | 6.5.0   | MIT                                 | Development | Transitive |
| [file-entry-cache](https://www.npmjs.com/package/file-entry-cache/v/8.0.0)                                                          | 8.0.0   | MIT                                 | Development | Transitive |
| [fill-range](https://www.npmjs.com/package/fill-range/v/7.1.1)                                                                      | 7.1.1   | MIT                                 | Development | Transitive |
| [find-up](https://www.npmjs.com/package/find-up/v/5.0.0)                                                                            | 5.0.0   | MIT                                 | Development | Transitive |
| [flat-cache](https://www.npmjs.com/package/flat-cache/v/4.0.1)                                                                      | 4.0.1   | MIT                                 | Development | Transitive |
| [flatted](https://www.npmjs.com/package/flatted/v/3.4.4)                                                                            | 3.4.4   | ISC                                 | Development | Transitive |
| [form-data](https://www.npmjs.com/package/form-data/v/4.0.6)                                                                        | 4.0.6   | MIT                                 | Development | Transitive |
| [fs-constants](https://www.npmjs.com/package/fs-constants/v/1.0.0)                                                                  | 1.0.0   | MIT                                 | Development | Transitive |
| [fs-extra](https://www.npmjs.com/package/fs-extra/v/11.4.0)                                                                         | 11.4.0  | MIT                                 | Development | Transitive |
| [fsevents](https://www.npmjs.com/package/fsevents/v/2.3.3)                                                                          | 2.3.3   | MIT                                 | Development | Transitive |
| [function-bind](https://www.npmjs.com/package/function-bind/v/1.1.2)                                                                | 1.1.2   | MIT                                 | Development | Transitive |
| [get-intrinsic](https://www.npmjs.com/package/get-intrinsic/v/1.3.0)                                                                | 1.3.0   | MIT                                 | Development | Transitive |
| [get-proto](https://www.npmjs.com/package/get-proto/v/1.0.1)                                                                        | 1.0.1   | MIT                                 | Development | Transitive |
| [github-from-package](https://www.npmjs.com/package/github-from-package/v/0.0.0)                                                    | 0.0.0   | MIT                                 | Development | Transitive |
| [glob](https://www.npmjs.com/package/glob/v/13.0.6)                                                                                 | 13.0.6  | BlueOak-1.0.0                       | Development | Transitive |
| [glob-parent](https://www.npmjs.com/package/glob-parent/v/6.0.2)                                                                    | 6.0.2   | ISC                                 | Development | Transitive |
| [globby](https://www.npmjs.com/package/globby/v/14.1.0)                                                                             | 14.1.0  | MIT                                 | Development | Transitive |
| [ignore](https://www.npmjs.com/package/ignore/v/7.0.8)                                                                              | 7.0.8   | MIT                                 | Development | Transitive |
| [gopd](https://www.npmjs.com/package/gopd/v/1.2.0)                                                                                  | 1.2.0   | MIT                                 | Development | Transitive |
| [has-flag](https://www.npmjs.com/package/has-flag/v/4.0.0)                                                                          | 4.0.0   | MIT                                 | Development | Transitive |
| [has-symbols](https://www.npmjs.com/package/has-symbols/v/1.1.0)                                                                    | 1.1.0   | MIT                                 | Development | Transitive |
| [has-tostringtag](https://www.npmjs.com/package/has-tostringtag/v/1.0.2)                                                            | 1.0.2   | MIT                                 | Development | Transitive |
| [hasown](https://www.npmjs.com/package/hasown/v/2.0.4)                                                                              | 2.0.4   | MIT                                 | Development | Transitive |
| [hosted-git-info](https://www.npmjs.com/package/hosted-git-info/v/4.1.0)                                                            | 4.1.0   | ISC                                 | Development | Transitive |
| [htmlparser2](https://www.npmjs.com/package/htmlparser2/v/10.1.0)                                                                   | 10.1.0  | MIT                                 | Development | Transitive |
| [entities](https://www.npmjs.com/package/entities/v/7.0.1)                                                                          | 7.0.1   | BSD-2-Clause                        | Development | Transitive |
| [http-proxy-agent](https://www.npmjs.com/package/http-proxy-agent/v/7.0.2)                                                          | 7.0.2   | MIT                                 | Development | Transitive |
| [https-proxy-agent](https://www.npmjs.com/package/https-proxy-agent/v/7.0.6)                                                        | 7.0.6   | MIT                                 | Development | Transitive |
| [iconv-lite](https://www.npmjs.com/package/iconv-lite/v/0.6.3)                                                                      | 0.6.3   | MIT                                 | Development | Transitive |
| [ieee754](https://www.npmjs.com/package/ieee754/v/1.2.1)                                                                            | 1.2.1   | BSD-3-Clause                        | Development | Transitive |
| [ignore](https://www.npmjs.com/package/ignore/v/5.3.2)                                                                              | 5.3.2   | MIT                                 | Development | Transitive |
| [imurmurhash](https://www.npmjs.com/package/imurmurhash/v/0.1.4)                                                                    | 0.1.4   | MIT                                 | Development | Transitive |
| [index-to-position](https://www.npmjs.com/package/index-to-position/v/1.2.0)                                                        | 1.2.0   | MIT                                 | Development | Transitive |
| [inherits](https://www.npmjs.com/package/inherits/v/2.0.4)                                                                          | 2.0.4   | ISC                                 | Development | Transitive |
| [ini](https://www.npmjs.com/package/ini/v/1.3.8)                                                                                    | 1.3.8   | ISC                                 | Development | Transitive |
| [is-docker](https://www.npmjs.com/package/is-docker/v/3.0.0)                                                                        | 3.0.0   | MIT                                 | Development | Transitive |
| [is-extglob](https://www.npmjs.com/package/is-extglob/v/2.1.1)                                                                      | 2.1.1   | MIT                                 | Development | Transitive |
| [is-fullwidth-code-point](https://www.npmjs.com/package/is-fullwidth-code-point/v/3.0.0)                                            | 3.0.0   | MIT                                 | Development | Transitive |
| [is-glob](https://www.npmjs.com/package/is-glob/v/4.0.3)                                                                            | 4.0.3   | MIT                                 | Development | Transitive |
| [is-inside-container](https://www.npmjs.com/package/is-inside-container/v/1.0.0)                                                    | 1.0.0   | MIT                                 | Development | Transitive |
| [is-number](https://www.npmjs.com/package/is-number/v/7.0.0)                                                                        | 7.0.0   | MIT                                 | Development | Transitive |
| [is-wsl](https://www.npmjs.com/package/is-wsl/v/3.1.1)                                                                              | 3.1.1   | MIT                                 | Development | Transitive |
| [isexe](https://www.npmjs.com/package/isexe/v/2.0.0)                                                                                | 2.0.0   | ISC                                 | Development | Transitive |
| [istextorbinary](https://www.npmjs.com/package/istextorbinary/v/9.5.0)                                                              | 9.5.0   | Artistic-2.0                        | Development | Transitive |
| [jose](https://www.npmjs.com/package/jose/v/6.2.10)                                                                                 | 6.2.10  | MIT                                 | Development | Transitive |
| [js-tokens](https://www.npmjs.com/package/js-tokens/v/9.0.1)                                                                        | 9.0.1   | MIT                                 | Development | Transitive |
| [js-yaml](https://www.npmjs.com/package/js-yaml/v/4.3.2)                                                                            | 4.3.2   | MIT                                 | Development | Transitive |
| [json-buffer](https://www.npmjs.com/package/json-buffer/v/3.0.1)                                                                    | 3.0.1   | MIT                                 | Development | Transitive |
| [json-schema-traverse](https://www.npmjs.com/package/json-schema-traverse/v/0.4.1)                                                  | 0.4.1   | MIT                                 | Development | Transitive |
| [json-stable-stringify-without-jsonify](https://www.npmjs.com/package/json-stable-stringify-without-jsonify/v/1.0.1)                | 1.0.1   | MIT                                 | Development | Transitive |
| [json5](https://www.npmjs.com/package/json5/v/2.2.3)                                                                                | 2.2.3   | MIT                                 | Development | Transitive |
| [jsonc-parser](https://www.npmjs.com/package/jsonc-parser/v/3.3.1)                                                                  | 3.3.1   | MIT                                 | Development | Transitive |
| [jsonfile](https://www.npmjs.com/package/jsonfile/v/6.2.1)                                                                          | 6.2.1   | MIT                                 | Development | Transitive |
| [jsonwebtoken](https://www.npmjs.com/package/jsonwebtoken/v/9.0.3)                                                                  | 9.0.3   | MIT                                 | Development | Transitive |
| [jwa](https://www.npmjs.com/package/jwa/v/2.0.1)                                                                                    | 2.0.1   | MIT                                 | Development | Transitive |
| [jws](https://www.npmjs.com/package/jws/v/4.0.1)                                                                                    | 4.0.1   | MIT                                 | Development | Transitive |
| [keytar](https://www.npmjs.com/package/keytar/v/7.9.0)                                                                              | 7.9.0   | MIT                                 | Development | Transitive |
| [keyv](https://www.npmjs.com/package/keyv/v/4.5.4)                                                                                  | 4.5.4   | MIT                                 | Development | Transitive |
| [leven](https://www.npmjs.com/package/leven/v/3.1.0)                                                                                | 3.1.0   | MIT                                 | Development | Transitive |
| [levn](https://www.npmjs.com/package/levn/v/0.4.1)                                                                                  | 0.4.1   | MIT                                 | Development | Transitive |
| [linkify-it](https://www.npmjs.com/package/linkify-it/v/5.0.2)                                                                      | 5.0.2   | MIT                                 | Development | Transitive |
| [locate-path](https://www.npmjs.com/package/locate-path/v/6.0.0)                                                                    | 6.0.0   | MIT                                 | Development | Transitive |
| [lodash](https://www.npmjs.com/package/lodash/v/4.18.1)                                                                             | 4.18.1  | MIT                                 | Development | Transitive |
| [lodash.includes](https://www.npmjs.com/package/lodash.includes/v/4.3.0)                                                            | 4.3.0   | MIT                                 | Development | Transitive |
| [lodash.isboolean](https://www.npmjs.com/package/lodash.isboolean/v/3.0.3)                                                          | 3.0.3   | MIT                                 | Development | Transitive |
| [lodash.isinteger](https://www.npmjs.com/package/lodash.isinteger/v/4.0.4)                                                          | 4.0.4   | MIT                                 | Development | Transitive |
| [lodash.isnumber](https://www.npmjs.com/package/lodash.isnumber/v/3.0.3)                                                            | 3.0.3   | MIT                                 | Development | Transitive |
| [lodash.isplainobject](https://www.npmjs.com/package/lodash.isplainobject/v/4.0.6)                                                  | 4.0.6   | MIT                                 | Development | Transitive |
| [lodash.isstring](https://www.npmjs.com/package/lodash.isstring/v/4.0.1)                                                            | 4.0.1   | MIT                                 | Development | Transitive |
| [lodash.once](https://www.npmjs.com/package/lodash.once/v/4.1.1)                                                                    | 4.1.1   | MIT                                 | Development | Transitive |
| [lodash.truncate](https://www.npmjs.com/package/lodash.truncate/v/4.4.2)                                                            | 4.4.2   | MIT                                 | Development | Transitive |
| [loupe](https://www.npmjs.com/package/loupe/v/3.2.1)                                                                                | 3.2.1   | MIT                                 | Development | Transitive |
| [lru-cache](https://www.npmjs.com/package/lru-cache/v/6.0.0)                                                                        | 6.0.0   | ISC                                 | Development | Transitive |
| [magic-string](https://www.npmjs.com/package/magic-string/v/0.30.21)                                                                | 0.30.21 | MIT                                 | Development | Transitive |
| [markdown-it](https://www.npmjs.com/package/markdown-it/v/14.3.1)                                                                   | 14.3.1  | MIT                                 | Development | Transitive |
| [math-intrinsics](https://www.npmjs.com/package/math-intrinsics/v/1.1.0)                                                            | 1.1.0   | MIT                                 | Development | Transitive |
| [mdurl](https://www.npmjs.com/package/mdurl/v/2.1.0)                                                                                | 2.1.0   | MIT                                 | Development | Transitive |
| [merge2](https://www.npmjs.com/package/merge2/v/1.4.1)                                                                              | 1.4.1   | MIT                                 | Development | Transitive |
| [micromatch](https://www.npmjs.com/package/micromatch/v/4.0.8)                                                                      | 4.0.8   | MIT                                 | Development | Transitive |
| [picomatch](https://www.npmjs.com/package/picomatch/v/2.3.2)                                                                        | 2.3.2   | MIT                                 | Development | Transitive |
| [mime](https://www.npmjs.com/package/mime/v/1.6.0)                                                                                  | 1.6.0   | MIT                                 | Development | Transitive |
| [mime-db](https://www.npmjs.com/package/mime-db/v/1.52.0)                                                                           | 1.52.0  | MIT                                 | Development | Transitive |
| [mime-types](https://www.npmjs.com/package/mime-types/v/2.1.35)                                                                     | 2.1.35  | MIT                                 | Development | Transitive |
| [mimic-response](https://www.npmjs.com/package/mimic-response/v/3.1.0)                                                              | 3.1.0   | MIT                                 | Development | Transitive |
| [minimatch](https://www.npmjs.com/package/minimatch/v/10.2.6)                                                                       | 10.2.6  | BlueOak-1.0.0                       | Development | Transitive |
| [minimist](https://www.npmjs.com/package/minimist/v/1.2.8)                                                                          | 1.2.8   | MIT                                 | Development | Transitive |
| [minipass](https://www.npmjs.com/package/minipass/v/7.1.3)                                                                          | 7.1.3   | BlueOak-1.0.0                       | Development | Transitive |
| [mkdirp-classic](https://www.npmjs.com/package/mkdirp-classic/v/0.5.3)                                                              | 0.5.3   | MIT                                 | Development | Transitive |
| [ms](https://www.npmjs.com/package/ms/v/2.1.3)                                                                                      | 2.1.3   | MIT                                 | Development | Transitive |
| [mute-stream](https://www.npmjs.com/package/mute-stream/v/0.0.8)                                                                    | 0.0.8   | ISC                                 | Development | Transitive |
| [nanoid](https://www.npmjs.com/package/nanoid/v/3.3.18)                                                                             | 3.3.18  | MIT                                 | Development | Transitive |
| [napi-build-utils](https://www.npmjs.com/package/napi-build-utils/v/2.0.0)                                                          | 2.0.0   | MIT                                 | Development | Transitive |
| [natural-compare](https://www.npmjs.com/package/natural-compare/v/1.4.0)                                                            | 1.4.0   | MIT                                 | Development | Transitive |
| [node-abi](https://www.npmjs.com/package/node-abi/v/3.96.0)                                                                         | 3.96.0  | MIT                                 | Development | Transitive |
| [node-addon-api](https://www.npmjs.com/package/node-addon-api/v/4.3.0)                                                              | 4.3.0   | MIT                                 | Development | Transitive |
| [node-sarif-builder](https://www.npmjs.com/package/node-sarif-builder/v/3.4.0)                                                      | 3.4.0   | MIT                                 | Development | Transitive |
| [normalize-package-data](https://www.npmjs.com/package/normalize-package-data/v/6.0.2)                                              | 6.0.2   | BSD-2-Clause                        | Development | Transitive |
| [hosted-git-info](https://www.npmjs.com/package/hosted-git-info/v/7.0.2)                                                            | 7.0.2   | ISC                                 | Development | Transitive |
| [lru-cache](https://www.npmjs.com/package/lru-cache/v/10.4.3)                                                                       | 10.4.3  | ISC                                 | Development | Transitive |
| [nth-check](https://www.npmjs.com/package/nth-check/v/2.1.1)                                                                        | 2.1.1   | BSD-2-Clause                        | Development | Transitive |
| [object-inspect](https://www.npmjs.com/package/object-inspect/v/1.13.4)                                                             | 1.13.4  | MIT                                 | Development | Transitive |
| [once](https://www.npmjs.com/package/once/v/1.4.0)                                                                                  | 1.4.0   | ISC                                 | Development | Transitive |
| [open](https://www.npmjs.com/package/open/v/10.2.0)                                                                                 | 10.2.0  | MIT                                 | Development | Transitive |
| [optionator](https://www.npmjs.com/package/optionator/v/0.9.4)                                                                      | 0.9.4   | MIT                                 | Development | Transitive |
| [p-limit](https://www.npmjs.com/package/p-limit/v/3.1.0)                                                                            | 3.1.0   | MIT                                 | Development | Transitive |
| [p-locate](https://www.npmjs.com/package/p-locate/v/5.0.0)                                                                          | 5.0.0   | MIT                                 | Development | Transitive |
| [p-map](https://www.npmjs.com/package/p-map/v/7.0.7)                                                                                | 7.0.7   | MIT                                 | Development | Transitive |
| [parse-json](https://www.npmjs.com/package/parse-json/v/8.3.0)                                                                      | 8.3.0   | MIT                                 | Development | Transitive |
| [parse-semver](https://www.npmjs.com/package/parse-semver/v/1.1.1)                                                                  | 1.1.1   | MIT                                 | Development | Transitive |
| [semver](https://www.npmjs.com/package/semver/v/5.7.2)                                                                              | 5.7.2   | ISC                                 | Development | Transitive |
| [parse5](https://www.npmjs.com/package/parse5/v/7.3.0)                                                                              | 7.3.0   | MIT                                 | Development | Transitive |
| [parse5-htmlparser2-tree-adapter](https://www.npmjs.com/package/parse5-htmlparser2-tree-adapter/v/7.1.0)                            | 7.1.0   | MIT                                 | Development | Transitive |
| [parse5-parser-stream](https://www.npmjs.com/package/parse5-parser-stream/v/7.1.2)                                                  | 7.1.2   | MIT                                 | Development | Transitive |
| [entities](https://www.npmjs.com/package/entities/v/6.0.1)                                                                          | 6.0.1   | BSD-2-Clause                        | Development | Transitive |
| [path-exists](https://www.npmjs.com/package/path-exists/v/4.0.0)                                                                    | 4.0.0   | MIT                                 | Development | Transitive |
| [path-key](https://www.npmjs.com/package/path-key/v/3.1.1)                                                                          | 3.1.1   | MIT                                 | Development | Transitive |
| [path-scurry](https://www.npmjs.com/package/path-scurry/v/2.0.2)                                                                    | 2.0.2   | BlueOak-1.0.0                       | Development | Transitive |
| [lru-cache](https://www.npmjs.com/package/lru-cache/v/11.5.2)                                                                       | 11.5.2  | BlueOak-1.0.0                       | Development | Transitive |
| [path-type](https://www.npmjs.com/package/path-type/v/6.0.0)                                                                        | 6.0.0   | MIT                                 | Development | Transitive |
| [pathe](https://www.npmjs.com/package/pathe/v/2.0.3)                                                                                | 2.0.3   | MIT                                 | Development | Transitive |
| [pathval](https://www.npmjs.com/package/pathval/v/2.0.1)                                                                            | 2.0.1   | MIT                                 | Development | Transitive |
| [pend](https://www.npmjs.com/package/pend/v/1.2.0)                                                                                  | 1.2.0   | MIT                                 | Development | Transitive |
| [picocolors](https://www.npmjs.com/package/picocolors/v/1.1.1)                                                                      | 1.1.1   | ISC                                 | Development | Transitive |
| [picomatch](https://www.npmjs.com/package/picomatch/v/4.0.7)                                                                        | 4.0.7   | MIT                                 | Development | Transitive |
| [pkce-challenge](https://www.npmjs.com/package/pkce-challenge/v/5.0.1)                                                              | 5.0.1   | MIT                                 | Development | Transitive |
| [pluralize](https://www.npmjs.com/package/pluralize/v/8.0.0)                                                                        | 8.0.0   | MIT                                 | Development | Transitive |
| [postcss](https://www.npmjs.com/package/postcss/v/8.5.28)                                                                           | 8.5.28  | MIT                                 | Development | Transitive |
| [prebuild-install](https://www.npmjs.com/package/prebuild-install/v/7.1.3)                                                          | 7.1.3   | MIT                                 | Development | Transitive |
| [prelude-ls](https://www.npmjs.com/package/prelude-ls/v/1.2.1)                                                                      | 1.2.1   | MIT                                 | Development | Transitive |
| [pump](https://www.npmjs.com/package/pump/v/3.0.4)                                                                                  | 3.0.4   | MIT                                 | Development | Transitive |
| [punycode](https://www.npmjs.com/package/punycode/v/2.3.1)                                                                          | 2.3.1   | MIT                                 | Development | Transitive |
| [punycode.js](https://www.npmjs.com/package/punycode.js/v/2.3.1)                                                                    | 2.3.1   | MIT                                 | Development | Transitive |
| [qs](https://www.npmjs.com/package/qs/v/6.16.0)                                                                                     | 6.16.0  | BSD-3-Clause                        | Development | Transitive |
| [queue-microtask](https://www.npmjs.com/package/queue-microtask/v/1.2.3)                                                            | 1.2.3   | MIT                                 | Development | Transitive |
| [rc](https://www.npmjs.com/package/rc/v/1.2.8)                                                                                      | 1.2.8   | (BSD-2-Clause OR MIT OR Apache-2.0) | Development | Transitive |
| [rc-config-loader](https://www.npmjs.com/package/rc-config-loader/v/4.1.4)                                                          | 4.1.4   | MIT                                 | Development | Transitive |
| [read](https://www.npmjs.com/package/read/v/1.0.7)                                                                                  | 1.0.7   | ISC                                 | Development | Transitive |
| [read-pkg](https://www.npmjs.com/package/read-pkg/v/9.0.1)                                                                          | 9.0.1   | MIT                                 | Development | Transitive |
| [unicorn-magic](https://www.npmjs.com/package/unicorn-magic/v/0.1.0)                                                                | 0.1.0   | MIT                                 | Development | Transitive |
| [readable-stream](https://www.npmjs.com/package/readable-stream/v/3.6.2)                                                            | 3.6.2   | MIT                                 | Development | Transitive |
| [require-from-string](https://www.npmjs.com/package/require-from-string/v/2.0.2)                                                    | 2.0.2   | MIT                                 | Development | Transitive |
| [reusify](https://www.npmjs.com/package/reusify/v/1.1.0)                                                                            | 1.1.0   | MIT                                 | Development | Transitive |
| [rollup](https://www.npmjs.com/package/rollup/v/4.63.1)                                                                             | 4.63.1  | MIT                                 | Development | Transitive |
| [run-applescript](https://www.npmjs.com/package/run-applescript/v/7.1.0)                                                            | 7.1.0   | MIT                                 | Development | Transitive |
| [run-parallel](https://www.npmjs.com/package/run-parallel/v/1.2.0)                                                                  | 1.2.0   | MIT                                 | Development | Transitive |
| [safe-buffer](https://www.npmjs.com/package/safe-buffer/v/5.2.1)                                                                    | 5.2.1   | MIT                                 | Development | Transitive |
| [safer-buffer](https://www.npmjs.com/package/safer-buffer/v/2.1.2)                                                                  | 2.1.2   | MIT                                 | Development | Transitive |
| [sax](https://www.npmjs.com/package/sax/v/1.6.1)                                                                                    | 1.6.1   | BlueOak-1.0.0                       | Development | Transitive |
| [secretlint](https://www.npmjs.com/package/secretlint/v/10.2.2)                                                                     | 10.2.2  | MIT                                 | Development | Transitive |
| [semver](https://www.npmjs.com/package/semver/v/7.8.5)                                                                              | 7.8.5   | ISC                                 | Development | Transitive |
| [shebang-command](https://www.npmjs.com/package/shebang-command/v/2.0.0)                                                            | 2.0.0   | MIT                                 | Development | Transitive |
| [shebang-regex](https://www.npmjs.com/package/shebang-regex/v/3.0.0)                                                                | 3.0.0   | MIT                                 | Development | Transitive |
| [side-channel](https://www.npmjs.com/package/side-channel/v/1.1.1)                                                                  | 1.1.1   | MIT                                 | Development | Transitive |
| [side-channel-list](https://www.npmjs.com/package/side-channel-list/v/1.0.1)                                                        | 1.0.1   | MIT                                 | Development | Transitive |
| [side-channel-map](https://www.npmjs.com/package/side-channel-map/v/1.0.1)                                                          | 1.0.1   | MIT                                 | Development | Transitive |
| [side-channel-weakmap](https://www.npmjs.com/package/side-channel-weakmap/v/1.0.2)                                                  | 1.0.2   | MIT                                 | Development | Transitive |
| [siginfo](https://www.npmjs.com/package/siginfo/v/2.0.0)                                                                            | 2.0.0   | ISC                                 | Development | Transitive |
| [simple-concat](https://www.npmjs.com/package/simple-concat/v/1.0.1)                                                                | 1.0.1   | MIT                                 | Development | Transitive |
| [simple-get](https://www.npmjs.com/package/simple-get/v/4.0.1)                                                                      | 4.0.1   | MIT                                 | Development | Transitive |
| [slash](https://www.npmjs.com/package/slash/v/5.1.0)                                                                                | 5.1.0   | MIT                                 | Development | Transitive |
| [slice-ansi](https://www.npmjs.com/package/slice-ansi/v/4.0.0)                                                                      | 4.0.0   | MIT                                 | Development | Transitive |
| [source-map-js](https://www.npmjs.com/package/source-map-js/v/1.2.1)                                                                | 1.2.1   | BSD-3-Clause                        | Development | Transitive |
| [spdx-correct](https://www.npmjs.com/package/spdx-correct/v/3.2.0)                                                                  | 3.2.0   | Apache-2.0                          | Development | Transitive |
| [spdx-exceptions](https://www.npmjs.com/package/spdx-exceptions/v/2.5.0)                                                            | 2.5.0   | CC-BY-3.0                           | Development | Transitive |
| [spdx-expression-parse](https://www.npmjs.com/package/spdx-expression-parse/v/3.0.1)                                                | 3.0.1   | MIT                                 | Development | Transitive |
| [spdx-license-ids](https://www.npmjs.com/package/spdx-license-ids/v/3.0.23)                                                         | 3.0.23  | CC0-1.0                             | Development | Transitive |
| [stackback](https://www.npmjs.com/package/stackback/v/0.0.2)                                                                        | 0.0.2   | MIT                                 | Development | Transitive |
| [std-env](https://www.npmjs.com/package/std-env/v/3.10.0)                                                                           | 3.10.0  | MIT                                 | Development | Transitive |
| [string_decoder](https://www.npmjs.com/package/string_decoder/v/1.3.0)                                                              | 1.3.0   | MIT                                 | Development | Transitive |
| [string-width](https://www.npmjs.com/package/string-width/v/4.2.3)                                                                  | 4.2.3   | MIT                                 | Development | Transitive |
| [ansi-regex](https://www.npmjs.com/package/ansi-regex/v/5.0.1)                                                                      | 5.0.1   | MIT                                 | Development | Transitive |
| [strip-ansi](https://www.npmjs.com/package/strip-ansi/v/6.0.1)                                                                      | 6.0.1   | MIT                                 | Development | Transitive |
| [strip-ansi](https://www.npmjs.com/package/strip-ansi/v/7.2.0)                                                                      | 7.2.0   | MIT                                 | Development | Transitive |
| [strip-json-comments](https://www.npmjs.com/package/strip-json-comments/v/2.0.1)                                                    | 2.0.1   | MIT                                 | Development | Transitive |
| [strip-literal](https://www.npmjs.com/package/strip-literal/v/3.1.0)                                                                | 3.1.0   | MIT                                 | Development | Transitive |
| [structured-source](https://www.npmjs.com/package/structured-source/v/4.0.0)                                                        | 4.0.0   | BSD-2-Clause                        | Development | Transitive |
| [supports-color](https://www.npmjs.com/package/supports-color/v/7.2.0)                                                              | 7.2.0   | MIT                                 | Development | Transitive |
| [supports-hyperlinks](https://www.npmjs.com/package/supports-hyperlinks/v/3.2.0)                                                    | 3.2.0   | MIT                                 | Development | Transitive |
| [table](https://www.npmjs.com/package/table/v/6.9.0)                                                                                | 6.9.0   | BSD-3-Clause                        | Development | Transitive |
| [ajv](https://www.npmjs.com/package/ajv/v/8.20.0)                                                                                   | 8.20.0  | MIT                                 | Development | Transitive |
| [ansi-regex](https://www.npmjs.com/package/ansi-regex/v/5.0.1)                                                                      | 5.0.1   | MIT                                 | Development | Transitive |
| [json-schema-traverse](https://www.npmjs.com/package/json-schema-traverse/v/1.0.0)                                                  | 1.0.0   | MIT                                 | Development | Transitive |
| [strip-ansi](https://www.npmjs.com/package/strip-ansi/v/6.0.1)                                                                      | 6.0.1   | MIT                                 | Development | Transitive |
| [tar-fs](https://www.npmjs.com/package/tar-fs/v/2.1.5)                                                                              | 2.1.5   | MIT                                 | Development | Transitive |
| [tar-stream](https://www.npmjs.com/package/tar-stream/v/2.2.0)                                                                      | 2.2.0   | MIT                                 | Development | Transitive |
| [terminal-link](https://www.npmjs.com/package/terminal-link/v/4.0.0)                                                                | 4.0.0   | MIT                                 | Development | Transitive |
| [text-table](https://www.npmjs.com/package/text-table/v/0.2.0)                                                                      | 0.2.0   | MIT                                 | Development | Transitive |
| [textextensions](https://www.npmjs.com/package/textextensions/v/6.11.0)                                                             | 6.11.0  | Artistic-2.0                        | Development | Transitive |
| [tinybench](https://www.npmjs.com/package/tinybench/v/2.9.0)                                                                        | 2.9.0   | MIT                                 | Development | Transitive |
| [tinyexec](https://www.npmjs.com/package/tinyexec/v/0.3.2)                                                                          | 0.3.2   | MIT                                 | Development | Transitive |
| [tinyglobby](https://www.npmjs.com/package/tinyglobby/v/0.2.17)                                                                     | 0.2.17  | MIT                                 | Development | Transitive |
| [tinypool](https://www.npmjs.com/package/tinypool/v/1.1.1)                                                                          | 1.1.1   | MIT                                 | Development | Transitive |
| [tinyrainbow](https://www.npmjs.com/package/tinyrainbow/v/2.0.0)                                                                    | 2.0.0   | MIT                                 | Development | Transitive |
| [tinyspy](https://www.npmjs.com/package/tinyspy/v/4.0.4)                                                                            | 4.0.4   | MIT                                 | Development | Transitive |
| [tmp](https://www.npmjs.com/package/tmp/v/0.2.7)                                                                                    | 0.2.7   | MIT                                 | Development | Transitive |
| [to-regex-range](https://www.npmjs.com/package/to-regex-range/v/5.0.1)                                                              | 5.0.1   | MIT                                 | Development | Transitive |
| [ts-api-utils](https://www.npmjs.com/package/ts-api-utils/v/2.5.0)                                                                  | 2.5.0   | MIT                                 | Development | Transitive |
| [tslib](https://www.npmjs.com/package/tslib/v/2.8.1)                                                                                | 2.8.1   | 0BSD                                | Development | Transitive |
| [tunnel](https://www.npmjs.com/package/tunnel/v/0.0.6)                                                                              | 0.0.6   | MIT                                 | Development | Transitive |
| [tunnel-agent](https://www.npmjs.com/package/tunnel-agent/v/0.6.0)                                                                  | 0.6.0   | Apache-2.0                          | Development | Transitive |
| [type-check](https://www.npmjs.com/package/type-check/v/0.4.0)                                                                      | 0.4.0   | MIT                                 | Development | Transitive |
| [type-fest](https://www.npmjs.com/package/type-fest/v/4.41.0)                                                                       | 4.41.0  | (MIT OR CC0-1.0)                    | Development | Transitive |
| [typed-rest-client](https://www.npmjs.com/package/typed-rest-client/v/1.8.11)                                                       | 1.8.11  | MIT                                 | Development | Transitive |
| [uc.micro](https://www.npmjs.com/package/uc.micro/v/2.1.0)                                                                          | 2.1.0   | MIT                                 | Development | Transitive |
| [underscore](https://www.npmjs.com/package/underscore/v/1.13.8)                                                                     | 1.13.8  | MIT                                 | Development | Transitive |
| [undici](https://www.npmjs.com/package/undici/v/7.29.1)                                                                             | 7.29.1  | MIT                                 | Development | Transitive |
| [undici-types](https://www.npmjs.com/package/undici-types/v/6.21.0)                                                                 | 6.21.0  | MIT                                 | Development | Transitive |
| [unicorn-magic](https://www.npmjs.com/package/unicorn-magic/v/0.3.0)                                                                | 0.3.0   | MIT                                 | Development | Transitive |
| [universalify](https://www.npmjs.com/package/universalify/v/2.0.1)                                                                  | 2.0.1   | MIT                                 | Development | Transitive |
| [uri-js](https://www.npmjs.com/package/uri-js/v/4.4.1)                                                                              | 4.4.1   | BSD-2-Clause                        | Development | Transitive |
| [url-join](https://www.npmjs.com/package/url-join/v/4.0.1)                                                                          | 4.0.1   | MIT                                 | Development | Transitive |
| [util-deprecate](https://www.npmjs.com/package/util-deprecate/v/1.0.2)                                                              | 1.0.2   | MIT                                 | Development | Transitive |
| [validate-npm-package-license](https://www.npmjs.com/package/validate-npm-package-license/v/3.0.4)                                  | 3.0.4   | Apache-2.0                          | Development | Transitive |
| [version-range](https://www.npmjs.com/package/version-range/v/4.15.0)                                                               | 4.15.0  | Artistic-2.0                        | Development | Transitive |
| [vite](https://www.npmjs.com/package/vite/v/7.3.6)                                                                                  | 7.3.6   | MIT                                 | Development | Transitive |
| [vite-node](https://www.npmjs.com/package/vite-node/v/3.2.4)                                                                        | 3.2.4   | MIT                                 | Development | Transitive |
| [whatwg-encoding](https://www.npmjs.com/package/whatwg-encoding/v/3.1.1)                                                            | 3.1.1   | MIT                                 | Development | Transitive |
| [whatwg-mimetype](https://www.npmjs.com/package/whatwg-mimetype/v/4.0.0)                                                            | 4.0.0   | MIT                                 | Development | Transitive |
| [which](https://www.npmjs.com/package/which/v/2.0.2)                                                                                | 2.0.2   | ISC                                 | Development | Transitive |
| [why-is-node-running](https://www.npmjs.com/package/why-is-node-running/v/2.3.0)                                                    | 2.3.0   | MIT                                 | Development | Transitive |
| [word-wrap](https://www.npmjs.com/package/word-wrap/v/1.2.5)                                                                        | 1.2.5   | MIT                                 | Development | Transitive |
| [wrappy](https://www.npmjs.com/package/wrappy/v/1.0.2)                                                                              | 1.0.2   | ISC                                 | Development | Transitive |
| [wsl-utils](https://www.npmjs.com/package/wsl-utils/v/0.1.0)                                                                        | 0.1.0   | MIT                                 | Development | Transitive |
| [xml2js](https://www.npmjs.com/package/xml2js/v/0.5.0)                                                                              | 0.5.0   | MIT                                 | Development | Transitive |
| [xmlbuilder](https://www.npmjs.com/package/xmlbuilder/v/11.0.1)                                                                     | 11.0.1  | MIT                                 | Development | Transitive |
| [yallist](https://www.npmjs.com/package/yallist/v/4.0.0)                                                                            | 4.0.0   | ISC                                 | Development | Transitive |
| [yauzl](https://www.npmjs.com/package/yauzl/v/3.4.0)                                                                                | 3.4.0   | MIT                                 | Development | Transitive |
| [yazl](https://www.npmjs.com/package/yazl/v/2.5.1)                                                                                  | 2.5.1   | MIT                                 | Development | Transitive |
| [yocto-queue](https://www.npmjs.com/package/yocto-queue/v/0.1.0)                                                                    | 0.1.0   | MIT                                 | Development | Transitive |

## 独自ライセンスの開発ツール / Development tools under separate proprietary terms

以下の署名ツールは Microsoft 独自の利用条件が適用され、OSS としては分類していません。VSCE の開発依存経由で参照されるもので、AgentPickLink の実行時依存や配布 VSIX には含めません。利用条件はインストールされた各パッケージの LICENSE.txt を参照してください。
The following signing tools use Microsoft Software License Terms and are not classified here as OSS. They are referenced through the VSCE development dependency and are not AgentPickLink runtime dependencies or included in its VSIX. See each installed package's LICENSE.txt for the applicable terms.

| Package                                                                                                | Version | License                    | Scope       | Dependency |
| ------------------------------------------------------------------------------------------------------ | ------- | -------------------------- | ----------- | ---------- |
| [@vscode/vsce-sign](https://www.npmjs.com/package/@vscode/vsce-sign/v/2.1.0)                           | 2.1.0   | SEE LICENSE IN LICENSE.txt | Development | Transitive |
| [@vscode/vsce-sign-alpine-arm64](https://www.npmjs.com/package/@vscode/vsce-sign-alpine-arm64/v/2.0.6) | 2.0.6   | SEE LICENSE IN LICENSE.txt | Development | Transitive |
| [@vscode/vsce-sign-alpine-x64](https://www.npmjs.com/package/@vscode/vsce-sign-alpine-x64/v/2.0.6)     | 2.0.6   | SEE LICENSE IN LICENSE.txt | Development | Transitive |
| [@vscode/vsce-sign-darwin-arm64](https://www.npmjs.com/package/@vscode/vsce-sign-darwin-arm64/v/2.0.6) | 2.0.6   | SEE LICENSE IN LICENSE.txt | Development | Transitive |
| [@vscode/vsce-sign-darwin-x64](https://www.npmjs.com/package/@vscode/vsce-sign-darwin-x64/v/2.0.6)     | 2.0.6   | SEE LICENSE IN LICENSE.txt | Development | Transitive |
| [@vscode/vsce-sign-linux-arm](https://www.npmjs.com/package/@vscode/vsce-sign-linux-arm/v/2.0.6)       | 2.0.6   | SEE LICENSE IN LICENSE.txt | Development | Transitive |
| [@vscode/vsce-sign-linux-arm64](https://www.npmjs.com/package/@vscode/vsce-sign-linux-arm64/v/2.0.6)   | 2.0.6   | SEE LICENSE IN LICENSE.txt | Development | Transitive |
| [@vscode/vsce-sign-linux-x64](https://www.npmjs.com/package/@vscode/vsce-sign-linux-x64/v/2.0.6)       | 2.0.6   | SEE LICENSE IN LICENSE.txt | Development | Transitive |
| [@vscode/vsce-sign-win32-arm64](https://www.npmjs.com/package/@vscode/vsce-sign-win32-arm64/v/2.0.6)   | 2.0.6   | SEE LICENSE IN LICENSE.txt | Development | Transitive |
| [@vscode/vsce-sign-win32-x64](https://www.npmjs.com/package/@vscode/vsce-sign-win32-x64/v/2.0.6)       | 2.0.6   | SEE LICENSE IN LICENSE.txt | Development | Transitive |

## 実行環境 / External runtimes

Node.js、VS Code、Microsoft Edge / Google Chrome は、この npm 依存一覧とは別の実行環境です。利用者の環境にあるものを使用し、インストーラーやブラウザー本体をこの VSIX で再配布しません。各製品のライセンスと第三者通知は、それぞれの配布元が提供するものを参照してください。
Node.js, VS Code, and Microsoft Edge / Google Chrome are external runtimes, separate from this npm inventory. Their installers and browser binaries are not redistributed in this VSIX. Refer to the respective distributions for their terms and third-party notices.

## 一覧の更新 / Regeneration

<code>npm ci</code> の後に <code>npm run oss:generate</code> を実行します。実行時パッケージのバージョンが lockfile と一致しない場合は生成を停止します。
Run <code>npm ci</code> followed by <code>npm run oss:generate</code>. Generation fails if installed runtime versions differ from the lockfile.
