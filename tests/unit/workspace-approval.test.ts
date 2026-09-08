import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configDigest, WorkspaceConfigSchema, workspaceKey } from "../../src/domain/workspace.js";
import { ApprovalService } from "../../src/services/approval-service.js";
import {
  canonicalBindingIdentity,
  deriveBindingFingerprint,
  type BrowserAgentDefinition
} from "../../src/domain/agent.js";
import { AgentService } from "../../src/services/agent-service.js";
import { defaultGlobalConfig } from "../../src/config/global-config.js";
import {
  assertSupportedTopology,
  normalizeRoot,
  WorkspaceService
} from "../../src/services/workspace-service.js";
import { DomainError } from "../../src/domain/errors.js";

const agent: BrowserAgentDefinition = {
  alias: "requirements",
  displayName: "Requirements",
  kind: "m365-agent-builder",
  transport: "browser",
  entryPoint: { mode: "direct-chat", url: "https://contoso.example/chat", surface: "m365-copilot" },
  enabled: true,
  capabilityClass: "knowledge-only",
  uiActionPolicy: "never-click",
  verification: {
    status: "verified",
    adapterId: "m365-copilot-chat@1",
    expectedDisplayName: "Requirements",
    expectedSurface: "m365-copilot",
    validatedUrlPattern: "/chat",
    bindingFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    validatedAt: "2026-09-01T00:00:00.000Z"
  }
};
const fingerprint = deriveBindingFingerprint(agent);
agent.verification.bindingFingerprint = fingerprint;
describe("workspace canonicalization and approval", () => {
  it("has a digest invariant to request order", () => {
    const one = WorkspaceConfigSchema.parse({ version: 1, agents: [{ alias: "z" }, { alias: "a" }] });
    const two = WorkspaceConfigSchema.parse({ version: 1, agents: [{ alias: "a" }, { alias: "z" }] });
    expect(configDigest(one)).toBe(configDigest(two));
    expect(workspaceKey("C:/workspace")).toHaveLength(24);
  });
  it("requires a local alias-plus-binding approval", () => {
    const config = WorkspaceConfigSchema.parse({
      version: 1,
      agents: [{ alias: "requirements", bindingFingerprint: fingerprint }]
    });
    const workspace = {
      root: "/repo",
      workspaceKey: workspaceKey("/repo"),
      config,
      configDigest: configDigest(config)
    };
    const approvals = new ApprovalService({ version: 1, approvals: [] });
    expect(() => approvals.assertApproved(workspace, agent)).toThrow(/approved/i);
    approvals.approve(workspace, [agent]);
    expect(() => approvals.assertApproved(workspace, agent)).not.toThrow();
    expect(() =>
      approvals.assertApproved(workspace, {
        ...agent,
        verification: { ...agent.verification, bindingFingerprint: fingerprint.replace(/a/g, "b") }
      })
    ).toThrow(/binding/i);
  });
  it("removes transient conversation and tracking state from binding identity", () => {
    const one = {
      ...agent,
      entryPoint: {
        ...agent.entryPoint,
        url: "https://contoso.example/conversations/one/chat?utm_source=x&mode=agent"
      }
    };
    const two = {
      ...agent,
      entryPoint: {
        ...agent.entryPoint,
        url: "https://contoso.example/conversations/two/chat?mode=agent&utm_source=y"
      }
    };
    expect(canonicalBindingIdentity(one)).toBe(canonicalBindingIdentity(two));
  });
  it("preserves approval for a deletion-only subset and requires approval for additions", () => {
    const second: BrowserAgentDefinition = JSON.parse(
      JSON.stringify({
        ...agent,
        alias: "standards",
        displayName: "Standards",
        entryPoint: { ...agent.entryPoint, url: "https://contoso.example/chat/standards" },
        verification: {
          ...agent.verification,
          expectedDisplayName: "Standards",
          expectedStableAgentId: "standards-1"
        }
      })
    );
    second.verification.bindingFingerprint = deriveBindingFingerprint(second);
    const fullConfig = WorkspaceConfigSchema.parse({
      version: 1,
      agents: [
        { alias: agent.alias, bindingFingerprint: fingerprint },
        { alias: second.alias, bindingFingerprint: second.verification.bindingFingerprint }
      ]
    });
    const full = {
      root: "/repo",
      workspaceKey: workspaceKey("/repo"),
      config: fullConfig,
      configDigest: configDigest(fullConfig)
    };
    const store = { version: 1 as const, approvals: [] };
    const service = new ApprovalService(store);
    service.approve(full, [agent, second]);
    const subsetConfig = WorkspaceConfigSchema.parse({
      version: 1,
      agents: [{ alias: agent.alias, bindingFingerprint: fingerprint }]
    });
    expect(
      service.status(
        { ...full, config: subsetConfig, configDigest: configDigest(subsetConfig) },
        new Map([
          [agent.alias, agent],
          [second.alias, second]
        ])
      )
    ).toBe("approved");
    const addedConfig = WorkspaceConfigSchema.parse({
      version: 1,
      agents: [...fullConfig.agents, { alias: "new-agent" }]
    });
    expect(
      service.status(
        { ...full, config: addedConfig, configDigest: configDigest(addedConfig) },
        new Map([
          [agent.alias, agent],
          [second.alias, second]
        ])
      )
    ).toBe("approval-required");
  });
  it("rejects registry data changed without recomputing its verified binding", () => {
    const tampered = {
      ...agent,
      entryPoint: { ...agent.entryPoint, url: "https://contoso.example/chat/other-agent" }
    };
    expect(() =>
      new AgentService(
        { version: 1, agents: [tampered] },
        defaultGlobalConfig("/private/profile")
      ).assertEligible(agent.alias)
    ).toThrow(/binding/i);
  });
  it("rejects an unknown browser adapter before it can be approved", () => {
    const unsupported = {
      ...agent,
      verification: { ...agent.verification, adapterId: "arbitrary-browser@1" }
    };
    const config = WorkspaceConfigSchema.parse({
      version: 1,
      agents: [{ alias: unsupported.alias, bindingFingerprint: unsupported.verification.bindingFingerprint }]
    });
    const workspace = {
      root: "/repo",
      workspaceKey: workspaceKey("/repo"),
      config,
      configDigest: configDigest(config)
    };
    expect(() =>
      new AgentService(
        { version: 1, agents: [unsupported] },
        defaultGlobalConfig("/private/profile")
      ).assertEligible(unsupported.alias)
    ).toThrow(/adapter/i);
    expect(() =>
      new ApprovalService({ version: 1, approvals: [] }).approve(workspace, [unsupported])
    ).toThrow(/adapter/i);
  });
});

