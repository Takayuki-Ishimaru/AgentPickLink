/**
 * HTML-to-Markdown conversion for one isolated assistant response (normally Chromium `innerHTML`).
 *
 * tokenizer -> element tree -> renderer. Character references are decoded exactly once, while
 * tokenizing; nothing afterwards re-parses, strips or decodes text again, so code, comparisons and
 * markup-like prose reach the caller exactly as the user saw them (APL-REVIEW-01). No DOM, no
 * dependencies: this runs in the broker process on the string the page returned.
 */

type TextNode = { type: "text"; text: string };
type ElementNode = { type: "element"; name: string; attributes: Map<string, string>; children: HtmlNode[] };
type HtmlNode = TextNode | ElementNode;

type Context = {
  /** Emphasis markers already open around this node, so `<strong><b>` does not nest `**`. */
  readonly marks: ReadonlySet<string>;
  /** Inside a GFM table cell: blocks flatten onto one line (see `renderCell`). */
  readonly cell: boolean;
};

const ROOT_CONTEXT: Context = { marks: new Set(), cell: false };
/** Deeper start tags are ignored (their text is kept), which bounds every recursion below. */
const MAX_DEPTH = 256;

// prettier-ignore
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source",
  "track", "wbr"
]);
/** Their content is never markup, and none of it is output. */
// prettier-ignore
const RAW_TEXT_ELEMENTS = new Set([
  "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"
]);
// prettier-ignore
const DROPPED_ELEMENTS = new Set([
  "script", "style", "noscript", "template", "svg", "button", "img", "select", "option", "textarea", "iframe",
  "object", "embed", "video", "audio", "canvas", "head", "title", "meta", "link"
]);
// prettier-ignore
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "dialog", "div",
  "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hgroup", "hr", "html", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "ul"
]);
/** Start tags that close an open `p` that is the current node (HTML's implied `</p>`). */
// prettier-ignore
const CLOSES_PARAGRAPH = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "ul"
]);
// prettier-ignore
const NAMED_REFERENCES = new Map(
  Object.entries({
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", AMP: "&", LT: "<", GT: ">", QUOT: '"',
    // A non-breaking space has always been handed on as a plain space.
    nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘",
    rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹",
    rsaquo: "›", bull: "•", middot: "·", deg: "°", plusmn: "±", times: "×", divide: "÷", micro: "µ",
    para: "¶", sect: "§", cent: "¢", pound: "£", yen: "¥", euro: "€", iexcl: "¡", iquest: "¿",
    shy: "\u00ad", zwj: "\u200d", zwnj: "\u200c", lrm: "\u200e", rlm: "\u200f", ensp: "\u2002",
    emsp: "\u2003", thinsp: "\u2009", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", lArr: "⇐",
    rArr: "⇒", hArr: "⇔", le: "≤", ge: "≥", ne: "≠", asymp: "≈", equiv: "≡", infin: "∞", minus: "−",
    sum: "∑", prod: "∏", radic: "√", check: "✓", cross: "✗", star: "☆"
  })
);
const REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g;
const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/;

export function htmlToMarkdown(input: string): string {
  return trimHtmlSpace(renderBlocks(parse(input).children, ROOT_CONTEXT).join("\n\n"));
}

/* ------------------------------------------------------------------ parsing */

