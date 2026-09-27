import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../src/transports/browser/markdown-converter.js";

/**
 * APL-REVIEW-01 (docs/v0.2.2-review-fixes.md): the converter must hand another model exactly the
 * text the agent wrote. Every case compares the complete expected string -- a non-empty or
 * `toContain` check would not have caught `Array<string>` turning into `Array`.
 */
type Case = [name: string, html: string, markdown: string];

const REVIEW_CASES: Case[] = [
  [
    "keeps generics and comparisons inside a code block",
    "<pre><code>const x: Array&lt;string&gt; = [];\nif (a &lt; b &amp;&amp; c &gt; d) return true;</code></pre>",
    "```\nconst x: Array<string> = [];\nif (a < b && c > d) return true;\n```"
  ],
  [
    "keeps HTML tags written inside inline code",
    "<p>Wrap it in <code>&lt;div&gt;hello&lt;/div&gt;</code> first.</p>",
    "Wrap it in `<div>hello</div>` first."
  ],
  [
    "keeps an escaped script tag as text instead of an empty code block",
    "<p>Never emit <code>&lt;script&gt;</code> tags.</p><pre><code>&lt;script&gt;</code></pre>",
    "Never emit `<script>` tags.\n\n```\n<script>\n```"
  ]
];

const TEXT_CASES: Case[] = [
  [
    "keeps comparisons and generics in paragraphs",
    "<p>If a &lt; b and c &gt; d, use List&lt;T&gt;.</p>",
    "If a < b and c > d, use List<T>."
  ],
  ["keeps generics in headings", "<h3>Map&lt;K, V&gt; &amp; Set&lt;T&gt;</h3>", "### Map<K, V> & Set<T>"],
  [
    "keeps comparisons and generics in list items",
    "<ul><li>x &lt; y</li><li><code>Array&lt;number&gt;</code> works</li></ul>",
    "- x < y\n- `Array<number>` works"
  ],
  [
    "keeps HTML examples written as prose",
    '<p>Use &lt;br&gt; or &lt;div class="x"&gt;</p>',
    'Use <br> or <div class="x">'
  ],
  [
    "keeps HTML inside a fenced block with its language",
    '<pre><code class="language-html">&lt;!doctype html&gt;\n&lt;p class="note"&gt;Hi &amp;amp; bye&lt;/p&gt;\n</code></pre>',
    '```html\n<!doctype html>\n<p class="note">Hi &amp; bye</p>\n```'
  ],
  [
    "flattens syntax-highlighting spans without losing text",
    '<pre><code class="language-ts"><span class="kw">const</span> s = <span class="str">"&lt;a&gt;"</span>;</code></pre>',
    '```ts\nconst s = "<a>";\n```'
  ],
  [
    "keeps indentation, blank lines and trailing spaces inside code",
    "<pre><code>function f() {\n    return 1;  \n\n}\n</code></pre>",
    "```\nfunction f() {\n    return 1;  \n\n}\n```"
  ],
  [
    "treats a bare pre as code and drops only the newline HTML ignores after <pre>",
    "<pre>\n  indented\n\ttab</pre>",
    "```\n  indented\n\ttab\n```"
  ],
  [
    "keeps a language label rendered beside a code block and drops the copy button",
    '<div class="code-block"><div class="header"><span>typescript</span><button aria-label="Copy">Copy</button></div><pre><code class="language-typescript"><span class="hljs-keyword">const</span> ok = a &lt; b;</code></pre></div>',
    "typescript\n\n```typescript\nconst ok = a < b;\n```"
  ]
];

const ENTITY_CASES: Case[] = [
  ["decodes a double-escaped entity only once", "<p>&amp;lt;tag&amp;gt; &amp;amp;</p>", "&lt;tag&gt; &amp;"],
  [
    "decodes numeric and quote references",
    "<p>&#60; &#x3C; &#X3e; &quot;q&quot; &#39;s&#39; &apos;a&apos;</p>",
    "< < > \"q\" 's' 'a'"
  ],
  [
    "decodes common named references and leaves unknown ones as written",
    "<p>&copy; &hellip; &unknown; &#0; &#xD800;</p>",
    "© … &unknown; \uFFFD \uFFFD"
  ],
  ["turns a non-breaking space entity into a space", "<p>a&nbsp;b</p>", "a b"],
  ["decodes code once", "<pre><code>&amp;lt; &amp;amp;&amp;gt;</code></pre>", "```\n&lt; &amp;&gt;\n```"],
  [
    "decodes attribute values once",
    '<p><a href="https://example.com/search?q=a&amp;b=c">link</a></p>',
    "[link](https://example.com/search?q=a&b=c)"
  ]
];

const BACKTICK_CASES: Case[] = [
  ["lengthens the inline fence around a backtick", "<p><code>a`b</code></p>", "``a`b``"],
  ["pads an inline fence next to a leading backtick", "<p><code>`tick</code></p>", "`` `tick ``"],
  ["handles inline code made only of backticks", "<p><code>``</code></p>", "``` `` ```"],
  ["turns newlines in inline code into spaces", "<p><code>a\nb</code></p>", "`a b`"],
  [
    "lengthens a block fence around a nested fence",
    "<pre><code>```js\nconsole.log(1)\n```\n</code></pre>",
    "````\n```js\nconsole.log(1)\n```\n````"
  ],
  [
    "keeps the minimum block fence when code has a single backtick run",
    '<pre><code class="language-md">Use `x` here</code></pre>',
    "```md\nUse `x` here\n```"
  ]
];

