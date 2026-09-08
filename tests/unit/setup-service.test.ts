import { DEFAULT_DOWNLOAD_HOSTS } from "../../src/config/defaults.js";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SetupService,
  computeBrokerScopedConfigChanges,
  isSignInCancelledError,
  type ApplyPlan,
  type SetupDeps
} from "../../src/services/setup-service.js";
import { DomainError } from "../../src/domain/errors.js";
import type { ProgressEvent, ProgressSink } from "../../src/domain/progress.js";
import { deriveBindingFingerprint, type BrowserAgentDefinition } from "../../src/domain/agent.js";
import type { CapturedAgent } from "../../src/transports/transport.js";
import type { IpcClient } from "../../src/ipc/client.js";
import { loadRegistry, saveRegistry } from "../../src/config/registry.js";
import { loadApprovals } from "../../src/config/approvals.js";
import { defaultGlobalConfig, loadGlobalConfig } from "../../src/config/global-config.js";
import { HealthService } from "../../src/services/health-service.js";
import { appPaths, type AppPaths } from "../../src/config/paths.js";
import { writeDescriptor } from "../../src/broker/broker-descriptor.js";
import { BROKER_PROTOCOL } from "../../src/ipc/protocol.js";
import { noopPreparer } from "../cli/helpers.js";

/** A fake IpcClient: records every call, dispatches by method name from a script, and (when the
 * script entry carries `progress`) synchronously replays those progress events through
 * `options.onProgress` before resolving -- exactly mirroring how the real IpcClient forwards
 * server-sent progress frames to the caller that started the request. */
type ScriptedAnswer = unknown | ((params: Record<string, unknown>) => unknown);
type FakeIpcClient = {
  calls: Array<{ method: string; params: unknown }>;
  closed: boolean;
  call(
    method: string,
    params: unknown,
    requestId?: string,
    signal?: AbortSignal,
    options?: { onProgress?: ProgressSink }
  ): Promise<unknown>;
  close(): void;
};

function makeFakeIpcClient(
  answers: Record<string, ScriptedAnswer>,
  progress: Partial<Record<string, ProgressEvent[]>> = {}
): FakeIpcClient {
  const calls: FakeIpcClient["calls"] = [];
  return {
    calls,
    closed: false,
    async call(method, params, _requestId, _signal, options) {
      calls.push({ method, params });
      for (const event of progress[method] ?? []) options?.onProgress?.(event);
      if (!Object.hasOwn(answers, method)) throw new Error(`Unstubbed method in test: ${method}`);
      const answer = answers[method];
      return typeof answer === "function"
        ? (answer as (p: Record<string, unknown>) => unknown)(params as Record<string, unknown>)
        : answer;
    },
    close() {
      this.closed = true;
    }
  };
}

async function makeTempPaths(): Promise<AppPaths> {
  const base = await mkdtemp(path.join(os.tmpdir(), "apl-setup-service-"));
  return appPaths(path.join(base, "appdata"));
}

async function makeWorkspaceRoot(): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), "apl-setup-service-workspace-"));
  const root = path.join(base, "repo");
  await mkdir(root, { recursive: true });
  return root;
}

function baseDeps(paths: AppPaths, overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    paths,
    connect: async () => {
      throw new Error("connect was not stubbed for this test");
    },
    preparer: noopPreparer,
    clock: () => new Date("2026-09-01T00:00:00.000Z"),
    root: () => "/repo",
    ...overrides
  };
}

function verifiedAgent(
  alias: string,
  url: string,
  overrides: Partial<BrowserAgentDefinition> = {}
): BrowserAgentDefinition {
  const displayName = overrides.displayName ?? alias;
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
    },
    // A full `verification` override (as used by the discover-merge test, to set
    // `expectedStableAgentId`) replaces the object above entirely -- BrowserAgentDefinition's
    // `verification` is not itself partial, so a caller-provided one is always complete.
    ...overrides
  };
  agent.verification.bindingFingerprint = deriveBindingFingerprint(agent);
  return agent;
}

function captured(
  url: string,
  displayName: string,
  stableAgentId?: string,
  adapterId = "m365-copilot-chat@1"
): CapturedAgent {
  return {
    url,
    surface: "m365-copilot",
    adapterId,
    displayName,
    stableAgentId,
    validatedUrlPattern: `^${new URL(url).pathname}$`
  };
}

describe("SetupService.status", () => {
  it("reports broker.live=false without starting a broker when none is reachable", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot(); // exists, but has no .m365-agents.json yet
    let connectCount = 0;
    const service = new SetupService(
      baseDeps(paths, {
        connect: async () => {
          connectCount += 1;
          throw new Error("status() must never start a broker");
        },
        connectExisting: async () => undefined,
        root: () => root
      })
    );

    const status = await service.status();

    expect(status.broker).toEqual({ live: false, incidents: [] });
    expect(connectCount).toBe(0);
    expect(status.workspace).toEqual({
      root,
      configured: false,
      approvalStatus: "not-configured",
      assignments: []
    });
    expect(status.platform.os).toBe(process.platform);
  });

  it("reports broker.live=true and forwards authState/incidents when connectExisting succeeds", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const client = makeFakeIpcClient({
      "broker.health": {
        authState: { state: "authenticated", checkedAt: "2026-09-01T00:00:00.000Z" },
        incidents: [{ at: "2026-09-01T00:00:00.000Z", code: "UI_CHANGED", message: "boom" }]
      }
    });
    const service = new SetupService(
      baseDeps(paths, { connectExisting: async () => client as unknown as IpcClient, root: () => root })
    );

    const status = await service.status();

    expect(status.broker.live).toBe(true);
    expect(status.broker.authState).toEqual({
      state: "authenticated",
      checkedAt: "2026-09-01T00:00:00.000Z"
    });
    expect(status.broker.incidents).toHaveLength(1);
    expect(client.closed).toBe(true);
  });
});

