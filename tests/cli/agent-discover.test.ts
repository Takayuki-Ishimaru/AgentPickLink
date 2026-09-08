import { describe, expect, it } from "vitest";
import { runAgentDiscover } from "../../src/cli/commands/agent-discover.js";
import { deriveBindingFingerprint, type BrowserAgentDefinition } from "../../src/domain/agent.js";
import { makeCommandDeps, makeFakeBrokerClient, makeTempPaths, seedRegistry } from "./helpers.js";

function verifiedAgent(alias: string, url: string, displayName: string): BrowserAgentDefinition {
  const agent: BrowserAgentDefinition = {
    alias,
    displayName,
    kind: "m365-agent-builder",
    transport: "browser",
    entryPoint: { mode: "direct-chat", url, surface: "m365-copilot" },
    enabled: true,
    capabilityClass: "knowledge-only",
    uiActionPolicy: "never-click",
    verification: {
      status: "verified",
      adapterId: "agent-builder-chat@1",
      expectedDisplayName: displayName,
      expectedSurface: "m365-copilot",
      validatedUrlPattern: `^${new URL(url).pathname}$`,
      bindingFingerprint: `sha256:${"0".repeat(64)}`,
      validatedAt: "2026-09-01T00:00:00.000Z"
    }
  };
  agent.verification.bindingFingerprint = deriveBindingFingerprint(agent);
  return agent;
}

describe("agent discover", () => {
  it("requires sign-in and never opens the sign-in window without --login", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({ "browser.authState": { state: "sign-in-required" } });
    const { deps } = makeCommandDeps({ paths, connectOrStartDefaultBroker: async () => broker as never });

    await expect(runAgentDiscover(deps, {})).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(broker.calls.map((call) => call.method)).toEqual(["browser.authState"]);
  });

  it("--login opens the sign-in window when needed, then discovers", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "browser.authState": { state: "sign-in-required" },
      "browser.login": { authenticated: true, state: "authenticated" },
      "agent.discover": { agents: [], warnings: [] }
    });
    const { deps } = makeCommandDeps({ paths, connectOrStartDefaultBroker: async () => broker as never });

    const result = await runAgentDiscover(deps, { login: true });

    expect(broker.calls.map((call) => call.method)).toEqual([
      "browser.authState",
      "browser.login",
      "agent.discover"
    ]);
    expect(result).toBe("No agents were discovered.");
  });

  it("prints a readable list (name — url (source, alias)) without --json", async () => {
    const paths = await makeTempPaths();
    const registered = verifiedAgent(
      "requirements",
      "https://m365.cloud.microsoft/chat/requirements",
      "Reqs"
    );
    await seedRegistry(paths, [registered]);
    const broker = makeFakeBrokerClient({
      "browser.authState": { state: "authenticated" },
      "agent.discover": {
        agents: [
          {
            url: "https://m365.cloud.microsoft/chat/requirements",
            surface: "m365-copilot",
            displayName: "Requirements Agent",
            source: "sidebar"
          },
          {
            url: "https://m365.cloud.microsoft/chat/new-agent",
            surface: "m365-copilot",
            displayName: "New Agent",
            source: "link"
          }
        ],
        warnings: ["no-sidebar", "sidebar:0/0 link:2/1 scroll:0 store:unavailable"]
      }
    });
    const { deps } = makeCommandDeps({ paths, connectOrStartDefaultBroker: async () => broker as never });

    const result = await runAgentDiscover(deps, {});

    expect(result).toBe(
      "Requirements Agent — https://m365.cloud.microsoft/chat/requirements (sidebar, requirements)\n" +
        "New Agent — https://m365.cloud.microsoft/chat/new-agent (link, not registered)\n" +
        "Warnings: no-sidebar\n" +
        "Diagnostics: sidebar:0/0 link:2/1 scroll:0 store:unavailable"
    );
  });

  it("--json returns the structured { candidates, warnings } object", async () => {
    const paths = await makeTempPaths();
    const broker = makeFakeBrokerClient({
      "browser.authState": { state: "authenticated" },
      "agent.discover": { agents: [], warnings: [] }
    });
    const { deps } = makeCommandDeps({ paths, connectOrStartDefaultBroker: async () => broker as never });

    const result = await runAgentDiscover(deps, { json: true });

    expect(result).toEqual({ candidates: [], warnings: [] });
  });
});
