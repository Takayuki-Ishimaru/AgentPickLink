import { describe, expect, it } from "vitest";
import { relaxInputSchemaForSdk } from "../../src/frontend/mcp-server.js";
import { askInputSchema, sessionInputSchema } from "../../src/frontend/schemas.js";

describe("relaxInputSchemaForSdk", () => {
  it("keeps type and description for every property", () => {
    const relaxed = relaxInputSchemaForSdk(askInputSchema);
    expect(relaxed.type).toBe("object");
    const properties = relaxed.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["agent", "message", "conversationHandle"]);
    for (const key of ["agent", "message", "conversationHandle"]) {
      expect(properties[key].type).toBe("string");
      expect(typeof properties[key].description).toBe("string");
      expect((properties[key].description as string).length).toBeGreaterThan(0);
    }
  });

  it("strips required, additionalProperties, pattern, minLength/maxLength, and enum", () => {
    const relaxed = relaxInputSchemaForSdk(askInputSchema);
    expect(relaxed.required).toBeUndefined();
    expect(relaxed.additionalProperties).toBeUndefined();
    const properties = relaxed.properties as Record<string, Record<string, unknown>>;
    for (const key of Object.keys(properties)) {
      expect(properties[key].pattern).toBeUndefined();
      expect(properties[key].minLength).toBeUndefined();
      expect(properties[key].maxLength).toBeUndefined();
      expect(properties[key].enum).toBeUndefined();
    }
  });

  it("folds a stripped enum's allowed values into the property description instead of dropping them", () => {
    const strictAction = (sessionInputSchema.properties as Record<string, { enum: string[] }>).action;
    const relaxed = relaxInputSchemaForSdk(sessionInputSchema);
    const properties = relaxed.properties as Record<string, Record<string, unknown>>;
    expect(properties.action.enum).toBeUndefined();
    for (const value of strictAction.enum) expect(properties.action.description as string).toContain(value);
  });

  it("falls back to a bare object schema when there are no properties (m365_agent_list)", () => {
    const relaxed = relaxInputSchemaForSdk({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    });
    expect(relaxed).toEqual({ type: "object", properties: {} });
  });
});
