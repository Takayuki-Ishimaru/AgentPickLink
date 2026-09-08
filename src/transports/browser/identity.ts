import { createHash } from "node:crypto";
import type { BrowserAgentVerification, PageLike, Surface } from "./types.js";
import type { DetectedAgentIdentity, IdentityAssertion } from "./ui-adapter.js";

/** Single source for identity-digest and identity-assertion logic. Every chat
 * UI adapter calls into this module instead of reimplementing the checks. */
export function identityDigest(parts: {
  adapterId: string;
  surface: string;
  displayName?: string;
  stableAgentId?: string;
}): string {
  return createHash("sha256")
    .update([parts.adapterId, parts.surface, parts.displayName || "", parts.stableAgentId || ""].join("|"))
    .digest("hex");
}

export async function assertIdentity(
  page: PageLike,
  expected: BrowserAgentVerification,
  adapterSurface: Surface,
  detect: (page: PageLike) => Promise<DetectedAgentIdentity | null>
): Promise<IdentityAssertion> {
  const actual = await detect(page);
  if (!actual || !actual.evidence.length) return { valid: false, code: "AGENT_IDENTITY_UNVERIFIED" };
  if (
    expected.expectedSurface !== adapterSurface ||
    (actual.surface && actual.surface !== expected.expectedSurface)
  )
    return { valid: false, identity: actual, code: "AGENT_IDENTITY_MISMATCH" };
  if (expected.expectedStableAgentId && actual.stableAgentId !== expected.expectedStableAgentId)
    return { valid: false, identity: actual, code: "AGENT_IDENTITY_MISMATCH" };
  if (!actual.displayName || normalize(actual.displayName) !== normalize(expected.expectedDisplayName))
    return { valid: false, identity: actual, code: "AGENT_IDENTITY_MISMATCH" };
  try {
    if (!matchesValidatedAgentPath(new URL(page.url()).pathname, expected))
      return { valid: false, identity: actual, code: "AGENT_CONTEXT_CHANGED" };
  } catch {
    return { valid: false, identity: actual, code: "AGENT_IDENTITY_UNVERIFIED" };
  }
  // Without a stable ID, require the independent visible-name + surface + URL
  // evidence combination. A tab title or one weak text match is never enough.
  if (!expected.expectedStableAgentId && (!actual.evidence.includes("visible-name") || !actual.surface))
    return { valid: false, identity: actual, code: "AGENT_IDENTITY_UNVERIFIED" };
  return { valid: true, identity: actual };
}

export function matchesValidatedAgentPath(pathname: string, expected: BrowserAgentVerification): boolean {
  const pattern = new RegExp(expected.validatedUrlPattern);
  if (pattern.test(pathname)) return true;
  if (!expected.expectedStableAgentId) return false;
  const conversation = /^(\/chat\/agent\/([^/]+))\/conversation\/[^/]+\/?$/i.exec(pathname);
  if (!conversation?.[1] || !conversation[2]) return false;
  try {
    return (
      decodeURIComponent(conversation[2]) === expected.expectedStableAgentId && pattern.test(conversation[1])
    );
  } catch {
    return false;
  }
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function directAgentIdFromUrl(value: URL | string): string | undefined {
  try {
    const url = typeof value === "string" ? new URL(value) : value;
    const match = /^\/chat\/agent\/([^/]+)(?:\/conversation\/[^/]+)?\/?$/i.exec(url.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}
