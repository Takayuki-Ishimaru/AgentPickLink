import { describe, expect, it } from "vitest";
import {
  HostAllowlist,
  hostMatchesPattern,
  isExactHostname,
  isHostPattern,
  normalizeHostname
} from "../../src/domain/host-pattern.js";

describe("host patterns (navigation.downloadHosts)", () => {
  it("accepts exact hostnames and rejects schemes, paths, ports, credentials, and wildcards", () => {
    for (const ok of ["contoso.sharepoint.com", "Contoso-MY.SharePoint.com", "localhost", "xn--r8jz45g.jp"])
      expect(isExactHostname(ok), ok).toBe(true);
    for (const bad of [
      "",
      "*.sharepoint.com",
      "https://a.b",
      "a.b/x",
      "a.b:443",
      "u@a.b",
      "a b.c",
      "a.b.",
      "例え.jp"
    ])
      expect(isExactHostname(bad), bad).toBe(false);
  });

  it("accepts `*.` only as the whole leftmost label on a domain of two or more labels", () => {
    for (const ok of ["*.sharepoint.com", "*.SharePoint.com", "*.a.b.c", "contoso.sharepoint.com"])
      expect(isHostPattern(ok), ok).toBe(true);
    for (const bad of [
      "*.com",
      "*.",
      "*",
      "*sharepoint.com",
      "contoso.*.com",
      "*.*.com",
      "**.sharepoint.com",
      "*.sharepoint.com.",
      "*..com",
      "*.sharepoint.com/x",
      "*.sharepoint.com:443"
    ])
      expect(isHostPattern(bad), bad).toBe(false);
  });

  it("matches a wildcard against any host below the domain, never the apex or a look-alike", () => {
    expect(hostMatchesPattern("contoso.sharepoint.com", "*.sharepoint.com")).toBe(true);
    expect(hostMatchesPattern("contoso-my.sharepoint.com", "*.sharepoint.com")).toBe(true);
    expect(hostMatchesPattern("a.b.sharepoint.com", "*.sharepoint.com")).toBe(true);
    expect(hostMatchesPattern("CONTOSO.SharePoint.COM.", "*.sharepoint.com")).toBe(true);
    expect(hostMatchesPattern("sharepoint.com", "*.sharepoint.com")).toBe(false);
    expect(hostMatchesPattern("evilsharepoint.com", "*.sharepoint.com")).toBe(false);
    expect(hostMatchesPattern("contoso.sharepoint.com.evil.example", "*.sharepoint.com")).toBe(false);
  });

  it("matches exact entries case-insensitively, ignoring a trailing dot on the host only", () => {
    expect(hostMatchesPattern("OneDrive.Live.com.", "onedrive.live.com")).toBe(true);
    expect(hostMatchesPattern("sub.onedrive.live.com", "onedrive.live.com")).toBe(false);
    expect(hostMatchesPattern("onedrive.live.com", "*.live.com")).toBe(true);
  });

  it("compiles a mixed list, skips empty entries, and reports its size", () => {
    const allowlist = new HostAllowlist(["*.sharepoint.com", "onedrive.live.com", ""]);
    expect(allowlist.size).toBe(2);
    expect(allowlist.allows("contoso-my.sharepoint.com")).toBe(true);
    expect(allowlist.allows("onedrive.live.com")).toBe(true);
    expect(allowlist.allows("1drv.ms")).toBe(false);
    expect(new HostAllowlist().size).toBe(0);
    expect(new HostAllowlist().allows("anything.example")).toBe(false);
  });

  it("normalizes hostnames to lowercase without a trailing dot", () => {
    expect(normalizeHostname("Contoso.SharePoint.com.")).toBe("contoso.sharepoint.com");
  });
});
