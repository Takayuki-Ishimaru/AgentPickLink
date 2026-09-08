// Generate the public dependency inventory from the lockfile and installed package notices.
// Run npm ci first. Does not fetch data or change third-party license files.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const entries = Object.entries(lock.packages)
  .filter(([location]) => location)
  .map(([location, value]) => ({
    location,
    name: location.split("node_modules/").at(-1),
    ...value
  }))
  .sort((a, b) => a.location.localeCompare(b.location, "en"));
const custom = entries.filter((entry) => entry.name.startsWith("@vscode/vsce-sign"));
const oss = entries.filter((entry) => !custom.includes(entry));
const direct = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
const link = (entry) => `[${entry.name}](https://www.npmjs.com/package/${entry.name}/v/${entry.version})`;
const scope = (entry) => (entry.dev ? "Development" : "Runtime");
const row = (entry) =>
  `| ${link(entry)} | ${entry.version} | ${entry.license} | ${scope(entry)} | ${entry.location === `node_modules/${entry.name}` && direct.has(entry.name) ? "Direct" : "Transitive"} |`;
const header = "| Package | Version | License | Scope | Dependency |\n| --- | --- | --- | --- | --- |";

async function noticeFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      files.push(...(await noticeFiles(path.join(directory, entry.name), relative + "/")));
    else if (/license|licence|notice|copying|copyright/i.test(entry.name)) files.push(relative);
  }
  return files.sort();
}

const notices = [
  "AgentPickLink for M365 — Third-party notices",
  "The AgentPickLink project is MIT licensed. The following third-party works retain their original terms.",
  "Runtime package notices and bundled third-party notices are reproduced verbatim below."
];
const bundled = new Map();
for (const entry of entries.filter((entry) => !entry.dev)) {
  const directory = path.join(root, entry.location);
  const installed = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  assert.equal(
    installed.version,
    entry.version,
    `Run npm ci: ${entry.location} version differs from lockfile`
  );
  const files = await noticeFiles(directory);
  assert.ok(files.length > 0, `Missing runtime license text: ${entry.name}`);
  for (const file of files) {
    const content = await readFile(path.join(directory, file), "utf8");
    notices.push(
      `\n${"=".repeat(80)}\n${entry.name}@${entry.version} — ${file}\nLicense declaration: ${entry.license}\n${"=".repeat(80)}\n\n${content}`
    );
    if (entry.name === "playwright-core") {
      for (const match of content.matchAll(/^- (.+)@([^\s]+) \((https:\/\/[^)]+)\)$/gm)) {
        const [, name, version, url] = match;
        bundled.set(`${name}@${version}`, { name, version, url });
      }
    }
  }
}

