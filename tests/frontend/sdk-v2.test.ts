import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendBrokerPort } from "../../src/frontend/broker-port.js";
import { createSdkServer } from "../../src/frontend/mcp-server.js";

const minimalBroker: FrontendBrokerPort = {
  list: async (_root, requestId) => ({
    ok: true,
    requestId,
    workspace: { configured: true, approvalStatus: "approved" },
    agents: []
  }),
  ask: async (_root, input, requestId) => ({
    ok: true,
    requestId,
    agent: input.agent,
    conversationHandle: "conv_x",
    text: "answer",
    citations: [],
    attachments: [],
    elapsedMs: 1,
    truncated: false,
    actionRequired: false,
    submissionState: "sent",
    sourceType: "m365-agent"
  }),
  session: async (_root, input, requestId) => ({
    ok: true,
    requestId,
    action: input.action,
    conversations: []
  })
};

describe("MCP SDK v2 integration", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("negotiates, exposes exactly three tools, and validates structured output", async () => {
    const broker: FrontendBrokerPort = {
      list: async (_root, requestId) => ({
        ok: true,
        requestId,
        workspace: { configured: true, approvalStatus: "approved" },
        agents: [
          {
            alias: "requirements",
            name: "Requirements",
            kind: "m365-agent-builder",
            capabilityClass: "knowledge-only",
            status: "ready"
          }
        ]
      }),
      ask: async (_root, input, requestId) => ({
        ok: true,
        requestId,
        agent: input.agent,
        conversationHandle: "conv_sdk_test",
        text: "answer",
        citations: [{ title: "Source", url: "https://example.test/doc" }],
        elapsedMs: 1,
        truncated: false,
        actionRequired: false,
        submissionState: "sent",
        sourceType: "m365-agent"
      }),
      session: async (_root, input, requestId) => ({
        ok: true,
        requestId,
        action: input.action,
        conversations: []
      })
    };
    const server = await createSdkServer(broker, () => "C:\\workspace");
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(
      () => client.close(),
      () => server.close()
    );
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "m365_agent_list",
      "m365_agent_ask",
      "m365_agent_session"
    ]);
    const called = await client.callTool({
      name: "m365_agent_ask",
      arguments: { agent: "requirements", message: "hello" }
    });
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toMatchObject({ ok: true, conversationHandle: "conv_sdk_test" });
  });

  it("still exposes argument names on tools/list (relaxed, not permissive-to-emptiness) so clients like Copilot can learn the tool's shape", async () => {
    const broker: FrontendBrokerPort = {
      list: async (_root, requestId) => ({
        ok: true,
        requestId,
        workspace: { configured: true, approvalStatus: "approved" },
        agents: []
      }),
      ask: async (_root, input, requestId) => ({
        ok: true,
        requestId,
        agent: input.agent,
        conversationHandle: "conv_x",
        text: "answer",
        citations: [],
        elapsedMs: 1,
        truncated: false,
        actionRequired: false,
        submissionState: "sent",
        sourceType: "m365-agent"
      }),
      session: async (_root, input, requestId) => ({
        ok: true,
        requestId,
        action: input.action,
        conversations: []
      })
    };
    const server = await createSdkServer(broker, () => "C:\\workspace");
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(
      () => client.close(),
      () => server.close()
    );

    const listed = await client.listTools();
    const ask = listed.tools.find((tool) => tool.name === "m365_agent_ask")!;
    const askProperties = ask.inputSchema.properties as Record<string, { description?: string }>;
    expect(Object.keys(askProperties)).toEqual(
      expect.arrayContaining(["agent", "message", "conversationHandle"])
    );
    for (const key of ["agent", "message", "conversationHandle"])
      expect(typeof askProperties[key].description).toBe("string");

    const session = listed.tools.find((tool) => tool.name === "m365_agent_session")!;
    const sessionProperties = session.inputSchema.properties as Record<string, { description?: string }>;
    expect(Object.keys(sessionProperties)).toEqual(expect.arrayContaining(["action"]));
    expect(sessionProperties.action.description).toContain("new");
  });

  it("returns a structured INVALID_ARGUMENT envelope for an unknown input field instead of a bare SDK validation error", async () => {
    const broker: FrontendBrokerPort = {
      list: async (_root, requestId) => ({
        ok: true,
        requestId,
        workspace: { configured: true, approvalStatus: "approved" },
        agents: []
      }),
      ask: async (_root, input, requestId) => ({
        ok: true,
        requestId,
        agent: input.agent,
        conversationHandle: "conv_x",
        text: "answer",
        citations: [],
        elapsedMs: 1,
        truncated: false,
        actionRequired: false,
        submissionState: "sent",
        sourceType: "m365-agent"
      }),
      session: async (_root, input, requestId) => ({
        ok: true,
        requestId,
        action: input.action,
        conversations: []
      })
    };
    const server = await createSdkServer(broker, () => "C:\\workspace");
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(
      () => client.close(),
      () => server.close()
    );

    const unknownField = await client.callTool({
      name: "m365_agent_ask",
      arguments: { agent: "requirements", message: "hello", extraneous: "nope" }
    });
    expect(unknownField.isError).toBe(true);
    expect(unknownField.structuredContent).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect((unknownField.structuredContent as { requestId?: string }).requestId).toEqual(expect.any(String));

    const badAlias = await client.callTool({
      name: "m365_agent_ask",
      arguments: { agent: "NOT-A-VALID-ALIAS!!", message: "hello" }
    });
    expect(badAlias.isError).toBe(true);
    expect(badAlias.structuredContent).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect((badAlias.structuredContent as { requestId?: string }).requestId).toEqual(expect.any(String));
  });

  it("forwards broker progress events as MCP notifications/progress when the client supplies a progress token", async () => {
    const broker: FrontendBrokerPort = {
      ...minimalBroker,
      ask: async (_root, input, requestId, _signal, onProgress) => {
        onProgress?.({ phase: "submitted", elapsedMs: 1_200 });
        onProgress?.({ phase: "waiting-response", elapsedMs: 5_000 });
        onProgress?.({ phase: "streaming", elapsedMs: 12_000, responseChars: 1_240 });
        return {
          ok: true,
          requestId,
          agent: input.agent,
          conversationHandle: "conv_progress",
          text: "answer",
          citations: [],
          attachments: [],
          elapsedMs: 12_000,
          truncated: false,
          actionRequired: false,
          submissionState: "sent",
          sourceType: "m365-agent"
        };
      }
    };
    const server = await createSdkServer(broker, () => "C:\\workspace");
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(
      () => client.close(),
      () => server.close()
    );

    const notifications: Array<{ progress: number; message?: string }> = [];
    const result = await client.callTool(
      { name: "m365_agent_ask", arguments: { agent: "requirements", message: "hello" } },
      {
        onprogress: (progress) =>
          notifications.push({ progress: progress.progress, message: progress.message })
      }
    );

    expect(result.isError).not.toBe(true);
    expect(notifications.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < notifications.length; i++) {
      expect(notifications[i].progress).toBeGreaterThan(notifications[i - 1].progress);
    }
    for (const notification of notifications) {
      expect(typeof notification.message).toBe("string");
      expect(notification.message!.length).toBeGreaterThan(0);
      // Never leak prompt/response text into a progress message.
      expect(notification.message).not.toContain("hello");
      expect(notification.message).not.toContain("answer");
    }
  });

  it("forwards the human sign-in wait when creating a session through the SDK", async () => {
    const broker: FrontendBrokerPort = {
      ...minimalBroker,
      session: async (_root, _input, requestId, _signal, onProgress) => {
        onProgress?.({ phase: "login-waiting", elapsedMs: 2_000 });
        onProgress?.({ phase: "connecting" });
        return {
          ok: true,
          requestId,
          action: "new",
          conversation: {
            conversationHandle: "conv_login",
            agent: "requirements",
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString()
          }
        };
      }
    };
    const server = await createSdkServer(broker, () => "C:\\workspace");
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(
      () => client.close(),
      () => server.close()
    );
    const notifications: string[] = [];
    const result = await client.callTool(
      { name: "m365_agent_session", arguments: { action: "new", agent: "requirements" } },
      { onprogress: (progress) => notifications.push(progress.message ?? "") }
    );
    expect(result.isError).not.toBe(true);
    expect(notifications[0]).toContain("complete Microsoft 365 login in the AgentPickLink window");
    expect(notifications[0]).toContain("resume automatically");
    expect(notifications[1]).toBe("connecting");
  });

  it("sends no progress notifications when the client supplies no progress token", async () => {
    const broker: FrontendBrokerPort = {
      ...minimalBroker,
      ask: async (_root, input, requestId, _signal, onProgress) => {
        onProgress?.({ phase: "submitted", elapsedMs: 1_000 });
        return minimalBroker.ask("C:\\workspace", input, requestId);
      }
    };
    const server = await createSdkServer(broker, () => "C:\\workspace");
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(
      () => client.close(),
      () => server.close()
    );

    const notifications: unknown[] = [];
    client.setNotificationHandler("notifications/progress", async (notification) => {
      notifications.push(notification);
    });
    const result = await client.callTool({
      name: "m365_agent_ask",
      arguments: { agent: "requirements", message: "hello" }
    });
    expect(result.isError).not.toBe(true);
    expect(notifications).toEqual([]);
  });

  it("serves saved attachments through resources/read, scoped to the attachments directory", async () => {
    const attachmentsDirectory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const textPath = path.join(attachmentsDirectory, "note.txt");
    const pdfPath = path.join(attachmentsDirectory, "report.pdf");
    await writeFile(textPath, "hello attachment", "utf8");
    const pdfBytes = Buffer.from("%PDF-1.4 fake pdf bytes", "utf8");
    await writeFile(pdfPath, pdfBytes);
    const outsidePath = path.join(os.tmpdir(), `apl-outside-${Date.now()}.txt`);
    await writeFile(outsidePath, "should never be readable", "utf8");

    try {
      const server = await createSdkServer(minimalBroker, () => "C:\\workspace", { attachmentsDirectory });
      const client = new Client({ name: "test-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      closers.push(
        () => client.close(),
        () => server.close()
      );

      const textResult = await client.readResource({ uri: pathToFileURL(textPath).href });
      expect(textResult.contents).toHaveLength(1);
      expect(textResult.contents[0]).toMatchObject({ mimeType: "text/plain" });
      expect((textResult.contents[0] as { text?: string }).text).toBe("hello attachment");
      expect((textResult.contents[0] as { blob?: string }).blob).toBeUndefined();

      const pdfResult = await client.readResource({ uri: pathToFileURL(pdfPath).href });
      expect(pdfResult.contents).toHaveLength(1);
      expect(pdfResult.contents[0]).toMatchObject({ mimeType: "application/pdf" });
      expect((pdfResult.contents[0] as { blob?: string }).blob).toBe(pdfBytes.toString("base64"));
      expect((pdfResult.contents[0] as { text?: string }).text).toBeUndefined();

      await expect(client.readResource({ uri: pathToFileURL(outsidePath).href })).rejects.toThrow();
    } finally {
      await rm(attachmentsDirectory, { recursive: true, force: true });
      await rm(outsidePath, { force: true });
    }
  });
});
