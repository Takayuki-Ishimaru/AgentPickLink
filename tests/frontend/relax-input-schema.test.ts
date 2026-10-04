import { describe, expect, it } from "vitest";
import { PUBLIC_TOOLS } from "../../src/frontend/mcp-server.js";
import { askInputSchema, sessionInputSchema } from "../../src/frontend/schemas.js";

describe("public input schemas", () => {
  it("keeps typed strict schemas for discovery while application validation owns errors", () => {
    expect(PUBLIC_TOOLS.find((tool) => tool.name === "m365_agent_ask")?.inputSchema).toBe(askInputSchema);
    expect(askInputSchema).toMatchObject({
      type: "object",
      required: ["agent", "message"],
      additionalProperties: false
    });
    expect(askInputSchema.properties.message.type).toBe("string");
    expect(sessionInputSchema.properties.action.enum).toEqual(["new", "list", "close", "close_all"]);
  });
});
