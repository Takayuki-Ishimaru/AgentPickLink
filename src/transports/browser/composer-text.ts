import type { LocatorLike } from "./types.js";

/** Only the platform's line-ending representation is interchangeable in requested text. */
export function normalizeComposerText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** Whether text read back from a composer is exactly the requested message. A rich-text editor
 * without `white-space: pre-wrap` stores a typed ordinary space as U+00A0 (NBSP) wherever HTML
 * would otherwise collapse it, so an NBSP in the composer may stand for a requested space. The
 * reverse is a change: an NBSP the message itself contains must still be an NBSP. Line endings
 * compare as LF; every other character must match exactly. */
export function composerTextMatches(observed: string, requested: string): boolean {
  const actual = normalizeComposerText(observed);
  const expected = normalizeComposerText(requested);
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < actual.length; index++) {
    const held = actual.charCodeAt(index);
    const wanted = expected.charCodeAt(index);
    if (held !== wanted && !(held === 0xa0 && wanted === 0x20)) return false;
  }
  return true;
}

/** NBSP and an ordinary space as one character. Only for recognising text that was already
 * verified with composerTextMatches (the user's own message bubble, an unchanged draft); never for
 * deciding that a message may be submitted. */
export function foldComposerWhitespace(value: string): string {
  return normalizeComposerText(value).replace(/\u00a0/g, " ");
}

/** What kind of change a composer made to the requested message. Classifies without retaining or
 * reporting the text: `no-break-space` means only requested NBSPs became ordinary spaces,
 * `surrounding-whitespace` only leading or trailing whitespace differs, `whitespace` only
 * whitespace inside the message differs, and `characters` covers everything else. */
export type ComposerMismatch = "no-break-space" | "surrounding-whitespace" | "whitespace" | "characters";

export function describeComposerMismatch(observed: string, requested: string): ComposerMismatch {
  const actual = foldComposerWhitespace(observed);
  const expected = foldComposerWhitespace(requested);
  if (actual === expected) return "no-break-space";
  if (actual.trim() === expected.trim()) return "surrounding-whitespace";
  if (actual.replace(/\s+/g, "") === expected.replace(/\s+/g, "")) return "whitespace";
  return "characters";
}

/** Self-contained for Playwright evaluation. Read editor structure, independently of CSS margins
 * and innerText's extra line breaks. A final BR inside a paragraph is the browser's caret
 * placeholder; empty paragraphs still contribute a line. An editor that keeps line breaks as text
 * (white-space: pre-wrap and the like) gets the same placeholder as text instead: Chromium ends a
 * line break typed at the end with a second line feed, so a final line feed of an editable
 * element's last text is dropped once. No Unicode folding or trimming, and NBSP stays NBSP: whether
 * it may stand for a requested space is composerTextMatches' decision. Text controls use their
 * value verbatim. */
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
  const text = read(element).replace(/\r\n?/g, "\n");
  if (!(element instanceof HTMLElement) || !element.isContentEditable) return text;
  if (!/^(?:pre|pre-wrap|pre-line|break-spaces)$/.test(getComputedStyle(element).whiteSpace)) return text;
  let last: Node | null = element;
  while (last && !(last.nodeType === Node.TEXT_NODE || last instanceof HTMLBRElement)) {
    let child: Node | null = last.lastChild;
    while (
      child &&
      (child.nodeType === Node.COMMENT_NODE ||
        (child instanceof Element && child.matches("script, style, [hidden], [aria-hidden='true']")))
    )
      child = child.previousSibling;
    last = child;
  }
  return last?.nodeType === Node.TEXT_NODE && /\n$/.test(last.textContent ?? "") ? text.slice(0, -1) : text;
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