function parse(input: string): ElementNode {
  const root = element("#root");
  const stack: ElementNode[] = [root];
  // Start tags ignored beyond MAX_DEPTH, by name, so their end tags do not close a real ancestor.
  const ignored = new Map<string, number>();
  const current = () => stack[stack.length - 1];
  const appendText = (raw: string) => {
    const text = decode(raw.replace(/\r\n?/g, "\n"));
    const siblings = current().children;
    const last = siblings[siblings.length - 1];
    if (last?.type === "text") last.text += text;
    else siblings.push({ type: "text", text });
  };
  const closeBefore = (targets: readonly string[], boundaries: readonly string[]) => {
    for (let depth = stack.length - 1; depth > 0; depth -= 1) {
      const name = stack[depth].name;
      if (targets.includes(name)) {
        stack.length = depth;
        return;
      }
      if (boundaries.includes(name)) return;
    }
  };
  const open = (tag: StartTag) => {
    if (tag.name === "li") closeBefore(["li"], ["ul", "ol", "menu"]);
    else if (tag.name === "dt" || tag.name === "dd") closeBefore(["dt", "dd"], ["dl"]);
    else if (tag.name === "tr") closeBefore(["tr"], ["table", "thead", "tbody", "tfoot"]);
    else if (tag.name === "td" || tag.name === "th") closeBefore(["td", "th"], ["tr", "table"]);
    else if (tag.name === "thead" || tag.name === "tbody" || tag.name === "tfoot")
      closeBefore(["thead", "tbody", "tfoot"], ["table"]);
    if (CLOSES_PARAGRAPH.has(tag.name) && current().name === "p") stack.pop();
    const node = element(tag.name, tag.attributes);
    const empty = VOID_ELEMENTS.has(tag.name) || (tag.selfClosing && !RAW_TEXT_ELEMENTS.has(tag.name));
    if (!empty && stack.length > MAX_DEPTH) {
      ignored.set(tag.name, (ignored.get(tag.name) ?? 0) + 1);
      return;
    }
    current().children.push(node);
    if (!empty) stack.push(node);
  };
  const close = (name: string) => {
    if (name === "br") return open({ name, attributes: new Map(), selfClosing: true, end: 0 });
    const pending = ignored.get(name);
    if (pending) {
      ignored.set(name, pending - 1);
      return;
    }
    for (let depth = stack.length - 1; depth > 0; depth -= 1)
      if (stack[depth].name === name) {
        stack.length = depth;
        return;
      }
  };

  let index = 0;
  while (index < input.length) {
    const lt = input.indexOf("<", index);
    if (lt < 0) {
      appendText(input.slice(index));
      break;
    }
    if (lt > index) appendText(input.slice(index, lt));
    const next = input.charCodeAt(lt + 1);
    if (isAsciiLetter(next)) {
      const tag = readStartTag(input, lt + 1);
      if (!tag) break; // EOF inside the tag: the tag is dropped, as HTML does.
      open(tag);
      index = tag.end;
      if (tag.name === "plaintext") break;
      if (RAW_TEXT_ELEMENTS.has(tag.name)) {
        const end = findRawTextEnd(input, index, tag.name);
        if (end < 0) break;
        index = end;
      }
    } else if (next === 0x2f /* / */) {
      const after = input.charCodeAt(lt + 2);
      if (isAsciiLetter(after)) {
        const end = readEndTag(input, lt + 2);
        if (!end) break;
        close(end.name);
        index = end.end;
      } else index = after === 0x3e /* </> */ ? lt + 3 : skipPast(input, ">", lt + 2);
    } else if (next === 0x21 /* ! */) {
      if (input.startsWith("<!--", lt)) index = skipPast(input, "-->", lt + 4);
      else if (input.startsWith("<![CDATA[", lt)) index = skipPast(input, "]]>", lt + 9);
      else index = skipPast(input, ">", lt + 2);
    } else if (next === 0x3f /* ? */) {
      index = skipPast(input, ">", lt + 2);
    } else {
      appendText("<");
      index = lt + 1;
    }
  }
  return root;
}

type StartTag = { name: string; attributes: Map<string, string>; selfClosing: boolean; end: number };

