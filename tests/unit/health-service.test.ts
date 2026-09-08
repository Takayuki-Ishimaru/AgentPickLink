import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeLocalState } from "../../src/config/init.js";
import { defaultGlobalConfig, saveGlobalConfig } from "../../src/config/global-config.js";
import { appPaths } from "../../src/config/paths.js";
import { saveRegistry } from "../../src/config/registry.js";
import { deriveBindingFingerprint, type BrowserAgentDefinition } from "../../src/domain/agent.js";
import { WorkspaceConfigSchema } from "../../src/domain/workspace.js";
import { BROKER_PROTOCOL } from "../../src/ipc/protocol.js";
import { HealthService } from "../../src/services/health-service.js";
import { TransportRouter } from "../../src/transports/transport-router.js";
import type {
  InteractiveAgentTransport,
  LocalStatePreparer,
  TransportConversation,
  TransportHealth
} from "../../src/transports/transport.js";

/** Stands in for BrowserTransport's profile ownership without touching a browser profile. */
const fakePreparer: LocalStatePreparer & { verifications: string[] } = {
  verifications: [],
  async prepareLocalState(profilePath: string) {
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await chmod(profilePath, 0o700);
  },
  async verifyLocalState(profilePath: string) {
    fakePreparer.verifications.push(profilePath);
    return { owned: true };
  }
};

class FakeTransport implements InteractiveAgentTransport {
  readonly name = "fake";
  invokes = 0;
  creates = 0;
  healthChecks = 0;
  health: TransportHealth = { healthy: true, details: "fake" };
  async healthCheck(): Promise<TransportHealth> {
    this.healthChecks++;
    return this.health;
  }
  async validateAgent() {
    return { valid: true };
  }
  async createConversation(): Promise<TransportConversation> {
    this.creates++;
    return { transportId: "browser", opaque: "page" };
  }
  async invoke(): Promise<never> {
    this.invokes++;
    throw new Error("a health check must never invoke an agent");
  }
  async closeConversation() {}
  async dispose() {}
  isBrowserRunning = () => true;
}

const template: BrowserAgentDefinition = {
  alias: "requirements",
  displayName: "Requirements Agent",
  kind: "m365-agent-builder",
  transport: "browser",
  entryPoint: {
    mode: "direct-chat",
    url: "https://m365.example.test/chat/requirements",
    surface: "m365-copilot"
  },
  enabled: true,
  capabilityClass: "knowledge-only",
  uiActionPolicy: "never-click",
  verification: {
    status: "verified",
    adapterId: "m365-copilot-chat@1",
    expectedDisplayName: "Requirements Agent",
    expectedSurface: "m365-copilot",
    validatedUrlPattern: "^/chat/requirements$",
    bindingFingerprint: `sha256:${"a".repeat(64)}`,
    validatedAt: "2026-09-01T00:00:00.000Z"
  }
};
const agent: BrowserAgentDefinition = {
  ...template,
  verification: { ...template.verification, bindingFingerprint: deriveBindingFingerprint(template) }
};

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "apl-health-"));
  const paths = await initializeLocalState(appPaths(path.join(base, "appdata")), fakePreparer);
  const workspaceRoot = path.join(base, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    path.join(workspaceRoot, ".m365-agents.json"),
    JSON.stringify(WorkspaceConfigSchema.parse({ version: 1, agents: [{ alias: agent.alias }] }))
  );
  await saveRegistry(paths, { version: 1, agents: [agent] });
  const transport = new FakeTransport();
  const router = new TransportRouter().register("browser", transport);
  return { base, paths, workspaceRoot, transport, router };
}

