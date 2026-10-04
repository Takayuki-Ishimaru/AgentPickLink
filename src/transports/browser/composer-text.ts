import type { LocatorLike } from "./types.js";

/** Only the platform's line-ending representation is interchangeable in requested text. */
export function normalizeComposerText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** Self-contained for Playwright evaluation. Read editor structure, independently of CSS margins
 * and innerText's extra line breaks. A final BR inside a paragraph is the browser's caret
 * placeholder; empty paragraphs still contribute a line. No Unicode folding or trimming.
 * Chromium encodes typed ordinary spaces as NBSP in rich text to prevent HTML collapsing them.
 * Text controls use their value verbatim, including literal NBSP. */
export function readDomPlainText(elementOrSelector: Element | string): string | undefined {
  let element: Element | undefined;
  if (typeof elementOrSelector === "string") {
    const nodes = Array.from(document.querySelectorAll(elementOrSelector));
    const latest = nodes.at(-1);
    element = latest?.querySelector('[data-testid="chatOutput"]') ?? latest;
  } else element = elementOrSelector;
  if (!element) return undefined;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
  const blocks = new Set(["DIV", "P", "LI", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"]);
  const read = (parent: Node): string => {
    const children = Array.from(parent.childNodes).filter((node) => node.nodeType !== Node.COMMENT_NODE);
    // A terminal BR supplies the empty caret line; the preceding BRs are user line breaks.
    if (
      children.at(-1) instanceof HTMLBRElement &&
      (parent === element || (parent instanceof Element && blocks.has(parent.tagName)))
    )
      children.pop();
    let result = "";
    let previousBlock = false;
    let hasPrevious = false;
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (previousBlock) result += "\n";
        result += child.textContent ?? "";
        previousBlock = false;
        hasPrevious = true;
      } else if (child instanceof Element) {
        if (child.matches("script, style, [hidden], [aria-hidden='true']")) continue;
        const block = blocks.has(child.tagName);
        if (hasPrevious && (previousBlock || (block && !result.endsWith("\n")))) result += "\n";
        result += child.tagName === "BR" ? "\n" : read(child);
        previousBlock = block;
        hasPrevious = true;
      }
    }
    return result;
  };
  return read(element)
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n");
}

export async function readComposerPlainText(composer: LocatorLike): Promise<string> {
  if (composer.evaluate) return (await composer.evaluate(readDomPlainText)) ?? "";
  // Narrow contract doubles without DOM evaluation still expose a value or literal text.
  try {
    const value = await composer.inputValue?.();
    if (value !== undefined) return normalizeComposerText(value);
  } catch {
    /* rich text */
  }
  return normalizeComposerText((await composer.textContent?.()) ?? "");
}