/** Reads `name attr="value" ...>` from the tag name's first letter; `undefined` at EOF. */
function readStartTag(input: string, from: number): StartTag | undefined {
  let index = from;
  while (index < input.length && !isTagNameEnd(input.charCodeAt(index))) index += 1;
  const name = input.slice(from, index).toLowerCase();
  const attributes = new Map<string, string>();
  for (;;) {
    while (index < input.length && isHtmlSpace(input.charCodeAt(index))) index += 1;
    if (index >= input.length) return undefined;
    const char = input[index];
    if (char === ">") return { name, attributes, selfClosing: false, end: index + 1 };
    if (char === "/") {
      if (input[index + 1] === ">") return { name, attributes, selfClosing: true, end: index + 2 };
      index += 1;
      continue;
    }
    const nameStart = index;
    while (index < input.length && !isAttributeNameEnd(input.charCodeAt(index))) index += 1;
    if (index === nameStart) {
      index += 1; // a stray quote or "=": skip it
      continue;
    }
    const attribute = input.slice(nameStart, index).toLowerCase();
    let value = "";
    let cursor = index;
    while (cursor < input.length && isHtmlSpace(input.charCodeAt(cursor))) cursor += 1;
    if (input[cursor] === "=") {
      cursor += 1;
      while (cursor < input.length && isHtmlSpace(input.charCodeAt(cursor))) cursor += 1;
      const quote = input[cursor];
      if (quote === '"' || quote === "'") {
        const closing = input.indexOf(quote, cursor + 1);
        if (closing < 0) return undefined;
        value = input.slice(cursor + 1, closing);
        cursor = closing + 1;
      } else {
        const valueStart = cursor;
        while (cursor < input.length && !isUnquotedValueEnd(input.charCodeAt(cursor))) cursor += 1;
        value = input.slice(valueStart, cursor);
      }
      index = cursor;
    }
    if (!attributes.has(attribute)) attributes.set(attribute, decode(value));
  }
}

function readEndTag(input: string, from: number): { name: string; end: number } | undefined {
  let index = from;
  while (index < input.length && !isTagNameEnd(input.charCodeAt(index))) index += 1;
  const end = input.indexOf(">", index);
  return end < 0 ? undefined : { name: input.slice(from, index).toLowerCase(), end: end + 1 };
}

/** The index of the `</name` that ends a raw-text element, or -1 when it never ends. */
function findRawTextEnd(input: string, from: number, name: string): number {
  for (let index = input.indexOf("</", from); index >= 0; index = input.indexOf("</", index + 2)) {
    const after = input.charCodeAt(index + 2 + name.length);
    if (
      input.slice(index + 2, index + 2 + name.length).toLowerCase() === name &&
      (Number.isNaN(after) || isHtmlSpace(after) || after === 0x2f || after === 0x3e)
    )
      return index;
  }
  return -1;
}

function skipPast(input: string, token: string, from: number): number {
  const index = input.indexOf(token, from);
  return index < 0 ? input.length : index + token.length;
}

function decode(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(REFERENCE, (match, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_REFERENCES.get(name) ?? match;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "", 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
      ? "\uFFFD"
      : String.fromCodePoint(code);
  });
}