describe("SetupService.ensureSignedIn", () => {
  it.each([false, true])(
    "skips instructions and browser.login when authenticated (interactive: %s)",
    async (interactive) => {
      const paths = await makeTempPaths();
      const client = makeFakeIpcClient({ "browser.authState": { state: "authenticated" } });
      const service = new SetupService(
        baseDeps(paths, { connect: async () => client as unknown as IpcClient })
      );

      const result = await service.ensureSignedIn({
        interactive,
        beforeInteractiveLogin: async () => {
          throw new Error("Instructions must not appear when already authenticated");
        }
      });

      expect(result).toEqual({ state: "authenticated" });
      expect(client.calls.map((c) => c.method)).toEqual(["browser.authState"]);
      expect(client.closed).toBe(true);
    }
  );

  it("opens the interactive sign-in window and forwards its progress when interactive and not yet signed in", async () => {
    const paths = await makeTempPaths();
    const events: ProgressEvent[] = [];
    const client = makeFakeIpcClient(
      {
        "browser.authState": { state: "sign-in-required" },
        "browser.login": { authenticated: true, state: "authenticated" }
      },
      { "browser.login": [{ phase: "login-waiting" }, { phase: "login-closing" }] }
    );
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient })
    );

    const result = await service.ensureSignedIn({
      interactive: true,
      onProgress: (event) => events.push(event)
    });

    expect(result).toEqual({ state: "authenticated" });
    expect(client.calls.map((c) => c.method)).toEqual(["browser.authState", "browser.login"]);
    expect(events.map((e) => e.phase)).toEqual([
      "connecting",
      "connecting",
      "connecting",
      "login-waiting",
      "login-closing"
    ]);
    expect(events.slice(0, 3).every((event) => event.message && event.elapsedMs !== undefined)).toBe(true);
  });

  it("emits a bounded heartbeat while waiting and clears it after setup finishes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const paths = await makeTempPaths();
      const client = makeFakeIpcClient({ "browser.authState": { state: "sign-in-required" } });
      const service = new SetupService(
        baseDeps(paths, { connect: async () => client as unknown as IpcClient })
      );
      const events: ProgressEvent[] = [];
      let showInstructions!: () => void;
      const shown = new Promise<void>((resolve) => {
        showInstructions = resolve;
      });
      let answer!: (value: boolean) => void;
      const choice = new Promise<boolean>((resolve) => {
        answer = resolve;
      });
      const signingIn = service.ensureSignedIn({
        interactive: true,
        onProgress: (event) => events.push(event),
        beforeInteractiveLogin: () => {
          showInstructions();
          return choice;
        }
      });

      await shown;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(events.some((event) => event.message?.endsWith("(still working)"))).toBe(true);
      const countAfterHeartbeat = events.length;

      answer(false);
      await expect(signingIn).rejects.toMatchObject({ code: "AUTH_FAILED" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events).toHaveLength(countAfterHeartbeat);
      expect(client.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the forwarded broker phase on a setup heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const paths = await makeTempPaths();
      let loginStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        loginStarted = resolve;
      });
      let releaseLogin!: () => void;
      const loginResult = new Promise<void>((resolve) => {
        releaseLogin = resolve;
      });
      const client = makeFakeIpcClient(
        {
          "browser.authState": { state: "sign-in-required" },
          "browser.login": async () => {
            loginStarted();
            await loginResult;
            return { authenticated: true, state: "authenticated" };
          }
        },
        { "browser.login": [{ phase: "login-waiting", message: "Complete sign-in" }] }
      );
      const service = new SetupService(
        baseDeps(paths, { connect: async () => client as unknown as IpcClient })
      );
      const events: ProgressEvent[] = [];
      const signingIn = service.ensureSignedIn({
        interactive: true,
        onProgress: (event) => events.push(event)
      });

      await started;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(events.at(-1)).toMatchObject({
        phase: "login-waiting",
        message: "Complete sign-in (still working)",
        elapsedMs: 5_000
      });

      releaseLogin();
      await expect(signingIn).resolves.toEqual({ state: "authenticated" });
      expect(client.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores progress sink failures and still completes setup", async () => {
    const paths = await makeTempPaths();
    const client = makeFakeIpcClient({ "browser.authState": { state: "authenticated" } });
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient })
    );

    await expect(
      service.ensureSignedIn({
        interactive: false,
        onProgress: () => {
          throw new Error("panel was disposed");
        }
      })
    ).resolves.toEqual({ state: "authenticated" });
    expect(client.closed).toBe(true);
  });

  it("throws AUTH_REQUIRED without calling browser.login when not interactive and not signed in", async () => {
    const paths = await makeTempPaths();
    const client = makeFakeIpcClient({ "browser.authState": { state: "sign-in-required" } });
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient })
    );

    await expect(
      service.ensureSignedIn({
        interactive: false,
        beforeInteractiveLogin: async () => {
          throw new Error("Silent sign-in must not show instructions");
        }
      })
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED"
    });
    expect(client.calls.map((c) => c.method)).toEqual(["browser.authState"]);
  });

  it.each([true, false])(
    "waits for the instructions before deciding whether to launch (continue: %s)",
    async (proceed) => {
      const paths = await makeTempPaths();
      const client = makeFakeIpcClient({
        "browser.authState": { state: "sign-in-required" },
        "browser.login": { authenticated: true, state: "authenticated" }
      });
      const service = new SetupService(
        baseDeps(paths, { connect: async () => client as unknown as IpcClient })
      );
      let showInstructions!: () => void;
      const shown = new Promise<void>((resolve) => {
        showInstructions = resolve;
      });
      let answer!: (value: boolean) => void;
      const choice = new Promise<boolean>((resolve) => {
        answer = resolve;
      });
      const signingIn = service.ensureSignedIn({
        interactive: true,
        beforeInteractiveLogin: () => {
          showInstructions();
          return choice;
        }
      });

      await shown;
      expect(client.calls.map((c) => c.method)).toEqual(["browser.authState"]);
      answer(proceed);
      if (proceed) {
        await expect(signingIn).resolves.toEqual({ state: "authenticated" });
        expect(client.calls.map((c) => c.method)).toEqual(["browser.authState", "browser.login"]);
      } else {
        const error = await signingIn.catch((caught: unknown) => caught);
        expect(isSignInCancelledError(error)).toBe(true);
        expect(client.calls.map((c) => c.method)).toEqual(["browser.authState"]);
      }
      expect(client.closed).toBe(true);
    }
  );
});

