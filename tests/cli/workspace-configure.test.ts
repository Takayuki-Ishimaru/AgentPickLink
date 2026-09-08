import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkspaceConfigure } from "../../src/cli/commands/workspace-configure.js";
import { defaultGlobalConfig, saveGlobalConfig } from "../../src/config/global-config.js";
import { deriveBindingFingerprint, type BrowserAgentDefinition } from "../../src/domain/agent.js";
import { makeCommandDeps, makeTempPaths, seedRegistry } from "./helpers.js";

function verifiedAgent(alias: string, displayName: string): BrowserAgentDefinition {
  const agent: BrowserAgentDefinition = {
    alias,
    displayName,
    kind: "m365-agent-builder",
    transport: "browser",
    entryPoint: {
      mode: "direct-chat",
      url: `https://contoso.example/chat/${alias}`,
      surface: "m365-copilot"
    },
    enabled: true,
    capabilityClass: "knowledge-only",
    uiActionPolicy: "never-click",
    verification: {
      status: "verified",
      adapterId: "m365-copilot-chat@1",
      expectedDisplayName: displayName,
      expectedSurface: "m365-copilot",
      validatedUrlPattern: `^/chat/${alias}$`,
      bindingFingerprint: `sha256:${"0".repeat(64)}`,
      validatedAt: "2026-09-01T00:00:00.000Z"
    }
  };
  agent.verification.bindingFingerprint = deriveBindingFingerprint(agent);
  return agent;
}

describe("workspace configure", () => {
  it("writes a canonical, alias-sorted .m365-agents.json with binding fingerprints and explains it is a request, not authorization", async () => {
    const paths = await makeTempPaths();
    const zebra = verifiedAgent("zebra", "Zebra Bot");
    const alpha = verifiedAgent("alpha", "Alpha Bot");
    await seedRegistry(paths, [zebra, alpha]);
    const root = await mkdtemp(path.join(os.tmpdir(), "apl-configure-"));
    // M365_AGENT_ALIASES intentionally lists the alias not-yet-sorted (zebra before alpha).
    const { deps } = makeCommandDeps({ paths, root: () => root, env: { M365_AGENT_ALIASES: "zebra,alpha" } });

    const result = await runWorkspaceConfigure(deps);

    expect(result).toMatchObject({
      configured: true,
      note: expect.stringMatching(/request, not authorization/i)
    });
    const written = JSON.parse(await readFile(path.join(root, ".m365-agents.json"), "utf8"));
    expect(written).toEqual({
      version: 1,
      agents: [
        { alias: "alpha", bindingFingerprint: alpha.verification.bindingFingerprint },
        { alias: "zebra", bindingFingerprint: zebra.verification.bindingFingerprint }
      ]
    });
  });

  it("excludes an unverified/disabled/non-knowledge-only agent from the selectable candidates", async () => {
    const paths = await makeTempPaths();
    const unverified = verifiedAgent("unverified-one", "Unverified");
    unverified.verification.status = "unverified";
    await seedRegistry(paths, [unverified]);
    const root = await mkdtemp(path.join(os.tmpdir(), "apl-configure-"));
    const { deps } = makeCommandDeps({
      paths,
      root: () => root,
      env: { M365_AGENT_ALIASES: "unverified-one" }
    });

    await expect(runWorkspaceConfigure(deps)).rejects.toThrow(/not verified, supported, enabled/i);
  });

  it("without M365_AGENT_ALIASES and a non-interactive prompter, refuses rather than writing anything", async () => {
    const paths = await makeTempPaths();
    const root = await mkdtemp(path.join(os.tmpdir(), "apl-configure-"));
    const { deps } = makeCommandDeps({ paths, root: () => root, env: {} });

    await expect(runWorkspaceConfigure(deps)).rejects.toThrow(/interactive terminal or M365_AGENT_ALIASES/i);
  });

  it("includes an actions-possible agent only after that class is explicitly enabled", async () => {
    const paths = await makeTempPaths();
    const actionAgent = verifiedAgent("file-maker", "File Maker");
    actionAgent.capabilityClass = "actions-possible";
    await seedRegistry(paths, [actionAgent]);
    const config = defaultGlobalConfig(paths.profile);
    config.security.allowedCapabilityClasses = ["knowledge-only", "actions-possible"];
    await saveGlobalConfig(paths, config);
    const root = await mkdtemp(path.join(os.tmpdir(), "apl-configure-"));
    const { deps } = makeCommandDeps({
      paths,
      root: () => root,
      env: { M365_AGENT_ALIASES: "file-maker" }
    });

    await expect(runWorkspaceConfigure(deps)).resolves.toMatchObject({
      configured: true,
      agents: [{ alias: "file-maker" }]
    });
  });
});