function element(name: string, attributes = new Map<string, string>()): ElementNode {
  return { type: "element", name, attributes, children: [] };
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isHtmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

function isTagNameEnd(code: number): boolean {
  return isHtmlSpace(code) || code === 0x2f || code === 0x3e;
}

function isAttributeNameEnd(code: number): boolean {
  return isTagNameEnd(code) || code === 0x22 || code === 0x27 || code === 0x3d;
}

function isUnquotedValueEnd(code: number): boolean {
  return isHtmlSpace(code) || code === 0x3e;
}

/* ---------------------------------------------------------------- rendering */

function isDropped(node: ElementNode): boolean {
  if (DROPPED_ELEMENTS.has(node.name)) return true;
  if (node.name === "input" && node.attributes.get("type")?.trim().toLowerCase() !== "checkbox") return true;
  if (node.attributes.has("hidden")) return true;
  return node.attributes.get("aria-hidden")?.trim().toLowerCase() === "true";
}

function isBlockElement(node: ElementNode): boolean {
  if (node.name === "math") return node.attributes.get("display")?.trim().toLowerCase() === "block";
  return BLOCK_ELEMENTS.has(node.name);
}

const containsBlockCache = new WeakMap<ElementNode, boolean>();

/** An inline element that wraps a block is rendered as a transparent block container. */
function isBlockLevel(node: ElementNode): boolean {
  if (isBlockElement(node)) return true;
  let cached = containsBlockCache.get(node);
  if (cached === undefined) {
    cached = node.children.some(
      (child) => child.type === "element" && !isDropped(child) && isBlockLevel(child)
    );
    containsBlockCache.set(node, cached);
  }
  return cached;
}

/** A container's children as Markdown blocks; consecutive inline content forms one paragraph. */
function renderBlocks(nodes: readonly HtmlNode[], context: Context): string[] {
  const blocks: string[] = [];
  let inline = "";
  const flush = () => {
    const paragraph = finishParagraph(inline);
    if (paragraph) blocks.push(paragraph);
    inline = "";
  };
  for (const node of nodes) {
    if (node.type === "text") inline += node.text;
    else if (isDropped(node)) continue;
    else if (isBlockLevel(node)) {
      flush();
      blocks.push(...renderBlock(node, context));
    } else inline += renderInline(node, context);
  }
  flush();
  return blocks;
}

function renderBlock(node: ElementNode, context: Context): string[] {
  const heading = /^h([1-6])$/.exec(node.name);
  if (heading) {
    const text = trimHtmlSpace(renderInlineChildren(node, context).replace(/\n/g, " "));
    return text ? [`${"#".repeat(Number(heading[1]))} ${text}`] : [];
  }
  switch (node.name) {
    case "hr":
      return ["---"];
    case "pre":
      return nonEmpty([renderPre(node, context)]);
    case "blockquote": {
      const quoted = renderBlocks(node.children, context).join("\n\n");
      return quoted
        ? [
            quoted
              .split("\n")
              .map((line) => (line ? `> ${line}` : ">"))
              .join("\n")
          ]
        : [];
    }
    case "ul":
    case "ol":
    case "menu":
      return renderList(node, context);
    case "table":
      return renderTable(node, context);
    case "math": {
      const tex = texAnnotation(node);
      return nonEmpty([tex !== undefined ? `$$\n${tex}\n$$` : finishParagraph(textContent(node, " "))]);
    }
    default:
      return renderBlocks(node.children, context);
  }
}

function renderPre(node: ElementNode, context: Context): string {
  let content = textContent(node, "\n");
  // HTML ignores a newline right after <pre>; renderers end code with one.
  const first = node.children[0];
  if (first?.type === "text" && first.text.startsWith("\n")) content = content.slice(1);
  if (content.endsWith("\n")) content = content.slice(0, -1);
  if (context.cell) return content.split("\n").map(codeSpan).filter(Boolean).join("\n");
  const fence = "`".repeat(Math.max(3, longestRun(content, "`") + 1));
  const language = codeLanguage(node);
  return content ? `${fence}${language}\n${content}\n${fence}` : `${fence}${language}\n${fence}`;
}

function codeLanguage(pre: ElementNode): string {
  const sources = [findDescendant(pre, "code"), pre].filter((node): node is ElementNode => !!node);
  for (const source of sources)
    for (const token of (source.attributes.get("class") ?? "").split(/\s+/)) {
      const language = /^(?:language|lang)-(.+)$/.exec(token)?.[1];
      if (language && LANGUAGE.test(language)) return language;
    }
  for (const source of sources)
    for (const attribute of ["data-language", "data-lang"]) {
      const language = source.attributes.get(attribute)?.trim();
      if (language && LANGUAGE.test(language)) return language;
    }
  return "";
}

function renderList(list: ElementNode, context: Context): string[] {
  const ordered = list.name === "ol";
  const loose = list.children.some(
    (item) =>
      item.type === "element" &&
      item.name === "li" &&
      item.children.some((child) => child.type === "element" && child.name === "p" && !isDropped(child))
  );
  const separator = loose ? "\n\n" : "\n";
  let number = integerAttribute(list, "start") ?? 1;
  const items: string[] = [];
  for (const child of list.children) {
    let content: string;
    if (child.type === "text") {
      content = finishParagraph(child.text);
      if (!content) continue; // formatting whitespace between items
    } else if (isDropped(child)) continue;
    else if (child.name === "li") {
      if (ordered) number = integerAttribute(child, "value") ?? number;
      content = renderBlocks(child.children, context).join(separator);
    } else {
      // Not an item, but its text must not be lost.
      content = (
        isBlockLevel(child) ? renderBlock(child, context) : [finishParagraph(renderInline(child, context))]
      )
        .filter(Boolean)
        .join(separator);
      if (!content) continue;
    }
    const marker = ordered ? `${number}. ` : "- ";
    number += 1;
    items.push(indent(marker, content));
  }
  return items.length ? [items.join(separator)] : [];
}

function indent(marker: string, content: string): string {
  if (!content) return marker.trimEnd();
  const padding = " ".repeat(marker.length);
  return content
    .split("\n")
    .map((line, index) => (index === 0 ? marker + line : line ? padding + line : line))
    .join("\n");
}

function renderTable(table: ElementNode, context: Context): string[] {
  let caption: ElementNode | undefined;
  const rows: ElementNode[] = [];
  for (const child of table.children) {
    if (child.type !== "element" || isDropped(child)) continue;
    if (child.name === "caption") caption ??= child;
    else if (child.name === "tr") rows.push(child);
    else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot")
      for (const row of child.children)
        if (row.type === "element" && row.name === "tr" && !isDropped(row)) rows.push(row);
  }
  const cellContext: Context = { ...context, cell: true };
  const matrix: string[][] = [];
  const alignments: string[] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (const cell of row.children) {
      if (cell.type !== "element" || (cell.name !== "td" && cell.name !== "th") || isDropped(cell)) continue;
      const span = Math.min(100, Math.max(1, integerAttribute(cell, "colspan") ?? 1));
      if (!matrix.length) alignments.push(alignment(cell), ...Array<string>(span - 1).fill("---"));
      cells.push(renderCell(cell, cellContext), ...Array<string>(span - 1).fill(""));
    }
    if (cells.length) matrix.push(cells);
    else if (!matrix.length) alignments.length = 0;
  }
  if (!matrix.length) return [];
  const width = matrix.reduce((max, cells) => Math.max(max, cells.length), 0);
  const line = (cells: string[]) =>
    `| ${[...cells, ...Array<string>(width - cells.length).fill("")].join(" | ")} |`;
  const lines = [
    line(matrix[0]),
    line([...alignments, ...Array<string>(width - alignments.length).fill("---")]),
    ...matrix.slice(1).map(line)
  ];
  return [...(caption ? renderBlocks(caption.children, context) : []), lines.join("\n")];
}

