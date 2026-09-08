import { describe, expect, it } from "vitest";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import type { PageLike } from "../../src/transports/browser/types.js";

describe("NavigationPolicy", () => {
  const policy = new NavigationPolicy({ appHosts: ["tenant.example.com"], authHosts: ["login.example.com"] });
  it("allows only exact HTTPS application hosts", () => {
    expect(() => policy.validate("https://tenant.example.com/chat")).not.toThrow();
    expect(() => policy.validate("https://evil.tenant.example.com/chat")).toThrow();
    expect(() => policy.validate("http://tenant.example.com/chat")).toThrow();
  });
  it("rejects local/private targets and allows auth only in auth state", () => {
    expect(() => policy.validate("https://127.0.0.1/chat")).toThrow();
    expect(() => policy.validate("https://login.example.com/authorize")).toThrow();
    expect(() => policy.validate("https://login.example.com/authorize", "auth")).not.toThrow();
  });
  it("accepts http loopback targets only with the development allowance", () => {
    const loopback = new NavigationPolicy({
      appHosts: ["127.0.0.1"],
      authHosts: ["127.0.0.1"],
      allowInsecureLoopback: true
    });
    expect(() => loopback.validate("http://127.0.0.1:8123/chat")).not.toThrow();
    expect(() => loopback.validate("http://localhost:8123/chat")).toThrow(/not allowlisted/);
    expect(() => loopback.validate("http://127.0.0.1:8123/oauth", "auth")).not.toThrow();
    // Everything else stays exactly as strict as before.
    expect(() => loopback.validate("http://user:pw@127.0.0.1:8123/chat")).toThrow();
    expect(() => loopback.validate("http://10.0.0.5:8123/chat")).toThrow();
    expect(() => loopback.validate("http://evil.test/chat")).toThrow();
    expect(() => policy.validate("http://127.0.0.1:8123/chat")).toThrow();
  });

  it("identifies a refusal caused only by the host allowlist, and never grants anything", () => {
    // Used to tell an unlisted identity provider (fix the configuration) apart from an attempt to
    // leave the boundary (fail closed).
    expect(policy.isHostOnlyRefusal("https://idp.partner.example/saml2")).toBe(true);
    // Already allowlisted: not a refusal at all.
    expect(policy.isHostOnlyRefusal("https://tenant.example.com/chat")).toBe(false);
    expect(policy.isHostOnlyRefusal("https://login.example.com/authorize")).toBe(false);
    // Refused for reasons other than the host: still a policy violation.
    expect(policy.isHostOnlyRefusal("http://idp.partner.example/saml2")).toBe(false);
    expect(policy.isHostOnlyRefusal("https://user:pw@idp.partner.example/saml2")).toBe(false);
    expect(policy.isHostOnlyRefusal("https://10.0.0.5/saml2")).toBe(false);
    expect(policy.isHostOnlyRefusal("https://idp.partner.example:8443/saml2")).toBe(false);
    expect(policy.isHostOnlyRefusal("not a url")).toBe(false);
  });

  it("normalizes safe citation URLs without opening them", () => {
    expect(policy.normalizeCitation("https://docs.example/a#section")).toBe("https://docs.example/a");
    expect(policy.normalizeCitation("javascript:alert(1)")).toBeUndefined();
  });
});

describe("AgentNavigator popup policy", () => {
  it("allows an allowlisted authentication popup only while login is active", () => {
    const policy = new NavigationPolicy({
      appHosts: ["tenant.example.com"],
      authHosts: ["login.example.com"]
    });
    const navigator = new AgentNavigator(policy);
    const parent = eventPage("https://tenant.example.com/chat");
    const popup = eventPage("about:blank");
    const stop = navigator.watch(parent.page, "app-or-auth");
    parent.emit("popup", popup.page);
    popup.navigate("https://login.example.com/authorize");
    expect(() => navigator.assertNavigationSafe(parent.page, "app-or-auth")).not.toThrow();
    stop();
    expect(popup.closed()).toBe(true);
  });

  it("blocks a popup that leaves the authentication allowlist", () => {
    const policy = new NavigationPolicy({
      appHosts: ["tenant.example.com"],
      authHosts: ["login.example.com"]
    });
    const navigator = new AgentNavigator(policy);
    const parent = eventPage("https://tenant.example.com/chat");
    const popup = eventPage("about:blank");
    const stop = navigator.watch(parent.page, "app-or-auth");
    parent.emit("popup", popup.page);
    popup.navigate("https://evil.example.net/phish");
    expect(() => navigator.assertNavigationSafe(parent.page, "app-or-auth")).toThrow();
    expect(popup.closed()).toBe(true);
    stop();
  });
});

function eventPage(initialUrl: string) {
  let currentUrl = initialUrl;
  let isClosed = false;
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const mainFrame = { url: () => currentUrl, parentFrame: () => null };
  const page: PageLike = {
    url: () => currentUrl,
    mainFrame: () => mainFrame,
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
    close: async () => {
      isClosed = true;
    }
  };
  return {
    page,
    emit: (event: string, value: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    navigate: (url: string) => {
      currentUrl = url;
      for (const listener of listeners.get("framenavigated") ?? []) listener(mainFrame);
    },
    closed: () => isClosed
  };
}