describe("SetupService.discover", () => {
  it("reports setup connection progress before forwarding discovery progress", async () => {
    const paths = await makeTempPaths();
    const client = makeFakeIpcClient(
      { "agent.discover": { agents: [], warnings: [] } },
      { "agent.discover": [{ phase: "discovering", message: "Loading agents" }] }
    );
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient })
    );
    const events: ProgressEvent[] = [];

    await service.discover((event) => events.push(event));

    expect(events.map((event) => event.phase)).toEqual([
      "connecting",
      "connecting",
      "connecting",
      "discovering"
    ]);
    expect(events.slice(0, 3).every((event) => event.elapsedMs !== undefined)).toBe(true);
  });

  it("refreshes the registered description without changing the verified binding or approving a workspace", async () => {
    const paths = await makeTempPaths();
    const url = "https://m365.cloud.microsoft/chat/agent/agent-a";
    const original = verifiedAgent("agent-a", url, { description: "Old manual text" });
    await saveRegistry(paths, { version: 1, agents: [original] });
    const client = makeFakeIpcClient({
      "agent.discover": {
        agents: [
          {
            url,
            displayName: "Agent A",
            surface: "m365-copilot",
            source: "store",
            description: "Description from Microsoft 365"
          }
        ],
        warnings: []
      }
    });
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient })
    );
    const beforeApprovals = await loadApprovals(paths);

    const { candidates } = await service.discover();

    expect(candidates[0].description).toBe("Description from Microsoft 365");
    expect((await loadRegistry(paths)).agents[0]).toEqual({
      ...original,
      description: "Description from Microsoft 365"
    });
    expect(await loadApprovals(paths)).toEqual(beforeApprovals);
  });

  it("merges a discovered agent into its matching registry entry by stableAgentId, and keeps an unmatched registry entry", async () => {
    const paths = await makeTempPaths();
    const matched = verifiedAgent("agent-a", "https://m365.cloud.microsoft/chat/agent-a", {
      displayName: "Agent A",
      verification: {
        status: "verified",
        adapterId: "agent-builder-chat@1",
        expectedDisplayName: "Agent A",
        expectedStableAgentId: "stable-123",
        expectedSurface: "m365-copilot",
        validatedUrlPattern: "^/chat/agent-a$",
        bindingFingerprint: `sha256:${"0".repeat(64)}`,
        validatedAt: "2026-09-01T00:00:00.000Z"
      }
    });
    const unmatched = verifiedAgent("agent-b", "https://m365.cloud.microsoft/chat/agent-b", {
      displayName: "Agent B"
    });
    await saveRegistry(paths, { version: 1, agents: [matched, unmatched] });
    const client = makeFakeIpcClient({
      "agent.discover": {
        agents: [
          {
            url: "https://m365.cloud.microsoft/chat/agent/stable-123",
            surface: "m365-copilot",
            displayName: "Agent A (discovered)",
            stableAgentId: "stable-123",
            source: "sidebar"
          }
        ],
        warnings: ["no-sidebar"]
      }
    });
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient })
    );

    const { candidates, warnings } = await service.discover();

    expect(warnings).toEqual(["no-sidebar"]);
    expect(candidates).toHaveLength(2);
    const merged = candidates.find((c) => c.stableAgentId === "stable-123");
    expect(merged?.source).toBe("sidebar");
    expect(merged?.registered?.alias).toBe("agent-a");
    const kept = candidates.find((c) => c.url === "https://m365.cloud.microsoft/chat/agent-b");
    expect(kept?.source).toBe("registry");
    expect(kept?.registered?.alias).toBe("agent-b");
  });
});

