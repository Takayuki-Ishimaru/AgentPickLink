import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

describe("application argument errors over real stdio", () => {
  it("keeps typed discovery and one structured error contract at the SDK boundary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-stdio-errors-"));
    const modulePath = path.join(directory, "server.mjs");
    await symlink(
      path.resolve("node_modules"),
      path.join(directory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await build({
      entryPoints: ["src/frontend/mcp-server.ts"],
      outfile: modulePath,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      logLevel: "silent"
    });
    const source = `import { serveStdio } from ${JSON.stringify(pathToFileURL(modulePath).href)};
      const broker = {
        list: async (_root, requestId) => ({ok:true,requestId,workspace:{configured:false,approvalStatus:'not-configured'},agents:[]}),
        ask: async () => {throw new Error('Unexpected broker ask');},
        session: async () => {throw new Error('Unexpected broker session');}
      };
      await serveStdio(broker, () => '/fixture');`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--input-type=module", "-e", source],
      stderr: "pipe"
    });
    const client = new Client({ name: "stdio-regression", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const ask = listed.tools.find((tool) => tool.name === "m365_agent_ask")!;
      expect(ask.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["agent", "message"],
        properties: { message: { type: "string" } }
      });
      const cases = [
        { name: "m365_agent_ask", arguments: { agent: "BAD", message: "hello" } },
        ...[42, null, [], {}, true].map((message) => ({
          name: "m365_agent_ask",
          arguments: { agent: "requirements", message }
        })),
        { name: "m365_agent_ask", arguments: { agent: "requirements" } },
        { name: "m365_agent_ask", arguments: { message: "hello" } },
        { name: "m365_agent_ask", arguments: {} },
        { name: "m365_agent_ask", arguments: { agent: "requirements", message: "hello", extra: 1 } },
        {
          name: "m365_agent_ask",
          arguments: { agent: "requirements", message: "hello", conversationHandle: 42 }
        },
        { name: "m365_agent_session", arguments: { action: ["list"] } },
        { name: "m365_agent_session", arguments: { action: null } },
        { name: "m365_agent_session", arguments: {} },
        { name: "m365_agent_list", arguments: { extra: true } }
      ];
      const results = await Promise.all(
        cases.map((args) => client.callTool(args, undefined, { timeout: 3_000 }))
      );
      const requestIds = new Set();
      for (const result of results) {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          ok: false,
          requestId: expect.any(String),
          error: { code: "INVALID_ARGUMENT", retryable: false }
        });
        requestIds.add((result.structuredContent as { requestId: string }).requestId);
      }
      expect(requestIds.size).toBe(cases.length);
      await expect(client.callTool({ name: "unknown", arguments: {} })).rejects.toThrow("Unknown MCP tool");
      const valid = await client.callTool({ name: "m365_agent_list", arguments: {} });
      expect(valid.structuredContent).toMatchObject({ ok: true, agents: [] });
    } finally {
      await client.close();
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
