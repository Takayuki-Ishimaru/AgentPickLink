import { describe, expect, it } from "vitest";
import { readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuditLogger } from "../../src/observability/audit.js";
describe("audit logger", () => {
  it("allowlists metadata and drops injected prompt/response fields", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-audit-"));
    const event = {
      event: "agent.invoke.complete",
      requestId: "req",
      workspace: "wk",
      agent: "a",
      conversation: "conv_x",
      durationMs: 1,
      requestChars: 99,
      responseChars: 42,
      citationCount: 0,
      status: "success",
      prompt: "super secret prompt",
      response: "secret answer",
      fullUrl: "https://tenant.example/secret"
    } as const;
    await new AuditLogger(directory).write(event);
    const line = await readFile(path.join(directory, "audit.jsonl"), "utf8");
    expect(line).not.toContain("secret");
    expect(JSON.parse(line)).not.toHaveProperty("prompt");
    expect(JSON.parse(line)).not.toHaveProperty("response");
    expect(JSON.parse(line)).not.toHaveProperty("fullUrl");
  });
});
