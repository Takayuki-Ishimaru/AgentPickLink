/**
 * Message vectors for the one rule every layer applies to a message: 1-12000 code points with at
 * least one character that is not whitespace (src/domain/text.ts's `isSendableMessage`, the
 * published schema's `pattern` (anchored `\\S`), the MCP tool check and the broker's IPC parameters).
 *
 * Whitespace is what ECMAScript's `\s` matches, so Unicode spaces count as well. The invisible and
 * ambiguous characters are built with String.fromCodePoint instead of being typed into the source,
 * where an editor or a formatter could silently turn them into plain spaces.
 */
const code = (...points: number[]): string => String.fromCodePoint(...points);

const range = (from: number, to: number): string => {
  const points: number[] = [];
  for (let point = from; point <= to; point++) points.push(point);
  return code(...points);
};

/** Messages that hold nothing but whitespace: refused everywhere, however long they are. */
export const WHITESPACE_ONLY_MESSAGES: ReadonlyArray<readonly [name: string, message: string]> = [
  ["a space", " "],
  ["spaces, a newline and a tab", "   \n\t"],
  ["an ideographic space (U+3000)", code(0x3000)],
  ["a no-break space (U+00A0)", code(0x00a0)],
  ["a newline", "\n"],
  ["a carriage return and a line feed", "\r\n"],
  ["a vertical tab and a form feed", "\v\f"],
  ["a line separator and a paragraph separator (U+2028, U+2029)", code(0x2028, 0x2029)],
  ["a byte order mark (U+FEFF)", code(0xfeff)],
  ["an ogham space mark (U+1680)", code(0x1680)],
  ["the en and em spaces (U+2000-U+200A)", range(0x2000, 0x200a)],
  ["a narrow no-break space and a medium mathematical space", code(0x202f, 0x205f)],
  ["ideographic spaces mixed with ASCII whitespace", `${code(0x3000)} \t${code(0x3000)}\n `],
  ["12000 newlines (the longest message allowed)", "\n".repeat(12_000)]
];

/** Messages with something to say, including ones that carry whitespace around or inside it. The
 * whitespace is part of the message and must reach the agent exactly as given. */
export const SENDABLE_MESSAGES: ReadonlyArray<readonly [name: string, message: string]> = [
  ["a single character", "a"],
  ["surrounding spaces", "  hello  "],
  ["a leading newline and trailing blank lines", "\nhello\n\n"],
  ["tabs, runs of spaces and blank lines inside", "a\tb  c\n\nd"],
  ["CRLF line breaks", "line 1\r\nline 2\r\n"],
  ["ideographic spaces around Japanese text", `${code(0x3000)}日本語${code(0x3000)}`],
  ["no-break spaces around a word", `${code(0xa0)}word${code(0xa0)}`],
  ["a single emoji", "😀"],
  ["an emoji between spaces", " 😀 "],
  ["one letter after 11999 spaces (the longest message allowed)", `${" ".repeat(11_999)}x`],
  ["12000 emoji (24000 UTF-16 units)", "😀".repeat(12_000)]
];

/** Characters that are neither whitespace in an ECMAScript pattern nor plain text: the published
 * schema, the MCP check and the broker must agree on them, whichever way `\s` classifies them. */
export const UNICODE_EDGE_MESSAGES: ReadonlyArray<readonly [name: string, message: string]> = [
  ["a zero width space (U+200B)", code(0x200b)],
  ["a Mongolian vowel separator (U+180E)", code(0x180e)],
  ["a next line control (U+0085)", code(0x85)],
  ["a zero width joiner (U+200D)", code(0x200d)],
  ["a lone high surrogate", "\ud83d"],
  ["a lone low surrogate", "\ude00"],
  ["a NUL character", "\u0000"],
  ["a space followed by a NUL character", " \u0000"]
];