describe("SetupService.apply", () => {
  it("reuses a verified registry entry by URL, verifies new agents, uniquifies clashing slugs, skips a failing agent, and writes registry/config/workspace/approvals", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const reuseUrl = "https://m365.cloud.microsoft/chat/reuse-agent";
    const existing = verifiedAgent("reuse-agent", reuseUrl, { displayName: "Reuse Agent" });
    await saveRegistry(paths, { version: 1, agents: [existing] });

    const newOneUrl = "https://m365.cloud.microsoft/chat/new-one";
    const newTwoUrl = "https://m365.cloud.microsoft/chat/new-two";
    const brokenUrl = "https://m365.cloud.microsoft/chat/broken";
    let connectCount = 0;
    const client = makeFakeIpcClient({
      "agent.inspectUrl": (params: Record<string, unknown>) => {
        const url = params.url as string;
        if (url === newOneUrl) return captured(newOneUrl, "Support Bot");
        if (url === newTwoUrl) return captured(newTwoUrl, "Support Bot");
        if (url === brokenUrl)
          throw new DomainError("AGENT_IDENTITY_UNVERIFIED", "Could not verify agent identity.");
        throw new Error(`unexpected url ${url}`);
      }
    });
    const service = new SetupService(
      baseDeps(paths, {
        connect: async () => {
          connectCount += 1;
          return client as unknown as IpcClient;
        },
        root: () => root
      })
    );

    const plan: ApplyPlan = {
      agents: [
        { url: reuseUrl, displayName: "Reuse Agent" },
        { url: newOneUrl, displayName: "Support Bot" },
        { url: newTwoUrl, displayName: "Support Bot", capabilityClass: "actions-possible" },
        { url: brokenUrl, displayName: "Broken Agent" }
      ],
      downloadHosts: ["contoso.example"],
      acceptDownloads: true
    };
    const events: ProgressEvent[] = [];
    const result = await service.apply(plan, (event) => events.push(event));

    expect(connectCount).toBe(1); // one client, opened lazily, reused across every inspectUrl call
    expect(client.closed).toBe(true);
    expect(events.filter((e) => e.phase === "verifying")).toHaveLength(4);
    expect(events.at(-1)?.phase).toBe("done");

    const verified = result.registered.filter((r) => r.verified).map((r) => r.alias);
    expect(verified.sort()).toEqual(["reuse-agent", "support-bot", "support-bot-2"]);
    const failed = result.registered.find((r) => !r.verified);
    expect(failed?.error?.code).toBe("AGENT_IDENTITY_UNVERIFIED");
    expect(result.approved).toBe(true);
    expect(result.approvedBindings).toHaveLength(3);
    expect(result.restartRequired).toBe(true);
    expect(result.changedKeys.sort()).toEqual([
      "navigation.downloadHosts",
      "security.allowedCapabilityClasses"
    ]);

    const registry = await loadRegistry(paths);
    expect(registry.agents.map((a) => a.alias).sort()).toEqual([
      "reuse-agent",
      "support-bot",
      "support-bot-2"
    ]);

    const config = await loadGlobalConfig(paths);
    expect(config.security.allowedCapabilityClasses).toContain("actions-possible");
    expect(config.navigation.downloadHosts).toEqual(["contoso.example"]);
    expect(config.browser.acceptDownloads).toBe(true);

    const written = JSON.parse(await readFile(path.join(root, ".m365-agents.json"), "utf8"));
    expect(written.agents.map((a: { alias: string }) => a.alias)).toEqual([
      "reuse-agent",
      "support-bot",
      "support-bot-2"
    ]);

    const health = new HealthService({ paths, preparer: noopPreparer });
    const report = (await health.workspaceReport(root)) as {
      assignments: Array<{ alias: string; status: string }>;
    };
    expect(report.assignments.every((a) => a.status === "ready")).toBe(true);
  });

  it("throws the first error when every requested agent fails verification", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const client = makeFakeIpcClient({
      "agent.inspectUrl": () => {
        throw new DomainError("AGENT_IDENTITY_UNVERIFIED", "first failure");
      }
    });
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient, root: () => root })
    );

    await expect(
      service.apply({
        agents: [
          { url: "https://m365.cloud.microsoft/chat/one", displayName: "One" },
          { url: "https://m365.cloud.microsoft/chat/two", displayName: "Two" }
        ]
      })
    ).rejects.toMatchObject({ code: "AGENT_IDENTITY_UNVERIFIED" });
  });

  it("rejects an invalid download host with INVALID_ARGUMENT and writes nothing", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const service = new SetupService(baseDeps(paths, { root: () => root }));

    await expect(service.apply({ agents: [], downloadHosts: ["not a host"] })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT"
    });

    const config = await loadGlobalConfig(paths);
    expect(config.navigation.downloadHosts).toEqual([...DEFAULT_DOWNLOAD_HOSTS]);
  });

  it("leaves an existing workspace file untouched when the plan requests zero agents", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const existing = verifiedAgent("kept", "https://m365.cloud.microsoft/chat/kept");
    await saveRegistry(paths, { version: 1, agents: [existing] });
    const workspaceFile = path.join(root, ".m365-agents.json");
    await writeFile(
      workspaceFile,
      JSON.stringify({
        version: 1,
        agents: [{ alias: "kept", bindingFingerprint: existing.verification.bindingFingerprint }]
      })
    );
    const service = new SetupService(baseDeps(paths, { root: () => root }));

    const result = await service.apply({ agents: [], acceptDownloads: true });

    expect(result.approved).toBe(true);
    const written = JSON.parse(await readFile(workspaceFile, "utf8"));
    expect(written.agents.map((a: { alias: string }) => a.alias)).toEqual(["kept"]);
  });

  it("reports restartRequired=false and an empty changedKeys when nothing broker-scoped changed", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const reuseUrl = "https://m365.cloud.microsoft/chat/reuse-agent";
    const existing = verifiedAgent("reuse-agent", reuseUrl, { displayName: "Reuse Agent" });
    await saveRegistry(paths, { version: 1, agents: [existing] });
    const service = new SetupService(baseDeps(paths, { root: () => root }));

    const result = await service.apply({ agents: [{ url: reuseUrl, displayName: "Reuse Agent" }] });

    expect(result.registered).toEqual([{ alias: "reuse-agent", displayName: "Reuse Agent", verified: true }]);
    expect(result.restartRequired).toBe(false);
    expect(result.changedKeys).toEqual([]);
  });

  it("revalidates a reused entry whose display name disagrees and preserves its binding", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const url = "https://m365.cloud.microsoft/chat/agent-t09";
    const existing = verifiedAgent("apl-t09", url, { displayName: "APL-T09" });
    existing.verification.expectedStableAgentId = "stable-t09";
    existing.verification.bindingFingerprint = deriveBindingFingerprint(existing);
    existing.verification.expectedDisplayName = "Copilot にメッセージを送信する";
    const fingerprint = existing.verification.bindingFingerprint;
    await saveRegistry(paths, { version: 1, agents: [existing] });
    const client = makeFakeIpcClient({
      "agent.inspectUrl": captured(`${url}?conversationId=transient`, "APL-T09", "stable-t09")
    });
    const service = new SetupService(
      baseDeps(paths, { root: () => root, connect: async () => client as unknown as IpcClient })
    );

    const result = await service.apply({ agents: [{ url, displayName: "APL-T09" }] });

    expect(result.registered).toEqual([{ alias: "apl-t09", displayName: "APL-T09", verified: true }]);
    const repaired = (await loadRegistry(paths)).agents[0];
    expect(repaired.verification.expectedDisplayName).toBe("APL-T09");
    expect(repaired.verification.bindingFingerprint).toBe(fingerprint);
    expect(repaired.alias).toBe("apl-t09");
  });

  it("rejects a reused entry when direct verification reports a different identity", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const url = "https://m365.cloud.microsoft/chat/agent-t09";
    const existing = verifiedAgent("apl-t09", url, { displayName: "APL-T09" });
    existing.verification.expectedDisplayName = "Old control label";
    await saveRegistry(paths, { version: 1, agents: [existing] });
    const client = makeFakeIpcClient({ "agent.inspectUrl": captured(url, "APL-T09", "new-stable-id") });
    const service = new SetupService(
      baseDeps(paths, { root: () => root, connect: async () => client as unknown as IpcClient })
    );

    await expect(service.apply({ agents: [{ url, displayName: "APL-T09" }] })).rejects.toMatchObject({
      code: "AGENT_IDENTITY_UNVERIFIED"
    });
  });

  it("does not write the registry when reused identity verification reports a different URL", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const url = "https://m365.cloud.microsoft/chat/agent-t09";
    const existing = verifiedAgent("apl-t09", url, { displayName: "APL-T09" });
    existing.verification.expectedDisplayName = "Old control label";
    await saveRegistry(paths, { version: 1, agents: [existing] });
    const client = makeFakeIpcClient({
      "agent.inspectUrl": captured("https://m365.cloud.microsoft/chat/other", "APL-T09")
    });
    const service = new SetupService(
      baseDeps(paths, { root: () => root, connect: async () => client as unknown as IpcClient })
    );

    await expect(service.apply({ agents: [{ url, displayName: "APL-T09" }] })).rejects.toMatchObject({
      code: "AGENT_IDENTITY_UNVERIFIED"
    });
    expect((await loadRegistry(paths)).agents[0].verification.expectedDisplayName).toBe("Old control label");
  });

  it("rejects a renamed capture without a stable ID and leaves the registry unchanged", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const url = "https://m365.cloud.microsoft/chat/agent-t09";
    const existing = verifiedAgent("apl-t09", url, { displayName: "APL-T09" });
    existing.verification.expectedDisplayName = "Old control label";
    await saveRegistry(paths, { version: 1, agents: [existing] });
    const client = makeFakeIpcClient({ "agent.inspectUrl": captured(url, "APL-T09") });
    const service = new SetupService(
      baseDeps(paths, { root: () => root, connect: async () => client as unknown as IpcClient })
    );

    await expect(service.apply({ agents: [{ url, displayName: "APL-T09" }] })).rejects.toMatchObject({
      code: "AGENT_IDENTITY_UNVERIFIED"
    });
    expect((await loadRegistry(paths)).agents[0].verification.expectedDisplayName).toBe("Old control label");
  });
});

