/**
 * Host allowlist entries for `navigation.downloadHosts` (src/config/schema.ts). An entry is either
 * an exact hostname (`contoso.sharepoint.com`) or a wildcard suffix (`*.sharepoint.com`). A wildcard
 * matches every host *below* that domain, at any depth -- `contoso.sharepoint.com`,
 * `contoso-my.sharepoint.com` -- but never the apex domain itself and never a host that merely ends
 * with the same characters (`evilsharepoint.com`). The wildcard is accepted only as the whole
 * leftmost label, and only on a domain of at least two labels, so `*.com` cannot allowlist a whole
 * top-level domain. Matching is case-insensitive and ignores one trailing dot on the host being
 * checked; schemes, paths, ports, credentials, and trailing dots are rejected in entries.
 *
 * Kept free of zod and node imports: the config schema, the extension host (src/extension/plan.ts),
 * and the browser transport (AttachmentSaver, ResponseExtractor) all share this one definition.
 */

const WILDCARD_PREFIX = "*.";

/** Lowercases and strips one trailing dot -- the canonical form both sides of a comparison use. */
export function normalizeHostname(value: string): string {
  return value.toLocaleLowerCase().replace(/\.$/, "");
}

/**
 * True for an exact hostname as the WHATWG URL parser understands it: no wildcard, scheme, path,
 * port, credentials, or whitespace, and nothing the parser would rewrite (an IDNA label must already
 * be punycode, and a trailing dot is rejected). Uppercase letters are tolerated.
 */
export function isExactHostname(value: string): boolean {
  if (value.length === 0 || value.includes("*") || value.includes("/") || value.includes(":")) return false;
  try {
    return new URL(`https://${value}`).hostname.toLocaleLowerCase() === normalizeHostname(value);
  } catch {
    return false;
  }
}

/** True for an allowlist entry: an exact hostname, or `*.` followed by a domain of two or more labels. */
export function isHostPattern(value: string): boolean {
  if (!value.startsWith(WILDCARD_PREFIX)) return isExactHostname(value);
  const domain = value.slice(WILDCARD_PREFIX.length);
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) => label.length > 0) && isExactHostname(domain);
}

/** Whether one allowlist entry (exact or wildcard) covers `hostname`. */
export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  return new HostAllowlist([pattern]).allows(hostname);
}

/** A compiled `navigation.downloadHosts` list: exact entries and wildcard suffixes, matched as
 * documented at the top of this file. Entries are normalized on the way in and never validated
 * here; the config schema (and the panel's own normalizer) already did that. */
export class HostAllowlist {
  private readonly exact = new Set<string>();
  private readonly suffixes: string[] = [];

  constructor(patterns: Iterable<string> = []) {
    for (const pattern of patterns) {
      const entry = normalizeHostname(pattern);
      if (entry.length === 0) continue;
      if (entry.startsWith(WILDCARD_PREFIX)) this.suffixes.push(entry.slice(WILDCARD_PREFIX.length - 1));
      else this.exact.add(entry);
    }
  }

  /** Number of entries; `0` means nothing is allowlisted. */
  get size(): number {
    return this.exact.size + this.suffixes.length;
  }

  allows(hostname: string): boolean {
    const host = normalizeHostname(hostname);
    if (this.exact.has(host)) return true;
    return this.suffixes.some((suffix) => host.length > suffix.length && host.endsWith(suffix));
  }
}
