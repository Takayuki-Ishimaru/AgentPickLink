import { describe, expect, it } from "vitest";
import { runLogout } from "../../src/cli/commands/logout.js";
import { makeCommandDeps, makeFakeBrokerClient, makeScriptedPrompter, makeTempPaths } from "./helpers.js";

describe("logout", () => {
  it("requires confirmation; a decline never calls resetProfile", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient();
    const prompter = makeScriptedPrompter({ confirmAnswer: false });
    const { deps } = makeCommandDeps({
      paths,
      prompter,
      connectOrStartDefaultBroker: async () => broker as never
    });

    await expect(runLogout(deps)).rejects.toThrow(/not confirmed/i);
    expect(broker.calls.filter((call) => call.method === "browser.resetProfile")).toHaveLength(0);
  });

  it("confirmed logout calls resetProfile exactly once, then shuts down the broker", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient();
    const prompter = makeScriptedPrompter({ confirmAnswer: true });
    const { deps } = makeCommandDeps({
      paths,
      prompter,
      connectOrStartDefaultBroker: async () => broker as never
    });

    const result = await runLogout(deps);

    expect(result).toEqual({ loggedOut: true });
    expect(broker.calls.filter((call) => call.method === "browser.resetProfile")).toHaveLength(1);
    expect(broker.calls.map((call) => call.method)).toEqual(["browser.resetProfile", "broker.shutdown"]);
    expect(broker.closed).toBe(true);
  });

  it("the confirmation prompt and result text do not claim a global Microsoft 365 session was revoked", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient();
    const prompter = makeScriptedPrompter({ confirmAnswer: true });
    const { deps } = makeCommandDeps({
      paths,
      prompter,
      connectOrStartDefaultBroker: async () => broker as never
    });

    await runLogout(deps);

    const shown = prompter.confirmCalls.join(" ");
    expect(shown).toMatch(/automation profile/i);
    expect(shown).not.toMatch(/all sessions|globally|every device/i);
  });

  it("--yes skips the prompt but still calls resetProfile exactly once", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient();
    const prompter = makeScriptedPrompter({ confirmAnswer: false });
    const { deps } = makeCommandDeps({
      paths,
      prompter,
      connectOrStartDefaultBroker: async () => broker as never
    });

    const result = await runLogout(deps, { yes: true });

    expect(prompter.confirmCalls).toHaveLength(0);
    expect(result).toEqual({ loggedOut: true });
    expect(broker.calls.filter((call) => call.method === "browser.resetProfile")).toHaveLength(1);
  });
});
