import { describe, expect, it } from "vitest";
import { runAgentTest, TEST_MESSAGE } from "../../src/cli/commands/agent-test.js";
import { makeCommandDeps, makeFakeBrokerClient, makeScriptedPrompter, makeTempPaths } from "./helpers.js";

describe("agent test", () => {
  it("default behavior sends nothing and never prompts", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({ "agent.validate": { ok: true } });
    const prompter = makeScriptedPrompter();
    const { deps } = makeCommandDeps({
      paths,
      prompter,
      connectOrStartDefaultBroker: async () => broker as never
    });

    await runAgentTest(deps, "requirements", {});

    expect(prompter.confirmCalls).toHaveLength(0);
    expect(broker.calls).toEqual([
      { method: "agent.validate", params: { agent: "requirements", sendTestMessage: false } }
    ]);
  });

  it("--send-test-message shows the exact test message and requires confirmation", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({ "agent.validate": { ok: true } });
    const prompter = makeScriptedPrompter({ confirmAnswer: true });
    const { deps } = makeCommandDeps({
      paths,
      prompter,
      connectOrStartDefaultBroker: async () => broker as never
    });

    await runAgentTest(deps, "requirements", { sendTestMessage: true });

    expect(prompter.confirmCalls).toHaveLength(1);
    expect(prompter.confirmCalls[0]).toContain(TEST_MESSAGE);
    expect(broker.calls).toEqual([
      { method: "agent.validate", params: { agent: "requirements", sendTestMessage: true } }
    ]);
  });

  it("a declined confirmation sends nothing", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({ "agent.validate": { ok: true } });
    const prompter = makeScriptedPrompter({ confirmAnswer: false });
    const { deps } = makeCommandDeps({
      paths,
      prompter,
      connectOrStartDefaultBroker: async () => broker as never
    });

    await expect(runAgentTest(deps, "requirements", { sendTestMessage: true })).rejects.toThrow(
      /not confirmed/i
    );
    expect(broker.calls).toHaveLength(0);
  });

  it("--yes bypasses the confirmation and still sends the test message", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({ "agent.validate": { ok: true } });
    const prompter = makeScriptedPrompter({ confirmAnswer: false });
    const { deps } = makeCommandDeps({
      paths,
      prompter,
      connectOrStartDefaultBroker: async () => broker as never
    });

    await runAgentTest(deps, "requirements", { sendTestMessage: true, yes: true });

    expect(prompter.confirmCalls).toHaveLength(0);
    expect(broker.calls).toEqual([
      { method: "agent.validate", params: { agent: "requirements", sendTestMessage: true } }
    ]);
  });
});