describe("SetupService.updateConfig", () => {
  it("reports the broker-scoped keys a patch changed, and saves them", async () => {
    const paths = await makeTempPaths();
    const service = new SetupService(baseDeps(paths));

    const result = await service.updateConfig({ headless: false, downloadHosts: ["files.example.com"] });

    expect(result.restartRequired).toBe(true);
    expect(result.changedKeys.sort()).toEqual(["browser.headless", "navigation.downloadHosts"]);
    const saved = await loadGlobalConfig(paths);
    expect(saved.browser.headless).toBe(false);
    expect(saved.navigation.downloadHosts).toEqual(["files.example.com"]);
  });

  it("reports restartRequired=false when the patch changes nothing", async () => {
    const paths = await makeTempPaths();
    const service = new SetupService(baseDeps(paths));
    const before = await loadGlobalConfig(paths);

    const result = await service.updateConfig({ headless: before.browser.headless });

    expect(result).toEqual({ restartRequired: false, changedKeys: [] });
  });
});

describe("computeBrokerScopedConfigChanges", () => {
  it("reports nothing for two identical configs", () => {
    const config = defaultGlobalConfig("/profile");
    expect(computeBrokerScopedConfigChanges(config, config)).toEqual([]);
  });

  it("reports a changed browser.* key", () => {
    const before = defaultGlobalConfig("/profile");
    const after = { ...before, browser: { ...before.browser, headless: !before.browser.headless } };
    expect(computeBrokerScopedConfigChanges(before, after)).toEqual(["browser.headless"]);
  });

  it("reports a changed navigation.* key", () => {
    const before = defaultGlobalConfig("/profile");
    const after = { ...before, navigation: { ...before.navigation, downloadHosts: ["files.example.com"] } };
    expect(computeBrokerScopedConfigChanges(before, after)).toEqual(["navigation.downloadHosts"]);
  });

  it("reports a changed conversations.* or invocation.* key", () => {
    const before = defaultGlobalConfig("/profile");
    const afterConversations = {
      ...before,
      conversations: { ...before.conversations, maxTotal: before.conversations.maxTotal + 1 }
    };
    expect(computeBrokerScopedConfigChanges(before, afterConversations)).toEqual(["conversations.maxTotal"]);
    const afterInvocation = {
      ...before,
      invocation: { ...before.invocation, maxConcurrentTotal: before.invocation.maxConcurrentTotal + 1 }
    };
    expect(computeBrokerScopedConfigChanges(before, afterInvocation)).toEqual([
      "invocation.maxConcurrentTotal"
    ]);
  });

  it("reports security.allowedCapabilityClasses but ignores other security.* fields and list order", () => {
    const before = {
      ...defaultGlobalConfig("/profile"),
      security: { ...defaultGlobalConfig("/profile").security, allowedCapabilityClasses: ["knowledge-only"] }
    };
    const reordered = {
      ...before,
      security: {
        ...before.security,
        allowedCapabilityClasses: [...before.security.allowedCapabilityClasses]
      }
    };
    expect(computeBrokerScopedConfigChanges(before, reordered)).toEqual([]);
    const widened = {
      ...before,
      security: {
        ...before.security,
        allowedCapabilityClasses: ["knowledge-only", "actions-possible"] as Array<
          "knowledge-only" | "actions-possible"
        >
      }
    };
    expect(computeBrokerScopedConfigChanges(before, widened)).toEqual(["security.allowedCapabilityClasses"]);
  });
});

