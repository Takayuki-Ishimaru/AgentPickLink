import { describe, expect, it } from "vitest";
import type { AgentCandidate } from "../../src/services/setup-service.js";
import {
  buildApplyPlan,
  mergeDownloadHostSuggestions,
  normalizeDownloadHost,
  previewAlias
} from "../../src/extension/plan.js";
import type { SavePlanInput } from "../../src/extension/protocol.js";

const candidates: AgentCandidate[] = [
  {
    key: "agent-requirements",
    url: "https://m365.cloud.microsoft/chat/agent/agent-requirements",
    displayName: "Requirements Agent",
    stableAgentId: "agent-requirements",
    surface: "m365-copilot",
    source: "sidebar",
    assigned: true,
    registered: {
      alias: "requirements",
      verified: true,
      enabled: true,
      kind: "m365-agent-builder",
      capabilityClass: "knowledge-only",
      usageHint: "Ask about requirements"
    }
  },
  {
    key: "agent-architecture",
    url: "https://m365.cloud.microsoft/chat/agent/agent-architecture",
    displayName: "Architecture Agent",
    stableAgentId: "agent-architecture",
    surface: "m365-copilot",
    source: "sidebar",
    assigned: false
  }
];

function input(overrides: Partial<SavePlanInput> = {}): SavePlanInput {
  return {
    agents: [],
    downloadHosts: [],
    acceptDownloads: false,
    integrations: { codex: false, claudeCode: false, vscodeMcpJson: false },
    ...overrides
  };
}

describe("buildApplyPlan", () => {
  it("uses Microsoft's description even when a stale webview sends an override", () => {
    const selected = { ...candidates[0], description: "Current Microsoft 365 description" };
    const { plan } = buildApplyPlan(
      input({ agents: [{ key: selected.key, ...{ description: "Manual override" } }] }),
      [selected]
    );
    expect(plan.agents[0].description).toBe("Current Microsoft 365 description");
  });

  it("resolves URLs from the host's candidate list, never from the webview", () => {
    const { plan, unknownKeys } = buildApplyPlan(
      input({
        agents: [
          { key: "agent-architecture", displayName: "Arch", actionsPossible: true },
          { key: "https://evil.example/chat", displayName: "Evil" }
        ]
      }),
      candidates
    );
    expect(plan.agents).toEqual([
      {
        url: "https://m365.cloud.microsoft/chat/agent/agent-architecture",
        displayName: "Arch",
        description: "",
        capabilityClass: "actions-possible"
      }
    ]);
    expect(unknownKeys).toEqual(["https://evil.example/chat"]);
  });

  it("carries the registry alias, kind and usage hint of an already registered agent", () => {
    const { plan } = buildApplyPlan(input({ agents: [{ key: "agent-requirements" }] }), candidates);
    expect(plan.agents[0]).toEqual({
      url: "https://m365.cloud.microsoft/chat/agent/agent-requirements",
      alias: "requirements",
      displayName: "Requirements Agent",
      description: "",
      usageHint: "Ask about requirements",
      kind: "m365-agent-builder",
      capabilityClass: "knowledge-only"
    });
  });

  it("lets a webview-edited usage hint override the registered one", () => {
    const { plan } = buildApplyPlan(
      input({ agents: [{ key: "agent-requirements", usageHint: "  Ask about scope  " }] }),
      candidates
    );
    expect(plan.agents[0].usageHint).toBe("Ask about scope");
  });

  it("drops duplicates and normalizes download hosts", () => {
    const { plan } = buildApplyPlan(
      input({
        agents: [{ key: "agent-architecture" }, { key: "agent-architecture" }],
        downloadHosts: ["  HTTPS://Files.example.com/x  ", "files.example.com", "nope", ""],
        acceptDownloads: true
      }),
      candidates
    );
    expect(plan.agents).toHaveLength(1);
    expect(plan.downloadHosts).toEqual(["files.example.com"]);
    expect(plan.acceptDownloads).toBe(true);
  });
});

describe("normalizeDownloadHost", () => {
  it("accepts bare hosts and strips scheme, path and port", () => {
    expect(normalizeDownloadHost("https://a.b.example.com:443/x/y")).toBe("a.b.example.com");
  });

  it("rejects values that are not host-shaped", () => {
    expect(normalizeDownloadHost("localhost")).toBeUndefined();
    expect(normalizeDownloadHost("a b.com")).toBeUndefined();
    expect(normalizeDownloadHost("   ")).toBeUndefined();
  });
});

describe("previewAlias", () => {
  it("slugifies a display name", () => {
    expect(previewAlias("Requirements Agent (v2)")).toBe("requirements-agent-v2");
    expect(previewAlias("要件エージェント")).toBe("agent");
  });
});

describe("mergeDownloadHostSuggestions", () => {
  it("keeps every configured host, in order, and appends new suggestions after them", () => {
    expect(
      mergeDownloadHostSuggestions(["files.example.com"], ["contoso.sharepoint.com", "files.example.com"])
    ).toEqual(["files.example.com", "contoso.sharepoint.com"]);
  });

  it("de-duplicates suggestions case-insensitively against the configured list and against each other", () => {
    expect(
      mergeDownloadHostSuggestions(
        ["Files.Example.com"],
        ["files.example.com", "contoso.sharepoint.com", "CONTOSO.sharepoint.com"]
      )
    ).toEqual(["Files.Example.com", "contoso.sharepoint.com"]);
  });

  it("returns the configured list unchanged when there is nothing new to suggest", () => {
    expect(mergeDownloadHostSuggestions(["files.example.com"], [])).toEqual(["files.example.com"]);
    expect(mergeDownloadHostSuggestions([], [])).toEqual([]);
  });
});

describe("normalizeDownloadHost wildcards", () => {
  it("accepts `*.` wildcards typed as a bare pattern or inside a URL, lowercased", () => {
    expect(normalizeDownloadHost(" *.SharePoint.com ")).toBe("*.sharepoint.com");
    expect(normalizeDownloadHost("https://*.sharepoint.com/sites/x")).toBe("*.sharepoint.com");
    expect(normalizeDownloadHost("onedrive.live.com:443")).toBe("onedrive.live.com");
  });

  it("rejects wildcards on a top-level domain, in the middle, or glued to a label", () => {
    for (const bad of ["*.com", "*sharepoint.com", "contoso.*.com", "*.", "*"])
      expect(normalizeDownloadHost(bad), bad).toBeUndefined();
  });
});

describe("mergeDownloadHostSuggestions with wildcards", () => {
  it("treats a suggestion already covered by a configured `*.` wildcard as present", () => {
    expect(
      mergeDownloadHostSuggestions(
        ["*.sharepoint.com"],
        ["contoso.sharepoint.com", "contoso-my.sharepoint.com", "files.example.com"]
      )
    ).toEqual(["*.sharepoint.com", "files.example.com"]);
  });
});
