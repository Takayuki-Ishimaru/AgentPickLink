import { describe, expect, it } from "vitest";
import { PUBLIC_TOOLS, createRequestHandler } from "../../src/frontend/mcp-server.js";
import type { FrontendBrokerPort } from "../../src/frontend/broker-port.js";
import { MCP_AGENT_LIST_STATUSES } from "../../src/frontend/schemas.js";

describe("MCP public surface", () => {
  it("contains exactly the three domain tools", () => {
    expect(PUBLIC_TOOLS.map((tool) => tool.name)).toEqual([
      "m365_agent_list",
      "m365_agent_ask",
      "m365_agent_session"
    ]);
    expect(
      PUBLIC_TOOLS.every(
        (tool) => tool.inputSchema.additionalProperties === false || tool.inputSchema.$comment
      )
    ).toBe(true);
  });
  it("rejects unknown tools as protocol-level errors", async () => {
    const broker: FrontendBrokerPort = {
      list: async () => ({ code: "BROKER_UNAVAILABLE", message: "offline", retryable: true }),
      ask: async () => ({ code: "BROKER_UNAVAILABLE", message: "offline", retryable: true }),
      session: async () => ({ code: "BROKER_UNAVAILABLE", message: "offline", retryable: true })
    };
    await expect(
      createRequestHandler(broker, () => "C:\\repo").callTool("browser.click", {})
    ).rejects.toThrow("Unknown MCP tool");
  });
  it("advertises exactly the two statuses publicRoster can emit for m365_agent_list, matching the broker contract", () => {
    expect(MCP_AGENT_LIST_STATUSES).toEqual(["ready", "approval-required"]);
    const listTool = PUBLIC_TOOLS.find((tool) => tool.name === "m365_agent_list")!;
    const success = (
      listTool.outputSchema as {
        oneOf: Array<{
          properties?: { agents?: { items?: { properties?: { status?: { enum?: string[] } } } } };
        }>;
      }
    ).oneOf[0];
    expect(success.properties?.agents?.items?.properties?.status?.enum).toEqual([
      "ready",
      "approval-required"
    ]);
    expect(listTool.description).toContain("workspace validate");
  });
});