describe("SetupService.restartBroker", () => {
  it("shuts down a reachable broker, waits for its descriptor to disappear, then connects fresh", async () => {
    const paths = await makeTempPaths();
    const shutdownClient = makeFakeIpcClient({ "broker.shutdown": {} });
    const newClient = makeFakeIpcClient({});
    let existingCalls = 0;
    const service = new SetupService(
      baseDeps(paths, {
        connectExisting: async () => {
          existingCalls += 1;
          return existingCalls === 1 ? (shutdownClient as unknown as IpcClient) : undefined;
        },
        connect: async () => newClient as unknown as IpcClient
      })
    );

    await service.restartBroker();

    expect(shutdownClient.calls.map((c) => c.method)).toEqual(["broker.shutdown"]);
    expect(shutdownClient.closed).toBe(true);
    expect(newClient.closed).toBe(true);
  });

  it("does nothing to shut down when no broker is reachable, and still connects fresh afterward", async () => {
    const paths = await makeTempPaths();
    const newClient = makeFakeIpcClient({});
    const service = new SetupService(
      baseDeps(paths, {
        connectExisting: async () => undefined,
        connect: async () => newClient as unknown as IpcClient
      })
    );

    await service.restartBroker();

    expect(newClient.closed).toBe(true);
  });

  it(
    "throws BROKER_UNAVAILABLE with a manual-restart remediation when the previous broker never releases its endpoint",
    async () => {
      const paths = await makeTempPaths();
      const shutdownClient = makeFakeIpcClient({ "broker.shutdown": {} });
      let existingCalls = 0;
      const service = new SetupService(
        baseDeps(paths, {
          connectExisting: async () => {
            existingCalls += 1;
            if (existingCalls === 1) return shutdownClient as unknown as IpcClient;
            // Descriptor present, pid alive, but the pipe refuses connections: "live but unreachable".
            throw new DomainError("BROKER_UNAVAILABLE", "The broker descriptor exists but is unavailable.");
          },
          connect: async () => {
            throw new Error(
              "connect() must not be called when the previous broker never released its endpoint"
            );
          }
        })
      );

      // Real timers rather than fake ones: `restartBroker()` interleaves this loop's 50ms retries
      // with `prepare()`'s genuine filesystem I/O (via `initializeLocalState`), and fake timers
      // (which only intercept `setTimeout`, not libuv's I/O completion) cannot reliably drive a
      // promise chain that also depends on real I/O to progress -- it hangs waiting for the real
      // work while nothing is left to advance the fake clock. This test therefore genuinely waits
      // out the ~10s deadline; the generous timeout below covers CI scheduling slack.
      await expect(service.restartBroker()).rejects.toMatchObject({
        code: "BROKER_UNAVAILABLE",
        options: { remediation: "run: m365-agent broker restart" }
      });
    },
    process.platform === "win32" ? 60_000 : 15_000
  );

  it("treats a lost shutdown response followed by a successor descriptor as completed", async () => {
    const paths = await makeTempPaths();
    const owner = {
      pid: process.pid,
      pipeName: "/tmp/apl-setup-owner.sock",
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "setup-owner",
      authSecret: "o".repeat(43),
      createdAt: new Date().toISOString(),
      state: "running" as const
    };
    const successor = { ...owner, instanceId: "setup-successor", pipeName: "/tmp/apl-setup-successor.sock" };
    await writeDescriptor(paths, owner);
    const shutdownClient = makeFakeIpcClient({
      "broker.shutdown": async () => {
        await writeDescriptor(paths, successor);
        throw new DomainError("BROKER_UNAVAILABLE", "The shutdown response was lost.", true);
      }
    });
    const probeClient = makeFakeIpcClient({});
    const newClient = makeFakeIpcClient({});
    let existingCalls = 0;
    const service = new SetupService(
      baseDeps(paths, {
        connectExisting: async () => {
          existingCalls++;
          return existingCalls === 1
            ? (shutdownClient as unknown as IpcClient)
            : (probeClient as unknown as IpcClient);
        },
        connect: async () => newClient as unknown as IpcClient
      })
    );

    await service.restartBroker();

    expect(existingCalls).toBe(2);
    expect(shutdownClient.closed).toBe(true);
    expect(probeClient.closed).toBe(true);
    expect(newClient.closed).toBe(true);
  });
});

describe("SetupService.signOut", () => {
  it("resets the profile, then shuts down the broker, then closes the client", async () => {
    const paths = await makeTempPaths();
    const client = makeFakeIpcClient({ "browser.resetProfile": { reset: true }, "broker.shutdown": {} });
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient })
    );

    await service.signOut();

    expect(client.calls.map((c) => c.method)).toEqual(["browser.resetProfile", "broker.shutdown"]);
    expect(client.closed).toBe(true);
  });

  it("does not wait on a successor broker when shutdown replaces the descriptor", async () => {
    const paths = await makeTempPaths();
    const owner = {
      pid: process.pid,
      pipeName: "/tmp/apl-signout-owner.sock",
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "signout-owner",
      authSecret: "s".repeat(43),
      createdAt: new Date().toISOString(),
      state: "running" as const
    };
    const successor = {
      ...owner,
      instanceId: "signout-successor",
      pipeName: "/tmp/apl-signout-successor.sock"
    };
    await writeDescriptor(paths, owner);
    const client = makeFakeIpcClient({
      "browser.resetProfile": { reset: true },
      "broker.shutdown": async () => {
        await writeDescriptor(paths, successor);
        throw new DomainError("BROKER_UNAVAILABLE", "The shutdown response was lost.", true);
      }
    });
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient })
    );

    await service.signOut();

    expect(client.closed).toBe(true);
    expect((await readFile(paths.descriptor, "utf8")).toString()).toContain("signout-successor");
  });
});

describe("SetupService.cancelSignIn", () => {
  it("cancels through connectExisting without ever starting a new broker", async () => {
    const paths = await makeTempPaths();
    let connectCalls = 0;
    const client = makeFakeIpcClient({ "browser.cancelLogin": { cancelled: true } });
    const service = new SetupService(
      baseDeps(paths, {
        connect: async () => {
          connectCalls += 1;
          throw new Error("cancelSignIn must prefer connectExisting over connect");
        },
        connectExisting: async () => client as unknown as IpcClient
      })
    );

    await expect(service.cancelSignIn()).resolves.toEqual({ cancelled: true });

    expect(client.calls.map((c) => c.method)).toEqual(["browser.cancelLogin"]);
    expect(client.closed).toBe(true);
    expect(connectCalls).toBe(0);
  });

  it("reports cancelled=false without throwing when no broker is reachable", async () => {
    const paths = await makeTempPaths();
    const service = new SetupService(baseDeps(paths, { connectExisting: async () => undefined }));

    await expect(service.cancelSignIn()).resolves.toEqual({ cancelled: false });
  });
});

