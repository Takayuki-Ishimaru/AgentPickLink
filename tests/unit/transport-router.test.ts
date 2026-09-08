import { describe, expect, it } from "vitest";
import { TransportRouter } from "../../src/transports/transport-router.js";
import type { AgentTransport } from "../../src/transports/transport.js";
import type { BrowserAgentDefinition, WorkIqAgentDefinition } from "../../src/domain/agent.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const browserAgent: BrowserAgentDefinition = {
  alias: "requirements",
  displayName: "Requirements",
  kind: "m365-agent-builder",
  transport: "browser",
  entryPoint: { mode: "direct-chat", url: "https://m365.example.test/chat", surface: "m365-copilot" },
  enabled: true,
  capabilityClass: "knowledge-only",
  uiActionPolicy: "never-click",
  verification: {
    status: "verified",
    adapterId: "fixture@1",
    expectedDisplayName: "Requirements",
    expectedSurface: "m365-copilot",
    validatedUrlPattern: "^/chat$",
    bindingFingerprint: fingerprint,
    validatedAt: "2026-09-01T00:00:00.000Z"
  }
};
const workIqAgent: WorkIqAgentDefinition = { alias: "work-iq-agent", transport: "work-iq", enabled: false };

function fakeTransport(name: string): AgentTransport {
  return {
    name,
    healthCheck: async () => ({ healthy: true }),
    validateAgent: async () => ({ valid: true }),
    createConversation: async () => ({ transportId: name, opaque: "x" }),
    invoke: async () => {
      throw new Error("not used");
    },
    closeConversation: async () => undefined,
    dispose: async () => undefined
  };
}

describe("TransportRouter", () => {
  it("selects the registered browser transport for a browser agent", () => {
    const browser = fakeTransport("browser");
    const router = new TransportRouter().register("browser", browser);
    expect(router.select(browserAgent)).toBe(browser);
    expect(router.get("browser")).toBe(browser);
  });

  it("rejects an agent whose transport kind has no registered implementation", () => {
    const router = new TransportRouter().register("browser", fakeTransport("browser"));
    expect(() => router.select(workIqAgent)).toThrowError(
      expect.objectContaining({ code: "AGENT_ENTRYPOINT_UNSUPPORTED" })
    );
  });

  it("reports every registered transport kind", () => {
    const router = new TransportRouter().register("browser", fakeTransport("browser"));
    expect(router.registeredKinds()).toEqual(["browser"]);
  });

  it("disposes every registered transport and swallows individual failures", async () => {
    let disposedA = false;
    let disposedB = false;
    const a: AgentTransport = {
      ...fakeTransport("browser"),
      dispose: async () => {
        disposedA = true;
      }
    };
    const b: AgentTransport = {
      ...fakeTransport("work-iq"),
      dispose: async () => {
        disposedB = true;
        throw new Error("boom");
      }
    };
    const router = new TransportRouter().register("browser", a).register("work-iq", b);
    await expect(router.disposeAll()).resolves.toBeUndefined();
    expect(disposedA).toBe(true);
    expect(disposedB).toBe(true);
  });
});
