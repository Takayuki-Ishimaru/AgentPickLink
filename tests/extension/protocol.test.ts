import { describe, expect, it } from "vitest";
import { parseWebviewMessage } from "../../src/extension/protocol.js";
import { pickLocale, translate } from "../../src/extension/localize.js";

describe("parseWebviewMessage", () => {
  it("accepts the simple command messages", () => {
    for (const type of [
      "ready",
      "setup",
      "refresh",
      "discover",
      "signIn",
      "signOut",
      "cancelSignIn",
      "revokeWorkspace",
      "restartBroker"
    ] as const)
      expect(parseWebviewMessage({ type })).toEqual({ type });
  });

  it("accepts unregisterAgent with a bounded key", () => {
    expect(parseWebviewMessage({ type: "unregisterAgent", key: "agent-a" })).toEqual({
      type: "unregisterAgent",
      key: "agent-a"
    });
    expect(parseWebviewMessage({ type: "unregisterAgent" })).toBeUndefined();
  });

  it("normalizes an updateConfig patch, dropping unknown channels and non-finite numbers", () => {
    expect(
      parseWebviewMessage({
        type: "updateConfig",
        patch: { headless: true, channel: "chrome", attachmentRetentionHours: 48.9, attachmentQuotaBytes: -5 }
      })
    ).toEqual({
      type: "updateConfig",
      patch: { headless: true, channel: "chrome", attachmentRetentionHours: 48, attachmentQuotaBytes: 0 }
    });
    expect(
      parseWebviewMessage({
        type: "updateConfig",
        patch: { channel: "firefox", attachmentRetentionHours: "x" }
      })
    ).toEqual({ type: "updateConfig", patch: {} });
    expect(parseWebviewMessage({ type: "updateConfig" })).toBeUndefined();
  });

  it("rejects anything that is not a known message", () => {
    expect(parseWebviewMessage(undefined)).toBeUndefined();
    expect(parseWebviewMessage("setup")).toBeUndefined();
    expect(parseWebviewMessage({ type: "executeCommand", command: "rm" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "addUrl" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "save" })).toBeUndefined();
  });

  it("bounds the strings it lets through", () => {
    const message = parseWebviewMessage({ type: "unregisterAgent", key: "x".repeat(5000) });
    expect(message).toEqual({ type: "unregisterAgent", key: "x".repeat(2048) });
    expect(
      parseWebviewMessage({ type: "addUrl", url: "https://m365.cloud.microsoft/chat/agent/a" })
    ).toBeUndefined();
  });

  it("normalizes a save plan and coerces every flag to a boolean", () => {
    const message = parseWebviewMessage({
      type: "save",
      plan: {
        agents: [
          { key: "a", displayName: "A", actionsPossible: "yes", usageHint: "Ask about X" },
          { displayName: "no key" },
          { key: "b", description: 42 }
        ],
        downloadHosts: ["files.example.com", 7],
        acceptDownloads: "true",
        integrations: { codex: true, claudeCode: 0 }
      }
    });
    expect(message).toEqual({
      type: "save",
      plan: {
        agents: [
          {
            key: "a",
            displayName: "A",
            usageHint: "Ask about X",
            actionsPossible: false
          },
          {
            key: "b",
            displayName: undefined,
            usageHint: undefined,
            actionsPossible: false
          }
        ],
        downloadHosts: ["files.example.com"],
        acceptDownloads: false,
        integrations: { codex: true, claudeCode: false, vscodeMcpJson: false }
      }
    });
  });
});

describe("localize", () => {
  it("uses Japanese only for ja* VS Code languages", () => {
    expect(pickLocale("ja")).toBe("ja");
    expect(pickLocale("ja-jp")).toBe("ja");
    expect(pickLocale("en-US")).toBe("en");
    expect(pickLocale(undefined)).toBe("en");
  });

  it("has both languages for every key it exposes", () => {
    expect(translate("ja", "approveConfirm")).toBe("承認して保存");
    expect(translate("en", "approveConfirm")).toBe("Approve and save");
    expect(translate("en", "approveBody")).toContain("Approve exactly these agents for this workspace?");
  });
});