describe("SetupService.ensureSignedIn cancellation", () => {
  it("tags the AUTH_FAILED from a browser.login that lost the race to a concurrent cancelSignIn()", async () => {
    const paths = await makeTempPaths();
    const cancelClient = makeFakeIpcClient({ "browser.cancelLogin": { cancelled: true } });
    // A plain `let` reassigned exactly once trips `prefer-const`; a mutable box sidesteps that
    // while still letting the `browser.login` answer below close over a service that does not
    // exist yet at the time this object literal is built.
    const box: { service?: SetupService } = {};
    const loginClient = makeFakeIpcClient({
      "browser.authState": { state: "sign-in-required" },
      // Simulates the broker rejecting the pending browser.login once it has honoured a concurrent
      // cancelLogin -- the cancel is awaited first so the flag is set before ensureSignedIn's catch
      // clause inspects it, mirroring real ordering (the rejection is a *consequence* of the cancel).
      "browser.login": async () => {
        await box.service!.cancelSignIn();
        throw new DomainError("AUTH_FAILED", "The sign-in window closed before completing.");
      }
    });
    box.service = new SetupService(
      baseDeps(paths, {
        connect: async () => loginClient as unknown as IpcClient,
        connectExisting: async () => cancelClient as unknown as IpcClient
      })
    );

    const error = await box.service.ensureSignedIn({ interactive: true }).catch((caught: unknown) => caught);

    expect(isSignInCancelledError(error)).toBe(true);
    expect(error).toMatchObject({ code: "AUTH_FAILED" });
    expect(cancelClient.calls.map((c) => c.method)).toEqual(["browser.cancelLogin"]);
  });

  it("leaves an ordinary AUTH_FAILED (no cancellation requested) unmarked", async () => {
    const paths = await makeTempPaths();
    const client = makeFakeIpcClient({
      "browser.authState": { state: "sign-in-required" },
      "browser.login": () => {
        throw new DomainError("AUTH_FAILED", "The sign-in window timed out.");
      }
    });
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient })
    );

    const error = await service.ensureSignedIn({ interactive: true }).catch((caught: unknown) => caught);

    expect(isSignInCancelledError(error)).toBe(false);
    expect(error).toMatchObject({ code: "AUTH_FAILED", message: "The sign-in window timed out." });
  });
});

describe("SetupService.removeAgent", () => {
  it("deletes a registry-only agent without touching any workspace file", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const agent = verifiedAgent("solo-agent", "https://m365.cloud.microsoft/chat/solo");
    await saveRegistry(paths, { version: 1, agents: [agent] });
    const service = new SetupService(baseDeps(paths, { root: () => root }));

    const status = await service.removeAgent("solo-agent");

    expect(status.registry).toHaveLength(0);
    expect((await loadRegistry(paths)).agents).toHaveLength(0);
  });

  it("drops the agent from .m365-agents.json and re-approves the remaining roster when it was assigned", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const kept = verifiedAgent("kept", "https://m365.cloud.microsoft/chat/kept");
    const removed = verifiedAgent("gone", "https://m365.cloud.microsoft/chat/gone");
    await saveRegistry(paths, { version: 1, agents: [kept, removed] });
    await writeFile(
      path.join(root, ".m365-agents.json"),
      JSON.stringify({
        version: 1,
        agents: [
          { alias: "kept", bindingFingerprint: kept.verification.bindingFingerprint },
          { alias: "gone", bindingFingerprint: removed.verification.bindingFingerprint }
        ]
      })
    );
    const service = new SetupService(baseDeps(paths, { root: () => root }));

    const status = await service.removeAgent("gone");

    const written = JSON.parse(await readFile(path.join(root, ".m365-agents.json"), "utf8"));
    expect(written.agents.map((a: { alias: string }) => a.alias)).toEqual(["kept"]);
    expect(status.registry.map((c) => c.registered?.alias).sort()).toEqual(["kept"]);
    const health = new HealthService({ paths, preparer: noopPreparer });
    const report = (await health.workspaceReport(root)) as {
      approvalStatus: string;
      assignments: Array<{ alias: string; status: string }>;
    };
    expect(report.approvalStatus).toBe("approved");
    expect(report.assignments.find((a) => a.alias === "kept")?.status).toBe("ready");
  });

  it("throws AGENT_NOT_FOUND for an alias that is not in the registry", async () => {
    const paths = await makeTempPaths();
    const service = new SetupService(baseDeps(paths));

    await expect(service.removeAgent("missing")).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});

describe("SetupService.revokeWorkspace", () => {
  it("removes the local approval but leaves .m365-agents.json in place", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const url = "https://m365.cloud.microsoft/chat/kept";
    const agent = verifiedAgent("kept", url);
    await saveRegistry(paths, { version: 1, agents: [agent] });
    const service = new SetupService(baseDeps(paths, { root: () => root }));
    await service.apply({ agents: [{ url, displayName: "Kept" }] }); // assigns and approves

    const status = await service.revokeWorkspace();

    expect(status.workspace.approvalStatus).toBe("approval-required");
    const stillExists = JSON.parse(await readFile(path.join(root, ".m365-agents.json"), "utf8"));
    expect(stillExists.agents.map((a: { alias: string }) => a.alias)).toEqual(["kept"]);
  });

  it("throws WORKSPACE_NOT_CONFIGURED when there is no .m365-agents.json to revoke", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const service = new SetupService(baseDeps(paths, { root: () => root }));

    await expect(service.revokeWorkspace()).rejects.toMatchObject({ code: "WORKSPACE_NOT_CONFIGURED" });
  });
});

describe("SetupService.updateAgentMetadata", () => {
  it("updates display metadata without touching the binding fingerprint", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const agent = verifiedAgent("agent-a", "https://m365.cloud.microsoft/chat/agent-a", {
      displayName: "Old Name"
    });
    await saveRegistry(paths, { version: 1, agents: [agent] });
    const service = new SetupService(baseDeps(paths, { root: () => root }));

    const status = await service.updateAgentMetadata("agent-a", {
      displayName: "New Name",
      description: "  updated  ",
      usageHint: "  use for X  "
    });

    const updated = (await loadRegistry(paths)).agents[0];
    expect(updated.displayName).toBe("New Name");
    expect(updated.description).toBe("updated");
    expect(updated.usageHint).toBe("use for X");
    expect(updated.verification.bindingFingerprint).toBe(agent.verification.bindingFingerprint);
    expect(status.registry[0].registered?.description).toBe("updated");
  });

  it("re-approves an assigned, already-approved agent when capabilityClass changes, widening allowedCapabilityClasses if needed", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const url = "https://m365.cloud.microsoft/chat/agent-a";
    const agent = verifiedAgent("agent-a", url, { displayName: "Agent A" });
    await saveRegistry(paths, { version: 1, agents: [agent] });
    const service = new SetupService(baseDeps(paths, { root: () => root }));
    await service.apply({ agents: [{ url, displayName: "Agent A" }] }); // assigns + approves knowledge-only

    const status = await service.updateAgentMetadata("agent-a", { capabilityClass: "actions-possible" });

    const config = await loadGlobalConfig(paths);
    expect(config.security.allowedCapabilityClasses).toContain("actions-possible");
    const health = new HealthService({ paths, preparer: noopPreparer });
    const report = (await health.workspaceReport(root)) as {
      approvalStatus: string;
      assignments: Array<{ alias: string; capabilityClass?: string }>;
    };
    expect(report.approvalStatus).toBe("approved");
    expect(report.assignments[0].capabilityClass).toBe("actions-possible");
    expect(status.registry[0].registered?.capabilityClass).toBe("actions-possible");
  });

  it("never grants approval to an agent that was assigned but never approved", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const agent = verifiedAgent("agent-a", "https://m365.cloud.microsoft/chat/agent-a");
    await saveRegistry(paths, { version: 1, agents: [agent] });
    await writeFile(
      path.join(root, ".m365-agents.json"),
      JSON.stringify({ version: 1, agents: [{ alias: "agent-a" }] })
    );
    const service = new SetupService(baseDeps(paths, { root: () => root }));

    await service.updateAgentMetadata("agent-a", { capabilityClass: "actions-possible" });

    const config = await loadGlobalConfig(paths);
    expect(config.security.allowedCapabilityClasses).toEqual(["knowledge-only"]);
    const health = new HealthService({ paths, preparer: noopPreparer });
    const report = (await health.workspaceReport(root)) as { approvalStatus: string };
    expect(report.approvalStatus).toBe("approval-required");
  });

  it("throws AGENT_NOT_FOUND for an unknown alias", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const service = new SetupService(baseDeps(paths, { root: () => root }));

    await expect(service.updateAgentMetadata("missing", { displayName: "x" })).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND"
    });
  });
});

