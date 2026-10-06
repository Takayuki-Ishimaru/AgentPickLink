/**
 * Small, pure string-transform helpers shared across the CLI, SetupService, and the browser
 * transport. Kept dependency-free (no fs, no browser types) so SetupService -- which must never
 * pull in anything under src/transports/browser (see docs/architecture.md's "VS Code extension"
 * section) -- can import this module directly instead of keeping its own duplicate copy.
 */

/** Lowercase, hyphenated, ASCII-alphanumeric slug derived from a display name, capped at 64
 * characters. Falls back to "agent" when nothing survives normalization (e.g. an all-symbol or
 * empty display name). Uniquifying a slug against already-taken aliases (the `-2`, `-3`, ...
 * suffixing) is call-site policy, not part of this pure transform -- see
 * src/services/setup-service.ts's `resolveUniqueAlias`. */
export function slug(value: string): string {
  const result = value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return result || "agent";
}

/** Escapes every regex metacharacter in `value` so it can be embedded literally inside a larger
 * pattern (see pathPattern below). */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds an anchored regex pattern for a captured direct-chat URL's path, replacing whichever
 * path segment immediately follows a "conversation(s)"/"thread(s)"/"session(s)" segment with a
 * wildcard (`[^/]+`) -- that segment is a per-conversation identifier, not part of the agent's
 * stable route -- and escaping every other segment literally. */
export function pathPattern(pathname: string): string {
  const parts = pathname.split("/");
  return `^${parts
    .map((part, index) =>
      /^(conversations?|threads?|sessions?)$/i.test(parts[index - 1] ?? "") ? "[^/]+" : escapeRegex(part)
    )
    .join("/")}$`;
}

/** The longest message one request may send. Counted as JSON Schema's `maxLength` counts (Unicode
 * code points), so the published tool schema, the MCP argument check and the broker's IPC check
 * all accept exactly the same messages, emoji and other astral characters included. */
export const MESSAGE_MAX_CHARACTERS = 12_000;

export function messageCharacterCount(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}
