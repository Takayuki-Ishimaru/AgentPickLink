import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentPickLinkMcpProvider,
  MCP_PROVIDER_ID,
  MCP_SERVER_LABEL,
  WORKSPACE_FILE,
  registerMcpProvider
} from "../../src/extension/mcp-provider.js";
import { createRuntimeHarness, logText, type RuntimeHarness } from "./harness.js";
import { createExtensionContext, lm, resetVscodeMock, setWorkspaceRoot, vscodeMock } from "./vscode-mock.js";

let harness: RuntimeHarness;

beforeEach(async () => {
  resetVscodeMock();
  harness = await createRuntimeHarness();
});

afterEach(async () => {
  await harness.dispose();
});

async function writeWorkspaceFile(): Promise<void> {
  await fs.writeFile(path.join(harness.workspaceRoot, WORKSPACE_FILE), "{}\n", "utf8");
}

describe("provideMcpServerDefinitions", () => {
  it("offers nothing without a workspace folder", async () => {
    setWorkspaceRoot(undefined);
    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
  });

  it("offers nothing while the workspace is untrusted, even with the file present", async () => {
    await writeWorkspaceFile();
    vscodeMock.isTrusted = false;
    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
  });

  it("offers nothing until .m365-agents.json exists", async () => {
    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
  });

  it("offers one stdio definition rooted at the workspace once configured and trusted", async () => {
    await writeWorkspaceFile();
    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    const definitions = await provider.provideMcpServerDefinitions();
    expect(definitions).toHaveLength(1);
    const [definition] = definitions;
    expect(definition.label).toBe(MCP_SERVER_LABEL);
    expect(definition.command).toBe("/opt/node22/bin/node");
    expect(definition.args).toEqual([path.join(harness.extensionRoot, "dist", "cli", "index.js"), "serve"]);
    expect(definition.version).toBe("0.1.0");
    expect(definition.cwd?.fsPath).toBe(harness.workspaceRoot);
  });

  it("fires onDidChangeMcpServerDefinitions from refresh()", () => {
    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    let fired = 0;
    provider.onDidChangeMcpServerDefinitions(() => {
      fired += 1;
    });
    provider.refresh();
    provider.refresh();
    expect(fired).toBe(2);
    provider.dispose();
  });

  it("may pass the dev overrides in memory but never persists them to an MCP client file", async () => {
    process.env.M365_AGENT_DEV_APP_URL = "http://127.0.0.1:4321";
    process.env.M365_AGENT_APP_DATA = harness.home;
    await writeWorkspaceFile();

    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    const [definition] = await provider.provideMcpServerDefinitions();
    expect(definition.env.M365_AGENT_DEV_APP_URL).toBe("http://127.0.0.1:4321");

    const persisted = await harness.runtime.integrationDefinition();
    expect(Object.keys(persisted.env ?? {})).not.toContain("M365_AGENT_DEV_APP_URL");
    expect(persisted.env?.M365_AGENT_APP_DATA).toBe(harness.home);
  });
});

describe("registerMcpProvider", () => {
  it("registers with vscode.lm and returns the provider", () => {
    const context = createExtensionContext();
    const provider = registerMcpProvider(harness.runtime, context as never);
    expect(vscodeMock.mcpProviders).toEqual([{ id: MCP_PROVIDER_ID, provider }]);
    // The provider itself plus the registration disposable.
    expect(context.subscriptions).toHaveLength(2);
  });

  it("skips gracefully on a VS Code build without the MCP provider API", () => {
    lm.registerMcpServerDefinitionProvider = undefined;
    const context = createExtensionContext();
    const provider = registerMcpProvider(harness.runtime, context as never);
    expect(provider).toBeInstanceOf(AgentPickLinkMcpProvider);
    expect(vscodeMock.mcpProviders).toEqual([]);
    expect(context.subscriptions).toHaveLength(1);
    // Save still calls refresh() unconditionally; that must not throw.
    expect(() => provider.refresh()).not.toThrow();
    expect(logText()).toContain("no MCP server definition provider");
  });

  it("survives a registration that throws", () => {
    lm.registerMcpServerDefinitionProvider = () => {
      throw new Error("registration refused");
    };
    const context = createExtensionContext();
    expect(() => registerMcpProvider(harness.runtime, context as never)).not.toThrow();
    expect(logText()).toContain("registration refused");
  });
});
