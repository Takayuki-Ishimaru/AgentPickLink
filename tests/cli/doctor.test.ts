import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/cli/commands/doctor.js";
import { makeCommandDeps, makeFakeBrokerClient, makeTempPaths } from "./helpers.js";

describe("doctor", () => {
  it("with no options, adds neither authentication nor agent checks and calls no broker method at all", async () => {
    const paths = await makeTempPaths();
    const { deps } = makeCommandDeps({ paths });

    const result = await runDoctor(deps);

    expect(result).not.toHaveProperty("authentication");
    expect(result).not.toHaveProperty("agent");
    expect(result).toHaveProperty("broker");
    expect(result).toHaveProperty("registry");
    expect(result).toHaveProperty("workspace");
    // The browser channel/install check is a local (no-broker) HealthService.localReport check;
    // it must always be present regardless of broker connectivity.
    expect(result).toHaveProperty("browser");
  });

  it("passes a live broker's authState and incidents straight through in result.broker, unmodified", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "broker.health": {
        instanceId: "x",
        authState: { state: "sign-in-required", checkedAt: "2026-09-01T00:00:00.000Z" },
        incidents: [{ at: "2026-09-01T00:00:00.000Z", code: "UI_CHANGED", phase: "invoke", message: "m" }]
      }
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps);

    expect(result.broker).toMatchObject({
      live: true,
      authState: { state: "sign-in-required", checkedAt: "2026-09-01T00:00:00.000Z" },
      incidents: [{ code: "UI_CHANGED", phase: "invoke" }]
    });
  });

  it("--auth adds only an authentication check, via browser.authState, never a conversation/invoke call", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "broker.health": { instanceId: "x" },
      "browser.authState": { state: "authenticated" }
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps, { auth: true });

    expect(result).toHaveProperty("authentication");
    expect(result).not.toHaveProperty("agent");
    const methods = broker.calls.map((call) => call.method);
    expect(methods).toContain("browser.authState");
    expect(methods.some((method) => method.toLowerCase().includes("invoke"))).toBe(false);
  });

  it("--agent adds only an agent check, calling agent.validate with sendTestMessage:false, never true", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "broker.health": { instanceId: "x" },
      "agent.validate": { ok: true }
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps, { agent: "requirements" });

    expect(result).toHaveProperty("agent");
    expect(result).not.toHaveProperty("authentication");
    const agentValidateCall = broker.calls.find((call) => call.method === "agent.validate");
    expect(agentValidateCall?.params).toEqual({ agent: "requirements", sendTestMessage: false });
  });

  it("never calls any transport invoke/submission method, with both --auth and --agent set", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "broker.health": { instanceId: "x" },
      "browser.authState": { state: "authenticated" },
      "agent.validate": { ok: true }
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    await runDoctor(deps, { auth: true, agent: "requirements" });

    const methods = broker.calls.map((call) => call.method);
    expect(
      methods.some(
        (method) => method.toLowerCase().includes("invoke") || method.toLowerCase().includes("submit")
      )
    ).toBe(false);
  });
});