describe("SetupService.discover suggestions and assignment status", () => {
  it("forwards a non-empty suggestedDownloadHosts from the broker, and omits it when empty", async () => {
    const paths = await makeTempPaths();
    const client = makeFakeIpcClient({
      "agent.discover": { agents: [], warnings: [], suggestedDownloadHosts: ["files.contoso.com"] }
    });
    const service = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient })
    );

    const result = await service.discover();

    expect(result.suggestedDownloadHosts).toEqual(["files.contoso.com"]);
  });

  it("reports the workspace report's per-alias status on an assigned, matched candidate", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const url = "https://m365.cloud.microsoft/chat/agent-a";
    const agent = verifiedAgent("agent-a", url, {
      verification: {
        status: "verified",
        adapterId: "agent-builder-chat@1",
        expectedDisplayName: "Agent A",
        expectedStableAgentId: "stable-a",
        expectedSurface: "m365-copilot",
        validatedUrlPattern: "^/chat/agent-a$",
        bindingFingerprint: `sha256:${"0".repeat(64)}`,
        validatedAt: "2026-09-01T00:00:00.000Z"
      }
    });
    await saveRegistry(paths, { version: 1, agents: [agent] });
    const applyService = new SetupService(baseDeps(paths, { root: () => root }));
    await applyService.apply({ agents: [{ url, displayName: "Agent A" }] });
    const client = makeFakeIpcClient({
      "agent.discover": {
        agents: [
          {
            url,
            surface: "m365-copilot",
            displayName: "Agent A",
            stableAgentId: "stable-a",
            source: "sidebar"
          }
        ],
        warnings: []
      }
    });
    const discoverService = new SetupService(
      baseDeps(paths, { connect: async () => client as unknown as IpcClient, root: () => root })
    );

    const { candidates } = await discoverService.discover();

    const found = candidates.find((c) => c.stableAgentId === "stable-a");
    expect(found?.assigned).toBe(true);
    expect(found?.assignmentStatus).toBe("ready");
  });
});

describe("SetupService.updateConfig attachment fields", () => {
  it("passes attachmentRetentionHours/attachmentQuotaBytes through when the patch provides them", async () => {
    const paths = await makeTempPaths();
    const service = new SetupService(baseDeps(paths));
    expect((await loadGlobalConfig(paths)).security.attachmentRetentionHours).toBe(168);

    const result = await service.updateConfig({
      attachmentRetentionHours: 48,
      attachmentQuotaBytes: 2 * 1024 * 1024 * 1024
    });

    // security.* other than allowedCapabilityClasses is not broker-scoped (see
    // computeBrokerScopedConfigChanges's doc comment), so this never asks for a restart.
    expect(result.restartRequired).toBe(false);
    const saved = await loadGlobalConfig(paths);
    expect(saved.security.attachmentRetentionHours).toBe(48);
    expect(saved.security.attachmentQuotaBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  it("leaves attachment fields at their existing value when the patch omits them", async () => {
    const paths = await makeTempPaths();
    const service = new SetupService(baseDeps(paths));

    await service.updateConfig({ headless: false });

    const saved = await loadGlobalConfig(paths);
    expect(saved.security.attachmentRetentionHours).toBe(168);
    expect(saved.security.attachmentQuotaBytes).toBe(1024 * 1024 * 1024);
  });
});

describe("SetupService.ensureBrowserChannel", () => {
  const detection = (channel: string, installed: string[]) => async (configured: string) => ({
    channel: configured,
    installed: installed.includes(configured),
    alternatives: ["msedge", "chrome", "chromium"]
      .filter((item) => item !== configured)
      .map((item) => ({ channel: item, installed: installed.includes(item) }))
  });

  it("keeps an installed channel untouched", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const service = new SetupService(
      baseDeps(paths, { root: () => root, detectBrowser: detection("msedge", ["msedge", "chrome"]) })
    );
    await expect(service.ensureBrowserChannel()).resolves.toEqual({
      changed: false,
      channel: "msedge",
      restartRequired: false
    });
  });

  it("switches to the first installed alternative and saves it when the configured browser is missing", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const service = new SetupService(
      baseDeps(paths, { root: () => root, detectBrowser: detection("msedge", ["chrome"]) })
    );
    await expect(service.ensureBrowserChannel()).resolves.toEqual({
      changed: true,
      channel: "chrome",
      previous: "msedge",
      restartRequired: true
    });
    expect(await readFile(paths.config, "utf8")).toMatch(/channel: chrome/);
  });

  it("fails with BROWSER_START_FAILED and an install remediation when nothing is installed", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot();
    const service = new SetupService(
      baseDeps(paths, { root: () => root, detectBrowser: detection("msedge", []) })
    );
    await expect(service.ensureBrowserChannel()).rejects.toMatchObject({
      code: "BROWSER_START_FAILED",
      options: { remediation: expect.stringContaining("Install Microsoft Edge") }
    });
  });
});
