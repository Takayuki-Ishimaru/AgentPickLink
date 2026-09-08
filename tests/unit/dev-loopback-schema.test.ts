import { afterEach, describe, expect, it, vi } from "vitest";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;

function registryWith(url: string): unknown {
  return {
    version: 1,
    agents: [
      {
        alias: "agent",
        displayName: "Agent",
        kind: "m365-agent-builder",
        transport: "browser",
        entryPoint: { mode: "direct-chat", url, surface: "m365-copilot" },
        enabled: true,
        capabilityClass: "knowledge-only",
        uiActionPolicy: "never-click",
        verification: {
          status: "verified",
          adapterId: "agent-builder-chat@1",
          expectedDisplayName: "Agent",
          expectedSurface: "m365-copilot",
          validatedUrlPattern: "^/chat/agent/x$",
          bindingFingerprint: FINGERPRINT,
          validatedAt: "2026-09-01T00:00:00.000Z"
        }
      }
    ]
  };
}

/** The switch is read once when the schema module loads, so every case reloads it. */
async function registrySchema(devLoopback: boolean) {
  vi.resetModules();
  if (devLoopback) process.env.M365_AGENT_DEV_INSECURE_LOOPBACK = "1";
  else delete process.env.M365_AGENT_DEV_INSECURE_LOOPBACK;
  return (await import("../../src/config/schema.js")).RegistrySchema;
}

afterEach(() => {
  delete process.env.M365_AGENT_DEV_INSECURE_LOOPBACK;
  vi.resetModules();
});

describe("registry entry-point URLs and the development loopback switch", () => {
  it("accepts only credential-free https on the default port by default", async () => {
    const schema = await registrySchema(false);
    expect(schema.safeParse(registryWith("https://m365.cloud.microsoft/chat/agent/x")).success).toBe(true);
    expect(schema.safeParse(registryWith("http://127.0.0.1:47831/chat/agent/x")).success).toBe(false);
    expect(schema.safeParse(registryWith("http://localhost/chat/agent/x")).success).toBe(false);
    expect(schema.safeParse(registryWith("https://user:pw@m365.cloud.microsoft/chat")).success).toBe(false);
  });

  it("additionally accepts http on the loopback interface only when the switch is on", async () => {
    const schema = await registrySchema(true);
    expect(schema.safeParse(registryWith("http://127.0.0.1:47831/chat/agent/x")).success).toBe(true);
    expect(schema.safeParse(registryWith("http://localhost:8080/chat/agent/x")).success).toBe(true);
    expect(schema.safeParse(registryWith("http://m365.example.test/chat/agent/x")).success).toBe(false);
    expect(schema.safeParse(registryWith("http://10.0.0.5/chat/agent/x")).success).toBe(false);
    expect(schema.safeParse(registryWith("https://m365.cloud.microsoft:8443/chat")).success).toBe(false);
  });
});
