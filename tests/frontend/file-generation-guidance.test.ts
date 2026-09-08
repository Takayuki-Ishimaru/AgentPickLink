import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import type { FrontendBrokerPort } from "../../src/frontend/broker-port.js";
import { createSdkServer } from "../../src/frontend/mcp-server.js";
import { FILE_GENERATION_INSTRUCTIONS } from "../../src/frontend/file-generation-guidance.js";

it("delivers portability guidance during MCP negotiation without rewriting the caller's message", async () => {
  const messages: string[] = [];
  const broker: FrontendBrokerPort = {
    list: async () => {
      throw new Error("unused");
    },
    session: async () => {
      throw new Error("unused");
    },
    ask: async (_root, input, requestId) => {
      messages.push(input.message);
      return {
        ok: true,
        requestId,
        agent: input.agent,
        conversationHandle: "conv_test",
        text: "完了",
        citations: [],
        attachments: [],
        elapsedMs: 1,
        truncated: false,
        actionRequired: false,
        submissionState: "sent",
        sourceType: "m365-agent"
      };
    }
  };
  const server = await createSdkServer(broker, () => "/workspace");
  const client = new Client({ name: "file-quality-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(client.getInstructions()).toBe(FILE_GENERATION_INSTRUCTIONS);
    const message = "日本語の表をPDFにしてください。内容は変更しないでください。";
    const result = await client.callTool({
      name: "m365_agent_ask",
      arguments: { agent: "pdf", message }
    });
    expect(result.isError).not.toBe(true);
    expect(messages).toEqual([message]);
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "m365_agent_ask")?.description).toContain(
      "embedded in PDFs"
    );
  } finally {
    await client.close();
    await server.close();
  }
});
