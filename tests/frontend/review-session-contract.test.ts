import { describe, expect, it, vi } from "vitest";
import { createToolHandlers, TOOL_DESCRIPTIONS } from "../../src/frontend/tools.js";
import type { FrontendBrokerPort } from "../../src/frontend/broker-port.js";
import { parseMethod } from "../../src/ipc/schemas.js";

describe("consistent agent session contract", () => {
  it("accepts display names through both the tool and IPC boundaries", async () => {
    const session = vi.fn(async (_root, input, requestId) => ({
      ok: true as const,
      requestId,
      action: input.action,
      conversation: {
        conversationHandle: "conv_test",
        agent: "design",
        createdAt: "2026-10-29T00:00:00Z",
        lastUsedAt: "2026-10-29T00:00:00Z"
      }
    }));
    const tools = createToolHandlers({ session } as unknown as FrontendBrokerPort, () => "/workspace");
    const result = await tools.m365_agent_session({ action: "new", agent: "設計エージェント" });
    expect(result.isError).not.toBe(true);
    expect(session.mock.calls[0][1].agent).toBe("設計エージェント");
    expect(result.structuredContent).toMatchObject({
      conversationHandle: "conv_test",
      conversation: { conversationHandle: "conv_test" }
    });
    expect(
      parseMethod("conversation.create", { root: "/workspace", agent: "設計エージェント" }).params.agent
    ).toBe("設計エージェント");
  });
  it.each(["", "   ", "name\nother", "x".repeat(257)])(
    "refuses an invalid selection %j before forwarding",
    async (agent) => {
      const session = vi.fn();
      const tools = createToolHandlers({ session } as unknown as FrontendBrokerPort, () => "/workspace");
      expect((await tools.m365_agent_session({ action: "new", agent })).isError).toBe(true);
      expect(session).not.toHaveBeenCalled();
      expect(() => parseMethod("conversation.create", { root: "/workspace", agent })).toThrow();
    }
  );
  it("keeps tool descriptions compact while preserving uncertainty guidance", () => {
    expect(TOOL_DESCRIPTIONS.m365_agent_ask.length).toBeLessThan(1200);
    expect(TOOL_DESCRIPTIONS.m365_agent_session.length).toBeLessThan(1000);
    expect(TOOL_DESCRIPTIONS.m365_agent_ask).toContain("Never automatically resend");
    expect(TOOL_DESCRIPTIONS.m365_agent_session).toContain("Only message=not-shown");
  });
});
