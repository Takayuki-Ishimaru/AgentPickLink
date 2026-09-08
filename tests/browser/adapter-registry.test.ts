import { describe, expect, it } from "vitest";
import { SUPPORTED_BROWSER_ADAPTER_IDS } from "../../src/domain/agent.js";
import { BROWSER_ADAPTER_REGISTRY, adapterIdFor } from "../../src/transports/browser/adapters/index.js";

describe("browser adapter registry", () => {
  it("matches SUPPORTED_BROWSER_ADAPTER_IDS exactly, so the two lists cannot drift", () => {
    const registryIds = new Set(BROWSER_ADAPTER_REGISTRY.map((entry) => entry.id));
    expect(registryIds).toEqual(SUPPORTED_BROWSER_ADAPTER_IDS);
  });

  it("never registers the diagnostic-only fallback as a supported surface adapter", () => {
    expect(BROWSER_ADAPTER_REGISTRY.some((entry) => entry.id === "generic-diagnostic@1")).toBe(false);
    expect(SUPPORTED_BROWSER_ADAPTER_IDS.has("generic-diagnostic@1")).toBe(false);
  });

  it("creates a distinct ChatUiAdapter instance per entry with a matching id", () => {
    for (const entry of BROWSER_ADAPTER_REGISTRY) {
      const adapter = entry.create({ hostnames: ["example.test"] });
      expect(adapter.id).toBe(entry.id);
      expect(adapter.canSubmit).toBe(true);
    }
  });

  describe("adapterIdFor", () => {
    it("always resolves teams-web to the teams-web adapter regardless of kind", () => {
      expect(adapterIdFor("teams-web", "m365-agent-builder")).toBe("teams-web-agent-chat@1");
      expect(adapterIdFor("teams-web", "copilot-studio")).toBe("teams-web-agent-chat@1");
      expect(adapterIdFor("teams-web", "sharepoint-agent")).toBe("teams-web-agent-chat@1");
    });
    it("resolves m365-copilot by kind, falling back to the m365-copilot-chat adapter", () => {
      expect(adapterIdFor("m365-copilot", "m365-agent-builder")).toBe("agent-builder-chat@1");
      expect(adapterIdFor("m365-copilot", "copilot-studio")).toBe("copilot-studio-m365-chat@1");
      expect(adapterIdFor("m365-copilot", "sharepoint-agent")).toBe("m365-copilot-chat@1");
    });
  });
});