/** GFM cells are one line: blocks and line breaks become `<br>`, and every `|` is escaped. */
function renderCell(cell: ElementNode, context: Context): string {
  return trimHtmlSpace(
    renderBlocks(cell.children, context).join("\n").replace(/\n/g, "<br>").replace(/\|/g, "\\|")
  );
}

function alignment(cell: ElementNode): string {
  const value = (
    cell.attributes.get("align") ??
    /text-align\s*:\s*(left|center|right)/i.exec(cell.attributes.get("style") ?? "")?.[1] ??
    ""
  )
    .trim()
    .toLowerCase();
  return value === "left" ? ":---" : value === "center" ? ":---:" : value === "right" ? "---:" : "---";
}

function renderInline(node: ElementNode, context: Context): string {
  switch (node.name) {
    case "br":
      return "\n";
    case "wbr":
      return "";
    case "input":
      return node.attributes.has("checked") ? "[x]" : "[ ]";
    case "code":
      return codeSpan(textContent(node, " "));
    case "strong":
    case "b":
      return emphasis(node, context, "**");
    case "em":
    case "i":
      return emphasis(node, context, "*");
    case "del":
    case "s":
    case "strike":
      return emphasis(node, context, "~~");
    case "a":
      return link(node, context);
    case "math": {
      const tex = texAnnotation(node);
      return tex !== undefined ? `$${tex}$` : textContent(node, " ");
    }
    default:
      return renderInlineChildren(node, context);
  }
}