const LIST_AND_TABLE_CASES: Case[] = [
  [
    "indents nested unordered lists",
    "<ul><li>One<ul><li>Sub A</li><li>Sub B<ul><li>Deep</li></ul></li></ul></li><li>Two</li></ul>",
    "- One\n  - Sub A\n  - Sub B\n    - Deep\n- Two"
  ],
  [
    "numbers ordered lists from start and indents to the marker width",
    '<ol start="3"><li>Third</li><li>Fourth<ol><li>Inner</li></ol></li></ol>',
    "3. Third\n4. Fourth\n   1. Inner"
  ],
  ["honors an li value", '<ol><li>a</li><li value="10">b</li><li>c</li></ol>', "1. a\n10. b\n11. c"],
  [
    "keeps paragraphs of a loose list separate",
    "<ul><li><p>Para 1</p><p>Para 2</p></li><li><p>Next</p></li></ul>",
    "- Para 1\n\n  Para 2\n\n- Next"
  ],
  [
    "indents a code block inside a list item",
    "<ol><li>Install:<pre><code>npm ci\nnpm test\n</code></pre></li><li>Done</li></ol>",
    "1. Install:\n   ```\n   npm ci\n   npm test\n   ```\n2. Done"
  ],
  [
    "renders task list checkboxes",
    '<ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox" disabled> todo</li></ul>',
    "- [x] done\n- [ ] todo"
  ],
  [
    "renders a table with escaped pipes and code",
    "<table><thead><tr><th>Type</th><th>Example</th></tr></thead><tbody><tr><td>Generic</td><td><code>List&lt;int&gt;</code></td></tr><tr><td>a | b</td><td>x &amp;&amp; y &lt; z</td></tr></tbody></table>",
    "| Type | Example |\n| --- | --- |\n| Generic | `List<int>` |\n| a \\| b | x && y < z |"
  ],
  [
    "escapes pipes inside code in a table cell",
    "<table><tr><th>Expr</th></tr><tr><td><code>a || b</code></td></tr></table>",
    "| Expr |\n| --- |\n| `a \\|\\| b` |"
  ],
  [
    "keeps line breaks and nested lists inside table cells",
    "<table><tr><th>Step</th><th>Notes</th></tr><tr><td>1</td><td>a<br>b</td></tr><tr><td>2</td><td><ul><li>x</li><li>y</li></ul></td></tr></table>",
    "| Step | Notes |\n| --- | --- |\n| 1 | a<br>b |\n| 2 | - x<br>- y |"
  ],
  [
    "keeps column alignment, colspans and short rows",
    '<table><thead><tr><th style="text-align: right">Qty</th><th align="center">Item</th><th>Note</th></tr></thead><tbody><tr><td colspan="2">merged</td><td>n</td></tr><tr><td>1</td></tr></tbody></table>',
    "| Qty | Item | Note |\n| ---: | :---: | --- |\n| merged |  | n |\n| 1 |  |  |"
  ],
  [
    "puts a table caption before the table",
    "<table><caption>Totals</caption><tr><th>A</th></tr><tr><td>1</td></tr></table>",
    "Totals\n\n| A |\n| --- |\n| 1 |"
  ]
];

