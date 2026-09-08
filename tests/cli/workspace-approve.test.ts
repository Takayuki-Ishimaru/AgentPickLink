import { describe, expect, it } from "vitest";
import { runWorkspaceApprove } from "../../src/cli/commands/workspace-approve.js";
import { deriveBindingFingerprint, type BrowserAgentDefinition } from "../../src/domain/agent.js";
import { loadApprovals } from "../../src/config/approvals.js";
import { defaultGlobalConfig, saveGlobalConfig } from "../../src/config/global-config.js";
import { WorkspaceService } from "../../src/services/workspace-service.js";
import {
  makeCommandDeps,
  makeScriptedPrompter,
  makeTempPaths,
  makeWorkspaceRoot,
  seedRegistry
} from "./helpers.js";

function verifiedAgent(overrides: Partial<BrowserAgentDefinition> = {}): BrowserAgentDefinition {
  const agent: BrowserAgentDefinition = {
    alias: "requirements",
    displayName: "Requirements Bot",
    kind: "m365-agent-builder",
    transport: "browser",
    entryPoint: {
      mode: "direct-chat",
      url: "https://contoso.example/chat/requirements",
      surface: "m365-copilot"
    },
    enabled: true,
    capabilityClass: "knowledge-only",
    uiActionPolicy: "never-click",
    verification: {
      status: "verified",
      adapterId: "m365-copilot-chat@1",
      expectedDisplayName: "Requirements Bot",
      expectedSurface: "m365-copilot",
      validatedUrlPattern: "^/chat/requirements$",
      bindingFingerprint: `sha256:${"0".repeat(64)}`,
      validatedAt: "2026-09-01T00:00:00.000Z"
    },
    ...overrides
  };
  agent.verification.bindingFingerprint = deriveBindingFingerprint(agent);
  return agent;
}

describe("workspace approve", () => {
  it("displays workspace location, alias, display name, capability class, verification state, and binding match, plus the Copilot-context warning", async () => {
    const paths = await makeTempPaths();
    const agent = verifiedAgent();
    await seedRegistry(paths, [agent]);
    const root = await makeWorkspaceRoot([
      { alias: agent.alias, bindingFingerprint: agent.verification.bindingFingerprint }
    ]);
    const prompter = makeScriptedPrompter({ confirmAnswer: true });
    const { deps, stderrLines } = makeCommandDeps({ paths, root: () => root, prompter });

    const result = await runWorkspaceApprove(deps);

    expect(result).toMatchObject({ approved: true });
    const normalizedRoot = (await new WorkspaceService().load(root)).root;
    const shown = stderrLines.join("");
    expect(shown).toContain(`Workspace: ${normalizedRoot}`);
    expect(shown).toContain(agent.alias);
    expect(shown).toContain(agent.displayName);
    expect(shown).toContain(agent.capabilityClass);
    expect(shown).toContain("verification=verified");
    expect(shown).toContain("binding=match");
    expect(shown).toContain("Microsoft 365 responses will enter GitHub Copilot context");
    expect(prompter.confirmCalls).toHaveLength(1);
  });

  it("requires an explicit confirmation; a decline writes no approval", async () => {
    const paths = await makeTempPaths();
    const agent = verifiedAgent();
    await seedRegistry(paths, [agent]);
    const root = await makeWorkspaceRoot([
      { alias: agent.alias, bindingFingerprint: agent.verification.bindingFingerprint }
    ]);
    const prompter = makeScriptedPrompter({ confirmAnswer: false });
    const { deps } = makeCommandDeps({ paths, root: () => root, prompter });

    await expect(runWorkspaceApprove(deps)).rejects.toThrow(/not confirmed/i);
    const approvals = await loadApprovals(paths);
    expect(approvals.approvals).toHaveLength(0);
  });

  it("--yes skips the confirmation prompt but still refuses an unverified agent", async () => {
    const paths = await makeTempPaths();
    const agent = verifiedAgent({ verification: { ...verifiedAgent().verification, status: "unverified" } });
    await seedRegistry(paths, [agent]);
    const root = await makeWorkspaceRoot([{ alias: agent.alias }]);
    const prompter = makeScriptedPrompter({ confirmAnswer: false });
    const { deps } = makeCommandDeps({ paths, root: () => root, prompter });

    await expect(runWorkspaceApprove(deps, { yes: true })).rejects.toThrow(/not verified/i);
    // The confirmation itself was bypassed by --yes (never asked)...
    expect(prompter.confirmCalls).toHaveLength(0);
    const approvals = await loadApprovals(paths);
    expect(approvals.approvals).toHaveLength(0);
  });

  it("--yes still refuses a disabled agent", async () => {
    const paths = await makeTempPaths();
    const agent = verifiedAgent({ enabled: false });
    await seedRegistry(paths, [agent]);
    const root = await makeWorkspaceRoot([{ alias: agent.alias }]);
    const { deps } = makeCommandDeps({ paths, root: () => root });

    await expect(runWorkspaceApprove(deps, { yes: true })).rejects.toThrow(/disabled/i);
  });

  it("--yes still refuses an agent blocked by capability class", async () => {
    const paths = await makeTempPaths();
    const agent = verifiedAgent({ capabilityClass: "actions-possible" });
    await seedRegistry(paths, [agent]);
    const root = await makeWorkspaceRoot([{ alias: agent.alias }]);
    const { deps } = makeCommandDeps({ paths, root: () => root });

    await expect(runWorkspaceApprove(deps, { yes: true })).rejects.toThrow(/knowledge-only/i);
  });

  it("an unverified agent cannot be approved even with explicit confirmation", async () => {
    const paths = await makeTempPaths();
    const agent = verifiedAgent({ verification: { ...verifiedAgent().verification, status: "unverified" } });
    await seedRegistry(paths, [agent]);
    const root = await makeWorkspaceRoot([{ alias: agent.alias }]);
    const prompter = makeScriptedPrompter({ confirmAnswer: true });
    const { deps } = makeCommandDeps({ paths, root: () => root, prompter });

    await expect(runWorkspaceApprove(deps)).rejects.toThrow(/not verified/i);
    const approvals = await loadApprovals(paths);
    expect(approvals.approvals).toHaveLength(0);
  });

  it("approves an actions-possible agent only when local policy explicitly allows it", async () => {
    const paths = await makeTempPaths();
    const agent = verifiedAgent({ capabilityClass: "actions-possible" });
    await seedRegistry(paths, [agent]);
    const config = defaultGlobalConfig(paths.profile);
    config.security.allowedCapabilityClasses = ["knowledge-only", "actions-possible"];
    await saveGlobalConfig(paths, config);
    const root = await makeWorkspaceRoot([
      { alias: agent.alias, bindingFingerprint: agent.verification.bindingFingerprint }
    ]);
    const { deps } = makeCommandDeps({ paths, root: () => root });

    await expect(runWorkspaceApprove(deps, { yes: true })).resolves.toMatchObject({
      approved: true,
      approvedBindings: [{ alias: agent.alias, capabilityClass: "actions-possible" }]
    });
  });
});
