import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { ResponseExtractor } from "../../src/transports/browser/response-extractor.js";
import type { PageLike } from "../../src/transports/browser/types.js";

/**
 * APL-REVIEW-01 through the path the reviewer used: a real Chromium DOM serializes the reply with
 * `innerHTML`, and ResponseExtractor.extract() converts it. The reply markup follows the M365
 * Copilot structure the selectors target; its content is test data, not a captured tenant reply.
 */
const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome"
].find((value): value is string => !!value && existsSync(value));

const REPLY = `
<div role="article" class="fai-CopilotMessage">
  <div data-testid="markdown-reply">
    <p>型の例:</p>
    <div class="code-block">
      <div class="header"><button aria-label="コピー">コピー</button></div>
      <pre><code class="language-typescript">const x: Array&lt;string&gt; = [];
if (a &lt; b &amp;&amp; c &gt; d) return true;</code></pre>
    </div>
    <p>インラインの <code>&lt;div&gt;hello&lt;/div&gt;</code> と、文字列の <code>&lt;script&gt;</code> を残します。</p>
    <pre><code>&lt;script&gt;</code></pre>
    <table>
      <thead><tr><th>種類</th><th>例</th></tr></thead>
      <tbody>
        <tr><td>ジェネリクス</td><td><code>List&lt;int&gt;</code></td></tr>
        <tr><td>比較</td><td>a &lt; b | c &gt; d</td></tr>
      </tbody>
    </table>
    <ul>
      <li>外側 &amp; 説明
        <ul><li>内側 <code>x &gt; 0</code></li></ul>
      </li>
    </ul>
    <p>出典 <a href="https://contoso.sharepoint.com/sites/docs/guide.aspx">ガイド</a></p>
  </div>
</div>`;

const EXPECTED = [
  "型の例:",
  "```typescript\nconst x: Array<string> = [];\nif (a < b && c > d) return true;\n```",
  "インラインの `<div>hello</div>` と、文字列の `<script>` を残します。",
  "```\n<script>\n```",
  "| 種類 | 例 |\n| --- | --- |\n| ジェネリクス | `List<int>` |\n| 比較 | a < b \\| c > d |",
  "- 外側 & 説明\n  - 内側 `x > 0`",
  "出典 [ガイド](https://contoso.sharepoint.com/sites/docs/guide.aspx)"
].join("\n\n");

describe.skipIf(!executable)("ResponseExtractor on a real Chromium DOM", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: executable, headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("returns the reply's code, markup-like text, table and nested list unchanged", async () => {
    await page.setContent(`<!doctype html><html><body><main>${REPLY}</main></body></html>`);
    const result = await new ResponseExtractor().extract(page as unknown as PageLike, { assistantCount: 1 });
    expect(result.text).toBe(EXPECTED);
    expect(result.truncated).toBe(false);
  });
});

describe("ResponseExtractor text fallback", () => {
  it("keeps a text-only payload as plain text instead of parsing it as HTML", async () => {
    const page: PageLike = {
      url: () => "https://m365.cloud.microsoft/chat",
      evaluate: async <T>() => ({ html: "", text: "a < b <c> &amp;\r\n", citations: [] }) as T
    };
    const result = await new ResponseExtractor().extract(page, { assistantCount: 1 });
    expect(result.text).toBe("a < b <c> &amp;");
  });
});
