import { describe, expect, it } from "vitest";
import { runLogin } from "../../src/cli/commands/login.js";
import { makeCommandDeps, makeFakeBrokerClient, makeTempPaths } from "./helpers.js";

describe("login", () => {
  it("checks browser.authState first and never opens the sign-in window when already authenticated", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({ "browser.authState": { state: "authenticated" } });
    const { deps } = makeCommandDeps({ paths, connectOrStartDefaultBroker: async () => broker as never });

    const result = await runLogin(deps);

    expect(result).toEqual({ state: "authenticated" });
    expect(broker.calls.map((call) => call.method)).toEqual(["browser.authState"]);
    expect(broker.closed).toBe(true);
  });

  it("opens the sign-in window and reports its resulting state when not yet signed in", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "browser.authState": { state: "sign-in-required" },
      "browser.login": { authenticated: true, state: "authenticated" }
    });
    const { deps } = makeCommandDeps({ paths, connectOrStartDefaultBroker: async () => broker as never });

    const result = await runLogin(deps);

    expect(result).toEqual({ state: "authenticated" });
    expect(broker.calls.map((call) => call.method)).toEqual(["browser.authState", "browser.login"]);
    expect(broker.calls[1]).toMatchObject({ method: "browser.login", params: { timeoutMs: 300_000 } });
  });
});
