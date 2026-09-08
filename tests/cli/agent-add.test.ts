import { describe, expect, it } from "vitest";
import { runAgentAdd } from "../../src/cli/commands/agent-add.js";
import { loadRegistry } from "../../src/config/registry.js";
import {
  capturedAgent,
  makeCommandDeps,
  makeFakeBrokerClient,
  makeScriptedPrompter,
  makeTempPaths
} from "./helpers.js";

const env = {
  M365_AGENT_ALIAS: "requirements",
  M365_AGENT_DISPLAY_NAME: "Requirements",
  M365_AGENT_KIND: "m365-agent-builder",
  M365_AGENT_CAPABILITY_CLASS: "knowledge-only",
  M365_AGENT_DESCRIPTION: "",
  M365_AGENT_USAGE_HINT: ""
};

describe("agent add", () => {
  it("--force always saves enabled:false and verification.status unverified, even when inspection succeeds", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({ "agent.inspectUrl": capturedAgent() });
    const { deps } = makeCommandDeps({
      paths,
      env,
      connectOrStartDefaultBroker: async () => broker as never
    });

    const result = await runAgentAdd(deps, {
      url: "https://m365.cloud.microsoft/chat/requirements",
      force: true
    });

    expect(result).toMatchObject({ added: true, enabled: false, verificationStatus: "unverified" });
    const registry = await loadRegistry(paths);
    expect(registry.agents[0]).toMatchObject({
      enabled: false,
      verification: expect.objectContaining({ status: "unverified" })
    });
  });

  it("--url must pass allowlist validation for the broker's inspectUrl call", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({ "agent.inspectUrl": capturedAgent() });
    const { deps } = makeCommandDeps({
      paths,
      env,
      connectOrStartDefaultBroker: async () => broker as never
    });

    await runAgentAdd(deps, { url: "https://m365.cloud.microsoft/chat/requirements" });

    expect(broker.calls[0]).toMatchObject({
      method: "agent.inspectUrl",
      params: { url: "https://m365.cloud.microsoft/chat/requirements" }
    });
  });

  it("a successful --url registration is saved as verified and enabled", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({ "agent.inspectUrl": capturedAgent() });
    const { deps } = makeCommandDeps({
      paths,
      env,
      connectOrStartDefaultBroker: async () => broker as never
    });

    const result = await runAgentAdd(deps, { url: "https://m365.cloud.microsoft/chat/requirements" });

    expect(result).toMatchObject({ added: true, enabled: true, verificationStatus: "verified" });
  });

  it("registration requires an interactive terminal or M365_AGENT_ALIAS when metadata is not scripted", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({ "agent.inspectUrl": capturedAgent() });
    const prompter = makeScriptedPrompter({ interactive: false });
    const { deps } = makeCommandDeps({
      paths,
      env: {},
      prompter,
      connectOrStartDefaultBroker: async () => broker as never
    });

    await expect(
      runAgentAdd(deps, { url: "https://m365.cloud.microsoft/chat/requirements" })
    ).rejects.toThrow(/interactive terminal/i);
  });
});
