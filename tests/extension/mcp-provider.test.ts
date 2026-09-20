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
import { mergeVscodeMcpJson } from "../../src/extension/integrations.js";
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

  it("offers nothing when .vscode/mcp.json already registers a managed m365-agents entry (§4.7 C5)", async () => {
    await writeWorkspaceFile();
    const definition = await harness.runtime.integrationDefinition();
    await fs.mkdir(path.join(harness.workspaceRoot, ".vscode"), { recursive: true });
    await fs.writeFile(
      path.join(harness.workspaceRoot, ".vscode", "mcp.json"),
      mergeVscodeMcpJson(undefined, { ...definition, env: { ...definition.env, M365_AGENT_MANAGED: "1" } }),
      "utf8"
    );

    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
    expect(logText()).toContain(
      "workspace file registers m365-agents (managed); provider offers no definition"
    );
  });

  it("offers nothing when .vscode/mcp.json has a legacy (pre-marker) m365-agents entry", async () => {
    await writeWorkspaceFile();
    await fs.mkdir(path.join(harness.workspaceRoot, ".vscode"), { recursive: true });
    await fs.writeFile(
      path.join(harness.workspaceRoot, ".vscode", "mcp.json"),
      mergeVscodeMcpJson(undefined, {
        command: "/usr/local/bin/node",
        args: ["/ext/dist/cli/index.js", "serve"]
      }),
      "utf8"
    );

    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
  });

  // §P2: a foreign entry occupies the `m365-agents` label in the higher-priority collection just
  // as a managed one does, so VS Code would silently disable the provider's copy anyway (§4.7 C5).
  it("offers nothing when .vscode/mcp.json has a foreign m365-agents entry, and says which", async () => {
    await writeWorkspaceFile();
    await fs.mkdir(path.join(harness.workspaceRoot, ".vscode"), { recursive: true });
    await fs.writeFile(
      path.join(harness.workspaceRoot, ".vscode", "mcp.json"),
      mergeVscodeMcpJson(undefined, { command: "/usr/bin/some-other-tool", args: ["serve"] }),
      "utf8"
    );

    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
    expect(logText()).toContain(
      "workspace file registers m365-agents (foreign); provider offers no definition"
    );
  });

  // §4.4/§4.7 C5: the default `vscodeUser` writer's file also beats this provider's sort order
  // (200 vs 300), so a managed/legacy entry there must suppress the provider's definition too.
  it("offers nothing when the user-profile mcp.json already registers a managed m365-agents entry (§4.4/C5)", async () => {
    await writeWorkspaceFile();
    const definition = await harness.runtime.integrationDefinition();
    const userProfilePath = harness.runtime.vscodeUserMcpJsonPath();
    await fs.mkdir(path.dirname(userProfilePath), { recursive: true });
    await fs.writeFile(
      userProfilePath,
      mergeVscodeMcpJson(undefined, { ...definition, env: { ...definition.env, M365_AGENT_MANAGED: "1" } }),
      "utf8"
    );

    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
    expect(logText()).toContain(
      "user-profile mcp.json registers m365-agents (managed); provider offers no definition"
    );
  });

  it("still offers a definition when the user-profile mcp.json has no m365-agents entry at all", async () => {
    await writeWorkspaceFile();
    const userProfilePath = harness.runtime.vscodeUserMcpJsonPath();
    await fs.mkdir(path.dirname(userProfilePath), { recursive: true });
    await fs.writeFile(
      userProfilePath,
      JSON.stringify({ servers: { "some-other-server": { command: "/usr/bin/other", args: [] } } }, null, 2),
      "utf8"
    );

    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    expect(await provider.provideMcpServerDefinitions()).toHaveLength(1);
  });

  it("still offers a definition when .vscode/mcp.json has no m365-agents entry at all", async () => {
    await writeWorkspaceFile();
    await fs.mkdir(path.join(harness.workspaceRoot, ".vscode"), { recursive: true });
    await fs.writeFile(
      path.join(harness.workspaceRoot, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { "some-other-server": { command: "/usr/bin/other", args: [] } } }, null, 2),
      "utf8"
    );

    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    expect(await provider.provideMcpServerDefinitions()).toHaveLength(1);
  });

  it("§4.7 C9: suppresses on a variable-form managed entry, which only classifies with variables", async () => {
    await writeWorkspaceFile();
    const definition = await harness.runtime.integrationDefinition();
    const variables = harness.runtime.integrationVariables()!;
    // The identity the archive would write on this machine: under the home directory, so the
    // writer substitutes `${userHome}`/`${env:LOCALAPPDATA}` for its prefix.
    const homeBased = {
      command: path.join(harness.home, "bin", process.platform === "win32" ? "node.exe" : "node"),
      args: [path.join(harness.home, "bin", "apl.js"), "serve"],
      env: { ...definition.env, M365_AGENT_MANAGED: "1" }
    };
    const text = mergeVscodeMcpJson(undefined, homeBased, variables);
    expect(text).toContain("${");
    await fs.mkdir(path.join(harness.workspaceRoot, ".vscode"), { recursive: true });
    await fs.writeFile(path.join(harness.workspaceRoot, ".vscode", "mcp.json"), text, "utf8");

    const provider = new AgentPickLinkMcpProvider(harness.runtime);
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
    expect(logText()).toContain(
      "workspace file registers m365-agents (managed); provider offers no definition"
    );
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