const STRUCTURE_CASES: Case[] = [
  [
    "converts headings, paragraphs, inline code and lists, dropping scripts",
    "<h2>Answer</h2><p>Hello <code>world</code></p><ul><li>One</li></ul><script>secret()</script>",
    "## Answer\n\nHello `world`\n\n- One"
  ],
  ["drops a leading script", "<script>secret()</script>Hi", "Hi"],
  [
    "keeps Japanese paragraphs",
    "<p>これは日本語の回答です。</p><p>次の段落です。</p>",
    "これは日本語の回答です。\n\n次の段落です。"
  ],
  [
    "keeps soft line breaks and turns <br> into a newline",
    "<p>line one\nline two<br>line three</p>",
    "line one\nline two\nline three"
  ],
  [
    "ignores formatting whitespace between blocks",
    "<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>\n<p>\n  text\n</p>\n",
    "- a\n- b\n\ntext"
  ],
  [
    "quotes every line of a blockquote",
    "<blockquote><p>Quoted &lt;x&gt;</p><p>Second</p></blockquote>",
    "> Quoted <x>\n>\n> Second"
  ],
  ["renders a horizontal rule", "<p>a</p><hr><p>b</p>", "a\n\n---\n\nb"],
  [
    "renders emphasis and moves edge spaces outside the markers",
    "<p><strong>bold &lt;b&gt;</strong>, <em>it</em>, <del>gone</del>, <strong> spaced </strong>x</p>",
    "**bold <b>**, *it*, ~~gone~~,  **spaced** x"
  ],
  ["does not nest the same emphasis", "<p><strong>a <b>b</b></strong></p>", "**a b**"],
  ["drops emphasis around whitespace", "<p>x<strong> </strong>y</p>", "x y"],
  [
    "links only credential-free absolute https URLs",
    '<p>See <a href="https://example.com/docs">the docs</a>, <a href="http://insecure.example">plain</a>, <a href="javascript:alert(1)">js</a>, <a href="/relative">rel</a>, <a href="https://user:pw@example.com/">cred</a>.</p>',
    "See [the docs](https://example.com/docs), plain, js, rel, cred."
  ],
  [
    "wraps a destination that contains parentheses",
    '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a></p>',
    "[Foo](<https://en.wikipedia.org/wiki/Foo_(bar)>)"
  ],
  [
    "keeps inline code inside a link",
    '<p><a href="https://x.test/"><code>fn()</code></a></p>',
    "[`fn()`](https://x.test/)"
  ],
  [
    "drops hidden, decorative and interactive content",
    '<p>A<span aria-hidden="true">X</span><span hidden>Y</span><button>Copy</button><img src="x.png" alt="pic"><svg><text>S</text></svg><style>p{}</style>B</p>',
    "AB"
  ],
  [
    "keeps content whose class name merely contains hidden",
    '<div class="overflow-hidden"><p>kept</p></div><span class="visually-hidden-focusable">also kept</span>',
    "kept\n\nalso kept"
  ],
  ["drops comments", "<!-- note --><p>x<!-- y -->z</p>", "xz"],
  ["closes an implied paragraph", "<p>a<p>b", "a\n\nb"],
  ["closes implied list items", "<ul><li>one<li>two</ul>", "- one\n- two"],
  ["keeps a bare less-than sign", "a < b", "a < b"],
  ["renders definition lists as blocks", "<dl><dt>Term</dt><dd>Definition</dd></dl>", "Term\n\nDefinition"],
  [
    "splits inline runs around nested blocks",
    "<div>Intro <strong>bold</strong><p>Para</p>tail</div>",
    "Intro **bold**\n\nPara\n\ntail"
  ],
  [
    "uses the TeX annotation of rendered math",
    '<p>Energy <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">E=mc2</span></span> holds.</p>',
    "Energy $E=mc^2$ holds."
  ],
  [
    "renders display math as a block",
    '<p>Before</p><math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math><p>After</p>',
    "Before\n\n$$\nx^2\n$$\n\nAfter"
  ]
];

describe("htmlToMarkdown", () => {
  describe("APL-REVIEW-01 reproduction", () => {
    it.each(REVIEW_CASES)("%s", (_name, html, markdown) => expect(htmlToMarkdown(html)).toBe(markdown));
  });
  describe("text that looks like markup", () => {
    it.each(TEXT_CASES)("%s", (_name, html, markdown) => expect(htmlToMarkdown(html)).toBe(markdown));
  });
  describe("character references", () => {
    it.each(ENTITY_CASES)("%s", (_name, html, markdown) => expect(htmlToMarkdown(html)).toBe(markdown));
  });
  describe("backticks", () => {
    it.each(BACKTICK_CASES)("%s", (_name, html, markdown) => expect(htmlToMarkdown(html)).toBe(markdown));
  });
  describe("lists and tables", () => {
    it.each(LIST_AND_TABLE_CASES)("%s", (_name, html, markdown) =>
      expect(htmlToMarkdown(html)).toBe(markdown)
    );
  });
  describe("structure", () => {
    it.each(STRUCTURE_CASES)("%s", (_name, html, markdown) => expect(htmlToMarkdown(html)).toBe(markdown));
  });

  it("returns an empty string for empty or markup-only input", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("<div><span></span></div>")).toBe("");
  });

  it("keeps all text of deeply nested markup without overflowing the stack", () => {
    const depth = 5_000;
    const html = `${"<div>".repeat(depth)}deep &lt;text&gt;${"</div>".repeat(depth)}`;
    expect(htmlToMarkdown(html)).toBe("deep <text>");
    const quotes = `${"<blockquote>".repeat(depth)}q${"</blockquote>".repeat(depth)}`;
    expect(() => htmlToMarkdown(quotes)).not.toThrow();
    expect(htmlToMarkdown(quotes)).toContain("q");
  });

  it("converts a large reply in linear time", () => {
    const paragraph = "<p>Row &lt;T&gt; with <code>a &lt; b</code> and <strong>bold</strong>.</p>";
    const html = paragraph.repeat(20_000);
    const started = performance.now();
    const markdown = htmlToMarkdown(html);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(markdown.split("\n\n")).toHaveLength(20_000);
    expect(markdown.startsWith("Row <T> with `a < b` and **bold**.")).toBe(true);
  });

  it("does not hang on unterminated markup", () => {
    expect(htmlToMarkdown('<p>text <a href="https://x.test/')).toBe("text");
    expect(htmlToMarkdown("<p>text <!-- never closed")).toBe("text");
    expect(htmlToMarkdown("<pre><code>open code")).toBe("```\nopen code\n```");
  });
});
