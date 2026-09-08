import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { askOutputSchema, listOutputSchema, sessionOutputSchema } from "../../src/frontend/schemas.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

describe("pageKey never reaches the public MCP surface or the IPC wire contract", () => {
  it("keeps pageKey out of the public MCP JSON output schemas", () => {
    for (const schema of [listOutputSchema, askOutputSchema, sessionOutputSchema]) {
      expect(JSON.stringify(schema)).not.toContain("pageKey");
    }
  });

  it("keeps pageKey out of src/frontend/schemas.ts entirely", () => {
    const source = readFileSync(path.join(repoRoot, "src/frontend/schemas.ts"), "utf8");
    expect(source).not.toContain("pageKey");
  });

  it("keeps pageKey out of the IPC method schemas in src/ipc/schemas.ts", () => {
    const source = readFileSync(path.join(repoRoot, "src/ipc/schemas.ts"), "utf8");
    expect(source).not.toContain("pageKey");
  });
});
