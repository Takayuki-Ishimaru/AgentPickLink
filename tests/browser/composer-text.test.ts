import { describe, expect, it } from "vitest";
import {
  composerTextMatches,
  describeComposerMismatch,
  foldComposerWhitespace
} from "../../src/transports/browser/composer-text.js";

const NBSP = "\u00a0";

// v0.2.7 review P2: the read-back folded every NBSP into a space while the requested text kept its
// NBSP, so a literal NBSP never matched. Ordinary spaces, NBSP and trailing whitespace are now told
// apart: an editor may show a requested space as NBSP, never the reverse.
describe("composer text comparison", () => {
  it.each([
    ["exact text", "a b", "a b"],
    ["a literal NBSP kept as NBSP", `a${NBSP}b`, `a${NBSP}b`],
    ["a requested space shown as NBSP", `a${NBSP} b`, "a  b"],
    ["a trailing space shown as NBSP", `abc${NBSP}`, "abc "],
    ["a leading space shown as NBSP", `${NBSP}abc`, " abc"],
    ["mixed spaces and NBSP kept", `a ${NBSP} b`, `a ${NBSP} b`],
    ["CRLF and CR read back as LF", "one\ntwo\nthree", "one\r\ntwo\rthree"]
  ])("accepts %s", (_name, observed, requested) => {
    expect(composerTextMatches(observed, requested)).toBe(true);
  });

  it.each([
    ["a requested NBSP that became a space", "a b", `a${NBSP}b`],
    ["NBSPs moved to other positions", `a${NBSP} ${NBSP}b`, `a ${NBSP} b`],
    ["a trailing space that was removed", "abc", "abc "],
    ["a full-width character folded", "A", "Ａ"],
    ["a zero-width character removed", "ab", "a\u200bb"],
    ["one character missing", "hell", "hello"]
  ])("rejects %s", (_name, observed, requested) => {
    expect(composerTextMatches(observed, requested)).toBe(false);
  });

  it.each([
    [`a b`, `a${NBSP}b`, "no-break-space"],
    [`x y${NBSP}z`, `x${NBSP}y${NBSP}z`, "no-break-space"],
    ["code", "  code", "surrounding-whitespace"],
    ["line", "line\n", "surrounding-whitespace"],
    ["a b", "a  b", "whitespace"],
    ["a\tb", "a b", "whitespace"],
    ["A", "Ａ", "characters"],
    ["hell", "hello", "characters"]
  ])("classifies %j for %j as %s without retaining text", (observed, requested, kind) => {
    expect(describeComposerMismatch(observed, requested)).toBe(kind);
  });

  it("folds NBSP only for recognising already verified text", () => {
    expect(foldComposerWhitespace(`a${NBSP}b\r\nc`)).toBe("a b\nc");
  });
});
