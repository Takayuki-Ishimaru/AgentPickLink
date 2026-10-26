import { mkdir, mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appPaths } from "../../src/config/paths.js";
import { initializeLocalState } from "../../src/config/init.js";
import { loadApprovals } from "../../src/config/approvals.js";
import { loadGlobalConfig } from "../../src/config/global-config.js";
import { loadRegistry, saveRegistry, updateRegistry } from "../../src/config/registry.js";
import { withFileLock } from "../../src/config/storage.js";
import { deriveBindingFingerprint, type BrowserAgentDefinition } from "../../src/domain/agent.js";
import { ApprovalService } from "../../src/services/approval-service.js";
import { SetupService } from "../../src/services/setup-service.js";
import { WorkspaceService } from "../../src/services/workspace-service.js";
import type { IpcClient } from "../../src/ipc/client.js";
import { runAgentAdd } from "../../src/cli/commands/agent-add.js";
import { runAgentRemove } from "../../src/cli/commands/agent-remove.js";
import { runWorkspaceApprove } from "../../src/cli/commands/workspace-approve.js";
import { runWorkspaceRevoke } from "../../src/cli/commands/workspace-revoke.js";
import { makeCommandDeps } from "../cli/helpers.js";

const preparer = { prepareLocalState: async () => undefined };

function agent(alias: string): BrowserAgentDefinition {
  const entry: BrowserAgentDefinition = {
    alias,
    displayName: alias,
    kind: "m365-agent-builder",
    transport: "browser",
    entryPoint: {
      mode: "direct-chat",
      url: `https://m365.cloud.microsoft/chat/${alias}`,
      surface: "m365-copilot"
    },
    enabled: true,
    capabilityClass: "knowledge-only",
    uiActionPolicy: "never-click",
    description: "old description",
    usageHint: "old hint",
    verification: {
      status: "verified",
      adapterId: "agent-builder-chat@1",
      expectedDisplayName: alias,
      expectedSurface: "m365-copilot",
      validatedUrlPattern: `^/chat/${alias}$`,
      bindingFingerprint: "",
      validatedAt: "2026-10-26T00:00:00.000Z"
    }
  };
  entry.verification.bindingFingerprint = deriveBindingFingerprint(entry);
  return entry;
}

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "apl-setup-concurrency-"));
  const root = path.join(base, "workspace-a");
  const otherRoot = path.join(base, "workspace-b");
  await Promise.all([mkdir(root), mkdir(otherRoot)]);
  const paths = appPaths(path.join(base, "appdata"));
  await initializeLocalState(paths, preparer);
  const service = (workspace = root, inspect?: () => Promise<void>) =>
    new SetupService({
      paths,
      root: () => workspace,
      preparer,
      connect: async () =>
        ({
          close() {},
          async call(method: string, params: { url: string }) {
            if (method !== "agent.inspectUrl") throw new Error(`Unexpected ${method}`);
            await inspect?.();
            return {
              url: params.url,
              displayName: "new agent",
              surface: "m365-copilot",
              adapterId: "agent-builder-chat@1",
              validatedUrlPattern: "^/chat/new$"
            };
          }
        }) as unknown as IpcClient
    });
  return { paths, root, otherRoot, service };
}

async function holdLock(target: string) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = withFileLock(target, async () => {
    enter();
    await barrier;
  });
  await entered;
  return async () => {
    release();
    await done;
  };
}