function renderInlineChildren(node: ElementNode, context: Context): string {
  let text = "";
  for (const child of node.children)
    if (child.type === "text") text += child.text;
    else if (!isDropped(child)) text += renderInline(child, context);
  return text;
}

function emphasis(node: ElementNode, context: Context, marker: string): string {
  if (context.marks.has(marker)) return renderInlineChildren(node, context);
  const inner = renderInlineChildren(node, { ...context, marks: new Set([...context.marks, marker]) });
  const start = leadingSpace(inner);
  const end = inner.length - trailingSpace(inner);
  if (start >= end) return inner;
  return `${inner.slice(0, start)}${marker}${inner.slice(start, end)}${marker}${inner.slice(end)}`;
}

/** Only credential-free absolute https links keep their destination; others keep their text. */
function link(node: ElementNode, context: Context): string {
  const label = trimHtmlSpace(renderInlineChildren(node, context));
  const href = node.attributes.get("href");
  if (!label || href === undefined) return label;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return label;
  }
  if (url.protocol !== "https:" || url.username || url.password) return label;
  return `[${label}](${/[()]/.test(url.href) ? `<${url.href}>` : url.href})`;
}

function codeSpan(raw: string): string {
  const content = raw.replace(/\n/g, " ");
  if (!content) return "";
  const fence = "`".repeat(longestRun(content, "`") + 1);
  const pad =
    content.startsWith("`") ||
    content.endsWith("`") ||
    (content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content));
  return pad ? `${fence} ${content} ${fence}` : `${fence}${content}${fence}`;
}

/** The TeX source KaTeX/MathJax keep in `<annotation encoding="application/x-tex">`. */
function texAnnotation(math: ElementNode): string | undefined {
  const annotation = findDescendant(
    math,
    "annotation",
    (node) => node.attributes.get("encoding")?.trim().toLowerCase() === "application/x-tex"
  );
  return annotation ? trimHtmlSpace(textContent(annotation, " ")) : undefined;
}

function textContent(node: ElementNode, lineBreak: string): string {
  let text = "";
  for (const child of node.children)
    if (child.type === "text") text += child.text;
    else if (!isDropped(child)) text += child.name === "br" ? lineBreak : textContent(child, lineBreak);
  return text;
}

function findDescendant(
  node: ElementNode,
  name: string,
  accept: (node: ElementNode) => boolean = () => true
): ElementNode | undefined {
  for (const child of node.children) {
    if (child.type !== "element" || isDropped(child)) continue;
    if (child.name === name && accept(child)) return child;
    const found = findDescendant(child, name, accept);
    if (found) return found;
  }
  return undefined;
}

function integerAttribute(node: ElementNode, name: string): number | undefined {
  const value = node.attributes.get(name)?.trim();
  return value && /^[+-]?\d{1,9}$/.test(value) ? Number(value) : undefined;
}

/** Trims trailing spaces of every line and the paragraph's own edges; nothing else changes. */
function finishParagraph(text: string): string {
  return trimHtmlSpace(text.split("\n").map(trimLineEnd).join("\n"));
}

function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line.charCodeAt(end - 1) === 0x20 || line.charCodeAt(end - 1) === 0x09)) end -= 1;
  return line.slice(0, end);
}

/** HTML whitespace only: an ideographic space (U+3000) opening a Japanese paragraph is content. */
function trimHtmlSpace(value: string): string {
  const start = leadingSpace(value);
  return start === value.length ? "" : value.slice(start, value.length - trailingSpace(value));
}

function leadingSpace(value: string): number {
  let index = 0;
  while (index < value.length && isHtmlSpace(value.charCodeAt(index))) index += 1;
  return index;
}

function trailingSpace(value: string): number {
  let count = 0;
  while (count < value.length && isHtmlSpace(value.charCodeAt(value.length - 1 - count))) count += 1;
  return count;
}

function longestRun(value: string, char: string): number {
  let longest = 0;
  let run = 0;
  for (const current of value) {
    run = current === char ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

function nonEmpty(blocks: string[]): string[] {
  return blocks.filter(Boolean);
}