describe("HealthService", () => {
  it("reports every local prerequisite check without touching an agent", async () => {
    const { paths, workspaceRoot, transport } = await fixture();
    const health = new HealthService({ paths, preparer: fakePreparer });
    const { topologyReady, checks } = await health.localReport(workspaceRoot);
    expect(Object.keys(checks)).toEqual([
      "topology",
      "node",
      "edge",
      "browser",
      "appData",
      "globalConfig",
      "profile",
      "registry",
      "approvals",
      "workspace"
    ]);
    expect(topologyReady).toBe(process.platform === "win32" || process.platform === "darwin");
    expect(checks.topology).toMatchObject(
      process.platform === "darwin"
        ? {
            supported: true,
            note: "macOS is supported for development and verification; Windows 11 is the production target."
          }
        : { supported: process.platform === "win32" }
    );
    expect(checks.node).toMatchObject({
      version: process.versions.node,
      supported: true,
      recommendedMajor: 24
    });
    // msedge detection is a real filesystem check (see HealthService.browser); assert shape and
    // internal consistency rather than a hardcoded boolean, since it depends on what is actually
    // installed on the machine running the test.
    const expectedEdgeInstalled = (await health.browser("msedge")).installed;
    expect(checks.edge).toMatchObject({ installed: expectedEdgeInstalled });
    expect(checks.browser).toMatchObject({
      channel: "msedge",
      installed: expectedEdgeInstalled,
      alternatives: [
        { channel: "chrome", installed: expect.any(Boolean) },
        { channel: "chromium", installed: expect.any(Boolean) }
      ]
    });
    expect(checks.appData).toEqual({ protected: true, writable: true });
    expect(checks.globalConfig).toEqual({ valid: true });
    expect(checks.profile).toEqual({ safe: true, owned: true, writable: true });
    expect(checks.registry).toEqual({ valid: true, protected: true, count: 1 });
    expect(checks.approvals).toEqual({ valid: true, protected: true });
    expect(checks.workspace).toMatchObject({
      approvalStatus: "approval-required",
      assignments: [
        { alias: agent.alias, status: "approval-required", name: agent.displayName, locallyBound: true }
      ]
    });
    expect(fakePreparer.verifications.at(-1)).toBe(paths.profile);
    expect(transport.invokes).toBe(0);
    expect(transport.creates).toBe(0);
  });

  it("maps a failed check through the caller's failure shape instead of throwing", async () => {
    const { base, workspaceRoot } = await fixture();
    const missing = appPaths(path.join(base, "not-initialized"));
    const health = new HealthService({
      paths: missing,
      preparer: fakePreparer,
      toFailure: (value) => ({ failed: value instanceof Error ? value.message : String(value) })
    });
    const { checks } = await health.localReport(workspaceRoot);
    expect(checks.appData).toMatchObject({ failed: expect.stringContaining("Run m365-agent init") });
    expect(checks.globalConfig).toMatchObject({ failed: expect.any(String) });
    expect(checks.profile).toMatchObject({ safe: false, error: { failed: expect.any(String) } });
    expect(checks.registry).toMatchObject({ failed: expect.any(String) });
  });

  it("answers broker.health from the registered transport without invoking it", async () => {
    const { paths, router, transport } = await fixture();
    const health = new HealthService({
      paths,
      preparer: fakePreparer,
      router,
      instanceId: "broker_health_test"
    });
    await expect(health.broker()).resolves.toEqual({
      instanceId: "broker_health_test",
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      browserStarted: true,
      transport: { healthy: true, details: "fake" },
      // Always reported, so a panel never has to read "absent" as "production".
      devMode: { insecureLoopback: false, devAppUrl: false }
    });
    expect(transport.healthChecks).toBe(1);
    expect(transport.invokes).toBe(0);
  });

  it("surfaces the transport's development flags and browser description in broker.health", async () => {
    const { paths, router, transport } = await fixture();
    transport.health = {
      healthy: true,
      details: "fake",
      devMode: { insecureLoopback: true, devAppUrl: true },
      browser: { channel: "chrome", headless: true, viewport: { width: 1440, height: 900 } }
    };
    const health = new HealthService({ paths, router, instanceId: "broker_devmode_test" });
    await expect(health.broker()).resolves.toMatchObject({
      devMode: { insecureLoopback: true, devAppUrl: true },
      browser: { channel: "chrome", headless: true, viewport: { width: 1440, height: 900 } }
    });
  });

  it("reports an absent broker descriptor as neither present nor stale", async () => {
    const { paths } = await fixture();
    const health = new HealthService({ paths, preparer: fakePreparer });
    await expect(health.descriptorState()).resolves.toEqual({
      descriptorPresent: false,
      staleDescriptor: false
    });
    await expect(health.broker()).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
  });
});

describe("HealthService.browser (docs/ux-redesign.md §2.2 item 3)", () => {
  it("reports the requested channel plus every other channel as an alternative", async () => {
    const { paths } = await fixture();
    const health = new HealthService({ paths, preparer: fakePreparer });
    const chrome = await health.browser("chrome");
    expect(chrome.channel).toBe("chrome");
    expect(chrome.alternatives.map((entry) => entry.channel).sort()).toEqual(["chromium", "msedge"]);
    expect(chrome.alternatives.every((entry) => typeof entry.installed === "boolean")).toBe(true);
  });

  it("detects the chromium channel from PLAYWRIGHT_BROWSERS_PATH rather than a fixed install path", async () => {
    const { paths } = await fixture();
    const health = new HealthService({ paths, preparer: fakePreparer });
    const cache = await mkdtemp(path.join(os.tmpdir(), "apl-playwright-cache-"));
    await mkdir(path.join(cache, "chromium-1234"), { recursive: true });
    const original = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    try {
      await expect(health.browser("chromium")).resolves.toMatchObject({
        channel: "chromium",
        installed: true
      });
    } finally {
      if (original === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = original;
    }
  });

  it("reports chromium as not installed when the cache directory has no chromium* entry", async () => {
    const { paths } = await fixture();
    const health = new HealthService({ paths, preparer: fakePreparer });
    const cache = await mkdtemp(path.join(os.tmpdir(), "apl-playwright-empty-"));
    const original = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    try {
      await expect(health.browser("chromium")).resolves.toMatchObject({ installed: false });
    } finally {
      if (original === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = original;
    }
  });

  it("localReport's browser check uses the configured channel once a global config exists", async () => {
    const { paths, workspaceRoot } = await fixture();
    const base = defaultGlobalConfig(paths.profile);
    await saveGlobalConfig(paths, { ...base, browser: { ...base.browser, channel: "chrome" } });
    const health = new HealthService({ paths, preparer: fakePreparer });
    const { checks } = await health.localReport(workspaceRoot);
    expect(checks.browser).toMatchObject({ channel: "chrome" });
  });
});