describe("setup concurrency review regressions", () => {
  it.each(["removed", "rebound", "stale-fingerprint"])(
    "rejects a selected binding %s during inspection",
    async (mode) => {
      const f = await fixture();
      const existing = agent("existing");
      await saveRegistry(f.paths, { version: 1, agents: [existing] });
      const service = f.service(f.root, async () => {
        await updateRegistry(f.paths, (current) => {
          if (mode === "removed") current.agents = [];
          else {
            current.agents[0].entryPoint.url = "https://m365.cloud.microsoft/chat/changed";
            if (mode === "rebound")
              current.agents[0].verification.bindingFingerprint = deriveBindingFingerprint(current.agents[0]);
          }
          return true;
        });
      });
      await expect(
        service.apply({
          agents: [
            { url: existing.entryPoint.url, displayName: existing.displayName },
            { url: "https://m365.cloud.microsoft/chat/new", displayName: "new agent" }
          ]
        })
      ).rejects.toMatchObject({ code: "CONCURRENT_REQUEST" });
      await expect(stat(path.join(f.root, ".m365-agents.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await loadApprovals(f.paths)).approvals).toHaveLength(0);
    }
  );

  it("merges CLI approval and another workspace's CLI revocation under contention", async () => {
    const f = await fixture();
    const a = agent("first"),
      b = agent("second");
    await saveRegistry(f.paths, { version: 1, agents: [a, b] });
    await f.service().apply({ agents: [{ url: a.entryPoint.url, displayName: a.displayName }] });
    await f.service(f.otherRoot).apply({ agents: [{ url: b.entryPoint.url, displayName: b.displayName }] });
    const depsA = makeCommandDeps({ paths: f.paths, root: () => f.root }).deps;
    const depsB = makeCommandDeps({ paths: f.paths, root: () => f.otherRoot }).deps;
    const unlock = await holdLock(`${f.paths.approvals}.lock`);
    const pending = Promise.allSettled([
      runWorkspaceRevoke(depsA),
      runWorkspaceApprove(depsB, { yes: true })
    ]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await unlock();
    }
    expect(await pending).toMatchObject([
      { status: "fulfilled", value: { revoked: true } },
      { status: "fulfilled", value: { approved: true } }
    ]);
    expect((await loadApprovals(f.paths)).approvals.map((entry) => entry.workspaceKey)).toEqual([
      (await new WorkspaceService().load(f.otherRoot)).workspaceKey
    ]);
  });

  it("retains approvals for both workspaces under overlapping saves", async () => {
    const f = await fixture();
    const a = agent("first"),
      b = agent("second");
    await saveRegistry(f.paths, { version: 1, agents: [a, b] });
    const unlock = await holdLock(`${f.paths.approvals}.lock`);
    const pending = Promise.allSettled([
      f.service().apply({ agents: [{ url: a.entryPoint.url, displayName: a.displayName }] }),
      f.service(f.otherRoot).apply({ agents: [{ url: b.entryPoint.url, displayName: b.displayName }] })
    ]);
    try {
      await vi.waitFor(
        async () => {
          await Promise.all([f.root, f.otherRoot].map((root) => stat(path.join(root, ".m365-agents.json"))));
        },
        // Windows ACL work inside each apply can delay the workspace-file stage well past 1s.
        { interval: 5, timeout: process.platform === "win32" ? 30_000 : 1000 }
      );
      // Both old implementations have read their approval snapshot before the lock is released.
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      await unlock();
    }
    expect(await pending).toMatchObject([
      { status: "fulfilled", value: { approved: true } },
      { status: "fulfilled", value: { approved: true } }
    ]);
    const store = await loadApprovals(f.paths);
    expect(store.approvals).toHaveLength(2);
    const registry = new Map((await loadRegistry(f.paths)).agents.map((entry) => [entry.alias, entry]));
    for (const root of [f.root, f.otherRoot])
      expect(new ApprovalService(store).status(await new WorkspaceService().load(root), registry)).toBe(
        "approved"
      );
  });

  it("merges distinct advanced settings without overwriting either patch", async () => {
    const f = await fixture();
    const quota = (await loadGlobalConfig(f.paths)).security.attachmentQuotaBytes + 1024;
    await Promise.all([
      f.service().updateConfig({ attachmentRetentionHours: 24 }),
      f.service(f.otherRoot).updateConfig({ attachmentQuotaBytes: quota })
    ]);
    expect((await loadGlobalConfig(f.paths)).security).toMatchObject({
      attachmentRetentionHours: 24,
      attachmentQuotaBytes: quota
    });
  });

  it("rejects an invalid config patch without losing another valid write", async () => {
    const f = await fixture();
    const result = await Promise.allSettled([
      f.service().updateConfig({ attachmentRetentionHours: -1 }),
      f.service(f.otherRoot).updateConfig({ attachmentQuotaBytes: 2 * 1024 * 1024 })
    ]);
    expect(result).toMatchObject([
      { status: "rejected", reason: { code: "INVALID_ARGUMENT" } },
      { status: "fulfilled" }
    ]);
    expect((await loadGlobalConfig(f.paths)).security.attachmentQuotaBytes).toBe(2 * 1024 * 1024);
  });

  it("preserves selected-agent metadata omitted from a plan during inspection", async () => {
    const f = await fixture();
    const existing = agent("existing");
    await saveRegistry(f.paths, { version: 1, agents: [existing] });
    await f
      .service(f.root, async () => {
        await f
          .service(f.otherRoot)
          .updateAgentMetadata("existing", { description: "fresh description", usageHint: "fresh hint" });
      })
      .apply({
        agents: [
          { url: existing.entryPoint.url, displayName: existing.displayName },
          { url: "https://m365.cloud.microsoft/chat/new", displayName: "new agent" }
        ]
      });
    expect((await loadRegistry(f.paths)).agents.find((entry) => entry.alias === "existing")).toMatchObject({
      description: "fresh description",
      usageHint: "fresh hint"
    });
  });

  it("keeps a concurrent capability edit omitted from the plan and approves the merged class", async () => {
    const f = await fixture();
    const existing = agent("existing");
    await saveRegistry(f.paths, { version: 1, agents: [existing] });
    const result = await f
      .service(f.root, async () => {
        await f.service(f.otherRoot).updateAgentMetadata("existing", { capabilityClass: "actions-possible" });
      })
      .apply({
        agents: [
          { url: existing.entryPoint.url, displayName: existing.displayName },
          { url: "https://m365.cloud.microsoft/chat/new", displayName: "new agent" }
        ]
      });
    expect(result.approved).toBe(true);
    expect(
      (await loadRegistry(f.paths)).agents.find((entry) => entry.alias === "existing")?.capabilityClass
    ).toBe("actions-possible");
    expect((await loadGlobalConfig(f.paths)).security.allowedCapabilityClasses).toContain("actions-possible");
    expect((await loadApprovals(f.paths)).approvals[0].approvedBindings).toContainEqual(
      expect.objectContaining({ alias: "existing", capabilityClass: "actions-possible" })
    );
  });

  it("accepts a concurrent explicit edit that already has the requested normalized value", async () => {
    const f = await fixture();
    const existing = agent("existing");
    await saveRegistry(f.paths, { version: 1, agents: [existing] });
    await expect(
      f
        .service(f.root, async () => {
          await f.service(f.otherRoot).updateAgentMetadata("existing", { usageHint: "shared hint" });
        })
        .apply({
          agents: [
            { url: existing.entryPoint.url, displayName: existing.displayName, usageHint: "  shared hint  " },
            { url: "https://m365.cloud.microsoft/chat/new", displayName: "new agent" }
          ]
        })
    ).resolves.toMatchObject({ approved: true });
    expect((await loadRegistry(f.paths)).agents.find((entry) => entry.alias === "existing")?.usageHint).toBe(
      "shared hint"
    );
  });

  it("preserves another workspace's approval while revoking under a contended lock", async () => {
    const f = await fixture();
    const a = agent("first"),
      b = agent("second");
    await saveRegistry(f.paths, { version: 1, agents: [a, b] });
    const planA = { agents: [{ url: a.entryPoint.url, displayName: a.displayName }] };
    const planB = { agents: [{ url: b.entryPoint.url, displayName: b.displayName }] };
    await f.service().apply(planA);
    await f.service(f.otherRoot).apply(planB);
    const unlock = await holdLock(`${f.paths.approvals}.lock`);
    const pending = Promise.allSettled([f.service().revokeWorkspace(), f.service(f.otherRoot).apply(planB)]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      await unlock();
    }
    expect((await pending).every((result) => result.status === "fulfilled")).toBe(true);
    const approvals = await loadApprovals(f.paths);
    const workspaces = new WorkspaceService();
    expect(approvals.approvals.map((entry) => entry.workspaceKey)).toEqual([
      (await workspaces.load(f.otherRoot)).workspaceKey
    ]);
  });

  it.each(["description", "usageHint", "capabilityClass"] as const)(
    "rejects competing explicit %s edits before writing a workspace",
    async (field) => {
      const f = await fixture();
      const existing = agent("existing");
      await saveRegistry(f.paths, { version: 1, agents: [existing] });
      const service = f.service(f.root, async () => {
        await f.service(f.otherRoot).updateAgentMetadata("existing", {
          [field]: field === "capabilityClass" ? "actions-possible" : "window B"
        });
      });
      await expect(
        service.apply({
          agents: [
            {
              url: existing.entryPoint.url,
              displayName: existing.displayName,
              [field]: field === "capabilityClass" ? "knowledge-only" : "window A"
            },
            { url: "https://m365.cloud.microsoft/chat/new", displayName: "new agent" }
          ]
        })
      ).rejects.toMatchObject({ code: "CONCURRENT_REQUEST" });
      expect((await loadRegistry(f.paths)).agents.find((entry) => entry.alias === "existing")?.[field]).toBe(
        field === "capabilityClass" ? "actions-possible" : "window B"
      );
      await expect(stat(path.join(f.root, ".m365-agents.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await loadApprovals(f.paths)).approvals).toHaveLength(0);
    }
  );
});

describe("v0.2.13 registry mutation review regressions", () => {
  async function contended<T>(paths: ReturnType<typeof appPaths>, action: () => Promise<T>) {
    const unlock = await holdLock(`${paths.registry}.lock`);
    const pending = action();
    try {
      await new Promise((resolve) => setTimeout(resolve, 160));
    } finally {
      await unlock();
    }
    return pending;
  }

  it("keeps both removals from different setup windows", async () => {
    const f = await fixture();
    await saveRegistry(f.paths, { version: 1, agents: [agent("alpha"), agent("beta"), agent("keep")] });
    const results = await contended(f.paths, () =>
      Promise.allSettled([f.service().removeAgent("alpha"), f.service(f.otherRoot).removeAgent("beta")])
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await loadRegistry(f.paths)).agents.map((a) => a.alias)).toEqual(["keep"]);
  });

  it.each(["same-agent", "different-agents"])("keeps metadata edits to %s", async (mode) => {
    const f = await fixture();
    await saveRegistry(f.paths, { version: 1, agents: [agent("alpha"), agent("beta")] });
    await contended(f.paths, () =>
      Promise.all([
        f.service().updateAgentMetadata("alpha", { description: "new description" }),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return f
            .service(f.otherRoot)
            .updateAgentMetadata(mode === "same-agent" ? "alpha" : "beta", { usageHint: "new hint" });
        })()
      ])
    );
    const { agents } = await loadRegistry(f.paths);
    expect(agents.find((a) => a.alias === "alpha")?.description).toBe("new description");
    expect(agents.find((a) => a.alias === (mode === "same-agent" ? "alpha" : "beta"))?.usageHint).toBe(
      "new hint"
    );
  });

  it("does not resurrect a removed agent when another window edits metadata", async () => {
    const f = await fixture();
    const alpha = agent("alpha"),
      beta = agent("beta");
    await saveRegistry(f.paths, { version: 1, agents: [alpha, beta] });
    const roster = {
      agents: [alpha, beta].map((a) => ({ url: a.entryPoint.url, displayName: a.displayName }))
    };
    await f.service().apply(roster);
    await f.service(f.otherRoot).apply(roster);
    await contended(f.paths, () =>
      Promise.all([
        f.service().removeAgent("alpha"),
        f.service(f.otherRoot).updateAgentMetadata("beta", { description: "fresh" })
      ])
    );
    const { agents } = await loadRegistry(f.paths);
    expect(agents.map((a) => a.alias)).toEqual(["beta"]);
    expect(agents[0].description).toBe("fresh");
    const workspace = await new WorkspaceService().load(f.otherRoot);
    const approvals = await loadApprovals(f.paths);
    const approval = new ApprovalService(approvals);
    expect(approval.status(workspace, new Map(agents.map((a) => [a.alias, a])))).toBe("approval-required");
  });

  it("keeps simultaneous CLI removals and reports a repeated removal accurately", async () => {
    const f = await fixture();
    await saveRegistry(f.paths, { version: 1, agents: [agent("alpha"), agent("beta"), agent("keep")] });
    const { deps } = makeCommandDeps({ paths: f.paths });
    const result = await contended(f.paths, () =>
      Promise.all([runAgentRemove(deps, "alpha"), runAgentRemove(deps, "beta")])
    );
    expect(result.map((r) => r.removed)).toEqual([true, true]);
    expect((await loadRegistry(f.paths)).agents.map((a) => a.alias)).toEqual(["keep"]);
    expect(await runAgentRemove(deps, "alpha")).toMatchObject({ removed: false });
  });

  function addDeps(f: Awaited<ReturnType<typeof fixture>>, alias: string) {
    return makeCommandDeps({
      paths: f.paths,
      env: { M365_AGENT_ALIAS: alias, M365_AGENT_CAPABILITY_CLASS: "knowledge-only" },
      connectOrStartDefaultBroker: async () =>
        ({
          close() {},
          async call() {
            return {
              url: `https://m365.cloud.microsoft/chat/${alias}`,
              displayName: alias,
              surface: "m365-copilot",
              adapterId: "agent-builder-chat@1",
              validatedUrlPattern: `^/chat/${alias}$`
            };
          }
        }) as unknown as IpcClient
    }).deps;
  }

  it("keeps different aliases registered by simultaneous CLI adds", async () => {
    const f = await fixture();
    await contended(f.paths, () =>
      Promise.all([
        runAgentAdd(addDeps(f, "alpha"), { url: "https://m365.cloud.microsoft/chat/alpha" }),
        runAgentAdd(addDeps(f, "beta"), { url: "https://m365.cloud.microsoft/chat/beta" })
      ])
    );
    expect((await loadRegistry(f.paths)).agents.map((a) => a.alias)).toEqual(["alpha", "beta"]);
  });

  it("checks duplicate aliases inside the lock and preserves force replacement semantics", async () => {
    const f = await fixture();
    const deps = addDeps(f, "alpha");
    const result = await contended(f.paths, () =>
      Promise.allSettled([
        runAgentAdd(deps, { url: "https://m365.cloud.microsoft/chat/alpha" }),
        runAgentAdd(deps, { url: "https://m365.cloud.microsoft/chat/alpha" })
      ])
    );
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "INVALID_ARGUMENT" }
    });
    await runAgentAdd(deps, { url: "https://m365.cloud.microsoft/chat/alpha", force: true });
    expect((await loadRegistry(f.paths)).agents).toMatchObject([
      { alias: "alpha", enabled: false, verification: { status: "unverified" } }
    ]);
  });

  it("keeps a CLI removal alongside a different CLI addition", async () => {
    const f = await fixture();
    await saveRegistry(f.paths, { version: 1, agents: [agent("alpha"), agent("keep")] });
    await contended(f.paths, () =>
      Promise.all([
        runAgentRemove(makeCommandDeps({ paths: f.paths }).deps, "alpha"),
        runAgentAdd(addDeps(f, "beta"), { url: "https://m365.cloud.microsoft/chat/beta" })
      ])
    );
    expect((await loadRegistry(f.paths)).agents.map((a) => a.alias)).toEqual(["beta", "keep"]);
  });
});