describe("workspace discovery boundary (§9.3)", () => {
  it("does not discover a .m365-agents.json that lives above the opened workspace folder", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-discovery-"));
    const gitRoot = path.join(base, "repo");
    const opened = path.join(gitRoot, "packages", "app");
    await mkdir(path.join(gitRoot, ".git"), { recursive: true });
    await mkdir(opened, { recursive: true });
    await writeFile(path.join(gitRoot, ".m365-agents.json"), JSON.stringify({ version: 1, agents: [] }));
    await expect(new WorkspaceService().load(opened)).rejects.toMatchObject({
      code: "WORKSPACE_NOT_CONFIGURED"
    });
  });

  it("discovers a .m365-agents.json at the opened workspace folder itself, and derives workspaceKey from it", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-discovery-"));
    const gitRoot = path.join(base, "repo");
    const opened = path.join(gitRoot, "packages", "app");
    await mkdir(path.join(gitRoot, ".git"), { recursive: true });
    await mkdir(opened, { recursive: true });
    await writeFile(
      path.join(opened, ".m365-agents.json"),
      JSON.stringify({ version: 1, agents: [{ alias: "requirements" }] })
    );
    const workspace = await new WorkspaceService().load(opened);
    const expectedRoot = normalizeRoot(await realpath(opened));
    expect(workspace.root).toBe(expectedRoot);
    expect(workspace.workspaceKey).toBe(workspaceKey(expectedRoot));
  });
});

describe("WORKSPACE_ROOT_AMBIGUOUS", () => {
  it("assertSupportedTopology throws when the single environment-declared root disagrees with the provided root", () => {
    let caught: unknown;
    try {
      assertSupportedTopology(
        { NODE_ENV: "test", M365_AGENT_WORKSPACE_ROOTS: "/some/other/folder" },
        normalizeRoot("/repo")
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("WORKSPACE_ROOT_AMBIGUOUS");
    expect((caught as DomainError).toResult("x").error.remediation).toBeTruthy();
  });
  it("assertSupportedTopology does not throw when the single declared root matches the provided root", () => {
    expect(() =>
      assertSupportedTopology(
        { NODE_ENV: "test", M365_AGENT_WORKSPACE_ROOTS: "/repo" },
        normalizeRoot("/repo")
      )
    ).not.toThrow();
  });
  it("assertSupportedTopology does not check ambiguity when no providedRoot is given", () => {
    expect(() =>
      assertSupportedTopology({ NODE_ENV: "test", M365_AGENT_WORKSPACE_ROOTS: "/some/other/folder" })
    ).not.toThrow();
  });
  it("WorkspaceService.load throws WORKSPACE_ROOT_AMBIGUOUS end-to-end when VSCODE_WORKSPACE_FOLDERS disagrees with the opened root", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-ambiguous-"));
    const opened = path.join(base, "opened");
    await mkdir(opened, { recursive: true });
    await writeFile(path.join(opened, ".m365-agents.json"), JSON.stringify({ version: 1, agents: [] }));
    const original = process.env.VSCODE_WORKSPACE_FOLDERS;
    process.env.VSCODE_WORKSPACE_FOLDERS = path.join(base, "different-folder");
    try {
      await expect(new WorkspaceService().load(opened)).rejects.toMatchObject({
        code: "WORKSPACE_ROOT_AMBIGUOUS"
      });
    } finally {
      if (original === undefined) delete process.env.VSCODE_WORKSPACE_FOLDERS;
      else process.env.VSCODE_WORKSPACE_FOLDERS = original;
    }
  });
});

describe("supported topology (win32/darwin without an override; everything else still gated)", () => {
  // NODE_ENV is deliberately not "test" here (vitest's own default would otherwise mask the
  // platform gate entirely) so this exercises the actual win32/darwin-vs-everything-else check
  // added for macOS development support (docs/ux-redesign.md §2.2 item 2), on whatever platform
  // this suite happens to run on.
  const nonTestEnv = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

  it("permits win32 and darwin without M365_AGENT_ALLOW_UNSUPPORTED_OS", () => {
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(() => assertSupportedTopology(nonTestEnv)).not.toThrow();
    } else {
      expect(() => assertSupportedTopology(nonTestEnv)).toThrow(DomainError);
    }
  });

  it("still requires the explicit override on every other platform", () => {
    if (process.platform === "win32" || process.platform === "darwin") return;
    let caught: unknown;
    try {
      assertSupportedTopology(nonTestEnv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("REMOTE_HOST_UNSUPPORTED");
    expect(() =>
      assertSupportedTopology({ ...nonTestEnv, M365_AGENT_ALLOW_UNSUPPORTED_OS: "1" })
    ).not.toThrow();
  });
});