const inventory = `# 利用 OSS・第三者ソフトウェア / Open-source and third-party software

[日本語 README](README.md) | [English README](README.en.md)

AgentPickLink 本体は [MIT ライセンス](../LICENSE) の OSS です。依存ソフトウェアのライセンスは変更しません。
The AgentPickLink project is MIT licensed. Third-party software retains its original license terms.

この一覧は v${manifest.version} の [package-lock.json](../package-lock.json) に固定されたパッケージ名・バージョン・ライセンス宣言から生成しています。Runtime は実行時依存、Development はビルド・テスト・パッケージ作成用です。間接依存と OS 別の任意依存も含むため、全項目が同時にインストールされたり VSIX に含まれたりするわけではありません。同じパッケージの異なる依存位置は別行です。
This inventory uses the names, pinned versions and license declarations in the lockfile. It includes direct, transitive and platform-specific optional dependencies. Not every entry is installed on every platform or shipped in the VSIX; separate installation paths have separate rows.

実行時に配布するソフトウェアの著作権表示・ライセンス全文・同梱コンポーネントの通知は [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) に収録しています。VSIX 内の各パッケージの LICENSE / NOTICE も保持しています。
Full runtime license texts, copyright notices and bundled component notices are included in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt). Original package license files are also retained in the VSIX.

## 直接利用する OSS / Direct OSS dependencies

MCP SDK はクライアント連携、Playwright はブラウザー操作、Commander は CLI、Zod はデータ検証、YAML は設定の読書き、proper-lockfile はローカルロックに使用します。Development のツールはコンパイル、バンドル、テスト、静的チェック、書式整形、VSIX 作成に使用します。
The MCP SDK provides protocol integration; Playwright controls the browser; Commander handles the CLI; Zod validates data; YAML reads and writes configuration; proper-lockfile manages local locks. Development tools provide compilation, bundling, tests, linting, formatting and VSIX packaging.

${header}
${oss
  .filter((entry) => direct.has(entry.name) && entry.location === `node_modules/${entry.name}`)
  .map(row)
  .join("\n")}

## 実行時の間接依存 / Transitive runtime dependencies

${header}
${oss
  .filter((entry) => !entry.dev && !direct.has(entry.name))
  .map(row)
  .join("\n")}

## Playwright 同梱 OSS / OSS bundled inside Playwright

次は Playwright が配布するバンドル通知から取得した一覧です。lockfile の独立パッケージ一覧には現れないものもあります。各コンポーネントの許諾条件は、全文通知内の対応する名前の節を参照してください。
These entries come from Playwright's bundled notices and may not appear as standalone lockfile packages. See each named section in the full notices for its license terms.

| Component | Version | License text |
| --- | --- | --- |
${[...bundled.values()]
  .sort((a, b) => a.name.localeCompare(b.name, "en"))
  .map(
    (entry) =>
      `| [${entry.name}](${entry.url}) | ${entry.version} | [Bundled notices](THIRD-PARTY-NOTICES.txt) |`
  )
  .join("\n")}
| libwebp | Not specified in bundled notice | BSD-3-Clause and patent grant; [full notice](THIRD-PARTY-NOTICES.txt) |
| Emscripten runtime and included components | Not specified in bundled notice | [WebP codec notices](THIRD-PARTY-NOTICES.txt) |

## 開発用の間接 OSS 依存 / Transitive development OSS dependencies

${header}
${oss
  .filter(
    (entry) => entry.dev && !(direct.has(entry.name) && entry.location === `node_modules/${entry.name}`)
  )
  .map(row)
  .join("\n")}

## 独自ライセンスの開発ツール / Development tools under separate proprietary terms

以下の署名ツールは Microsoft 独自の利用条件が適用され、OSS としては分類していません。VSCE の開発依存経由で参照されるもので、AgentPickLink の実行時依存や配布 VSIX には含めません。利用条件はインストールされた各パッケージの LICENSE.txt を参照してください。
The following signing tools use Microsoft Software License Terms and are not classified here as OSS. They are referenced through the VSCE development dependency and are not AgentPickLink runtime dependencies or included in its VSIX. See each installed package's LICENSE.txt for the applicable terms.

${header}
${custom.map(row).join("\n")}

## 実行環境 / External runtimes

Node.js、VS Code、Microsoft Edge / Google Chrome は、この npm 依存一覧とは別の実行環境です。利用者の環境にあるものを使用し、インストーラーやブラウザー本体をこの VSIX で再配布しません。各製品のライセンスと第三者通知は、それぞれの配布元が提供するものを参照してください。
Node.js, VS Code, and Microsoft Edge / Google Chrome are external runtimes, separate from this npm inventory. Their installers and browser binaries are not redistributed in this VSIX. Refer to the respective distributions for their terms and third-party notices.

## 一覧の更新 / Regeneration

<code>npm ci</code> の後に <code>npm run oss:generate</code> を実行します。実行時パッケージのバージョンが lockfile と一致しない場合は生成を停止します。
Run <code>npm ci</code> followed by <code>npm run oss:generate</code>. Generation fails if installed runtime versions differ from the lockfile.
`;
await writeFile(
  path.join(root, "release-docs", "OSS-LICENSES.md"),
  await format(inventory, { ...(await resolveConfig(root)), parser: "markdown" })
);
await writeFile(path.join(root, "release-docs", "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n") + "\n");
process.stdout.write(
  `Generated inventory: ${entries.length} lockfile entries; ${bundled.size} bundled npm components.\n`
);
