import type { BrowserAgentDefinition, Surface } from "./types.js";

export interface NavigationPolicyOptions {
  appHosts: string[];
  authHosts?: string[];
  appPathPatterns?: Record<string, string | RegExp>;
  /** Development only: additionally accept http:// on an exactly allowlisted 127.0.0.1/localhost
   * host (any port) so the local mock chat application can be driven end to end. Every other rule,
   * including the exact-host allowlist itself, is unchanged. */
  allowInsecureLoopback?: boolean;
}

/** Exact-host, state-aware navigation policy. Subresources are not checked. */
export class NavigationPolicy {
  readonly appHosts: ReadonlySet<string>;
  readonly authHosts: ReadonlySet<string>;
  private readonly appPathPatterns: Record<string, RegExp>;
  private readonly allowInsecureLoopback: boolean;
  constructor(options: NavigationPolicyOptions) {
    this.appHosts = new Set(options.appHosts.map(validateConfiguredHost));
    this.authHosts = new Set((options.authHosts ?? []).map(validateConfiguredHost));
    this.allowInsecureLoopback = options.allowInsecureLoopback === true;
    this.appPathPatterns = Object.fromEntries(
      Object.entries(options.appPathPatterns ?? {}).map(([k, v]) => [
        k,
        typeof v === "string" ? new RegExp(v) : v
      ])
    );
  }
  validate(
    urlValue: string,
    state: "app" | "auth" = "app",
    expected?: { surface?: Surface; pathPattern?: string }
  ): URL {
    const url = this.assertTransportSafe(urlValue);
    const hosts = state === "auth" ? this.authHosts : this.appHosts;
    const hostname = normalizeHost(url.hostname);
    if (!hosts.has(hostname))
      throw policyError("POLICY_BLOCKED", `Host ${hostname} is not allowlisted for ${state} navigation`);
    const pattern = expected?.pathPattern || this.appPathPatterns[normalizeHost(url.hostname)];
    if (pattern && !(pattern instanceof RegExp ? pattern : new RegExp(pattern)).test(url.pathname))
      throw policyError("POLICY_BLOCKED", "Path is not allowlisted");
    return url;
  }
  /** Every navigation rule except the host allowlists: scheme, port, credentials, and private or
   * local targets. Shared by `validate` and `isHostOnlyRefusal` so there is one definition of
   * "safe transport" to keep in step. */
  private assertTransportSafe(urlValue: string): URL {
    let url: URL;
    try {
      url = new URL(urlValue);
    } catch {
      throw policyError("POLICY_BLOCKED", "Malformed navigation URL");
    }
    const loopback = this.allowInsecureLoopback && isDevLoopback(url);
    if (url.username || url.password)
      throw policyError("POLICY_BLOCKED", "Navigation URLs must not carry embedded credentials");
    if (!loopback) {
      if (url.protocol !== "https:" || (url.port && url.port !== "443"))
        throw policyError("POLICY_BLOCKED", "Only HTTPS URLs on the default port are allowed");
      if (isPrivateOrLocalHost(url.hostname))
        throw policyError("POLICY_BLOCKED", "Local and private network targets are not allowed");
    }
    return url;
  }
  /**
   * True when the *only* reason this URL is refused is that its host is on neither allowlist --
   * a well-formed HTTPS destination that simply is not configured. Callers on the sign-in path use
   * this to tell an unlisted identity provider (a configuration gap) apart from a genuine attempt
   * to leave the approved boundary. It never grants anything.
   */
  isHostOnlyRefusal(urlValue: string): boolean {
    let url: URL;
    try {
      url = this.assertTransportSafe(urlValue);
    } catch {
      return false;
    }
    const hostname = normalizeHost(url.hostname);
    return !!hostname && !this.appHosts.has(hostname) && !this.authHosts.has(hostname);
  }
  validateAgentEntryPoint(agent: BrowserAgentDefinition): URL {
    if (agent.entryPoint.mode !== "direct-chat")
      throw policyError("AGENT_ENTRYPOINT_UNSUPPORTED", "Only direct chat entry points are invokable");
    return this.validate(agent.entryPoint.url, "app", {
      surface: agent.entryPoint.surface,
      pathPattern: agent.verification.validatedUrlPattern
    });
  }
  assertRedirect(urlValue: string, state: "app" | "auth" = "app"): void {
    this.validate(urlValue, state);
  }
  normalizeCitation(urlValue: string): string | undefined {
    try {
      const u = new URL(urlValue);
      // Citation links are returned as data and are never opened; organizational
      // resources may legitimately use private DNS/IP ranges.
      if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443"))
        return undefined;
      u.hash = "";
      return u.toString();
    } catch {
      return undefined;
    }
  }
}

/** Exactly the two developer loopback names, over http, on any port. Nothing else. */
function isDevLoopback(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  const hostname = normalizeHost(url.hostname);
  return hostname === "127.0.0.1" || hostname === "localhost";
}
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}
function validateConfiguredHost(host: string): string {
  const normalized = normalizeHost(host);
  if (!normalized || normalized.includes("*") || normalized.includes("/") || normalized.includes(":"))
    throw policyError("POLICY_BLOCKED", "Navigation allowlists must contain exact hostnames only");
  return normalized;
}
function isPrivateOrLocalHost(host: string): boolean {
  const h = normalizeHost(host);
  if (
    h === "localhost" ||
    h === "localhost.localdomain" ||
    h === "ip6-localhost" ||
    h === "broadcasthost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h === "[::1]"
  )
    return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  const ipv6 = h.replace(/^\[|\]$/g, "");
  if (ipv6.includes(":"))
    return (
      ipv6 === "::1" ||
      ipv6.startsWith("fe8") ||
      ipv6.startsWith("fe9") ||
      ipv6.startsWith("fea") ||
      ipv6.startsWith("feb") ||
      ipv6.startsWith("fc") ||
      ipv6.startsWith("fd") ||
      ipv6.startsWith("::ffff:127.") ||
      ipv6.startsWith("::ffff:10.") ||
      ipv6.startsWith("::ffff:192.168.") ||
      /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(ipv6)
    );
  const octets = h.split(".").map(Number);
  if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = octets;
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}
function policyError(code: string, message: string): Error {
  const e = new Error(message);
  (e as any).code = code;
  return e;
}
