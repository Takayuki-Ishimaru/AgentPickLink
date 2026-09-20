import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { writeDescriptor } from "../../src/broker/broker-descriptor.js";
import { appPaths } from "../../src/config/paths.js";
import { defaultGlobalConfig, saveGlobalConfig } from "../../src/config/global-config.js";
import {
  isStaleBrokerBrowserConfiguration,
  isStaleBrokerBuild,
  restartBrokerIfStale
} from "../../src/extension/broker.js";
import type { ExtensionRuntime } from "../../src/extension/runtime.js";
import { writeInstallJson, type InstallJson } from "../../src/services/install-home.js";
import { createRuntimeHarness, logText, type RuntimeHarness } from "./harness.js";
import { resetVscodeMock } from "./vscode-mock.js";

const { connectExistingBrokerMock, connectOrStartBrokerMock } = vi.hoisted(() => ({
  connectExistingBrokerMock: vi.fn(),
  connectOrStartBrokerMock: vi.fn()
}));
vi.mock("../../src/broker/broker-lifecycle.js", () => ({
  connectExistingBroker: connectExistingBrokerMock,
  connectOrStartBroker: connectOrStartBrokerMock,
  // Every scenario below removes the descriptor synchronously inside its `broker.shutdown` mock, so
  // ISSUE-06's post-shutdown wait (`waitForBrokerFullyReleased`) always finds it already gone.
  waitForDescriptorGone: vi.fn().mockResolvedValue(true)
}));
// ISSUE-2026-09-14-13: every "restarts a ..." scenario below reaches `waitForBrokerFullyReleased`'s
// browser-tree phase (its pid and lock conditions clear immediately with DEAD_PID and no profile
// directory ever created), which calls `ensureProfileBrowsersGone`. Unlike
// tests/services/broker-staleness.test.ts, this suite goes through the extension's own
// `restartBrokerIfStale(runtime)` adapter (src/extension/broker.ts), which has no `releaseWait` to
// inject a fake `exec` through -- mocked out here instead so this suite never shells out for a real
// process listing.
vi.mock("../../src/broker/profile-processes.js", () => ({
  ensureProfileBrowsersGone: vi.fn().mockResolvedValue(undefined)
}));

/** ISSUE-06: every descriptor below that reaches a restart uses this in place of `process.pid`, so
 * `isBrokerPidAlive` (in src/services/broker-staleness.ts) sees it as already gone on the very
 * first check -- with a real, currently-running `process.pid` the new post-shutdown wait would
 * otherwise block for its full default 15s. These tests only cover the staleness *decision*; the
 * wait's own bound/poll/timeout behaviour is covered separately in
 * tests/services/broker-staleness.test.ts. */
const DEAD_PID = 999_999;

/** The slice of `ExtensionRuntime` the `restartBrokerIfStale` adapter actually uses. `machineInstall()`
 * answers "no machine install", which is what keeps these cases on the pre-§4.7-C13 mtime
 * heuristic they were written for; the install.json-driven cases live in their own describe below,
 * against a real `ExtensionRuntime`. */
function fakeRuntime(
  paths: ReturnType<typeof appPaths>,
  entry: string,
  log: (message: string) => void = vi.fn()
): ExtensionRuntime {
  return {
    paths,
    brokerEntry: () => entry,
    machineInstall: async () => undefined,
    log
  } as unknown as ExtensionRuntime;
}

describe("stale broker detection", () => {
  it("flags a broker whose entry file path or mtime differs from the installed build", () => {
    const current = { entry: "/ext/0.2.0/dist/broker/process.js", mtimeMs: 2000 };
    expect(isStaleBrokerBuild(undefined, current)).toBe(false);
    expect(isStaleBrokerBuild({ ...current }, current)).toBe(false);
    expect(isStaleBrokerBuild({ entry: "/ext/0.1.0/dist/broker/process.js", mtimeMs: 2000 }, current)).toBe(
      true
    );
    expect(isStaleBrokerBuild({ entry: current.entry, mtimeMs: 1000 }, current)).toBe(true);
    expect(isStaleBrokerBuild({ entry: current.entry, mtimeMs: 2000.4 }, current)).toBe(false);
  });

  it("flags a running browser whose channel or headless mode differs from saved config", () => {
    const configured = { channel: "msedge", headless: true };
    expect(isStaleBrokerBrowserConfiguration(configured, undefined)).toBe(false);
    expect(isStaleBrokerBrowserConfiguration(configured, { ...configured })).toBe(false);
    expect(isStaleBrokerBrowserConfiguration(configured, { channel: "chrome", headless: true })).toBe(true);
    expect(isStaleBrokerBrowserConfiguration(configured, { channel: "msedge", headless: false })).toBe(true);
  });

  it("does nothing without a descriptor or without build information", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-stale-"));
    const paths = appPaths(base);
    const entry = path.join(base, "process.js");
    await writeFile(entry, "// broker");
    const logs: string[] = [];
    const runtime = fakeRuntime(paths, entry, (message) => logs.push(message));
    await expect(restartBrokerIfStale(runtime)).resolves.toBe(false);
    expect(logs).toEqual([]);
  });

  it("restarts a metadata-less broker when the one-time legacy migration is pending", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-stale-"));
    const paths = appPaths(base);
    const entry = path.join(base, "process.js");
    await writeFile(entry, "// broker");
    await writeFile(
      paths.config,
      YAML.stringify({ version: 1, browser: { profilePath: path.join(base, "profile"), headless: false } })
    );
    await writeDescriptor(paths, {
      pid: DEAD_PID,
      pipeName: path.join(base, "broker.sock"),
      protocolMajor: 1,
      protocolMinor: 1,
      packageVersion: "0.1.0",
      instanceId: "legacy-broker",
      authSecret: "test-secret"
    });
    const call = vi.fn(async (method: string) => {
      if (method === "broker.health") return {};
      await rm(paths.descriptor, { force: true });
      return {};
    });
    const close = vi.fn();
    connectExistingBrokerMock.mockResolvedValue({ call, close });
    const logs: string[] = [];
    const runtime = fakeRuntime(paths, entry, (message) => logs.push(message));
    try {
      await expect(restartBrokerIfStale(runtime)).resolves.toBe(true);
      expect(call).toHaveBeenNthCalledWith(1, "broker.health", {}, undefined, expect.any(AbortSignal));
      expect(call).toHaveBeenNthCalledWith(2, "broker.shutdown", {});
      expect(close).toHaveBeenCalledOnce();
      expect(logs).toContain(
        "broker: the running broker configuration differs from saved settings; restarting it"
      );
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  it("keeps an older broker when health metadata is unavailable", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-stale-"));
    const paths = appPaths(base);
    const entry = path.join(base, "process.js");
    await writeFile(entry, "// broker");
    await saveGlobalConfig(paths, defaultGlobalConfig(path.join(base, "profile")));
    await writeDescriptor(paths, {
      pid: DEAD_PID,
      pipeName: path.join(base, "broker.sock"),
      protocolMajor: 1,
      protocolMinor: 0,
      packageVersion: "0.1.0",
      instanceId: "unknown-broker",
      authSecret: "test-secret"
    });
    const call = vi.fn().mockResolvedValue({});
    const close = vi.fn();
    connectExistingBrokerMock.mockResolvedValue({ call, close });
    const runtime = fakeRuntime(paths, entry);
    try {
      await expect(restartBrokerIfStale(runtime)).resolves.toBe(false);
      expect(call).toHaveBeenCalledWith("broker.health", {}, undefined, expect.any(AbortSignal));
      expect(call).not.toHaveBeenCalledWith("broker.shutdown", {});
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  it("restarts a migrated broker when its health still reports visible mode", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-stale-"));
    const paths = appPaths(base);
    const entry = path.join(base, "process.js");
    await writeFile(entry, "// broker");
    await saveGlobalConfig(paths, defaultGlobalConfig(path.join(base, "profile")));
    await writeDescriptor(paths, {
      pid: DEAD_PID,
      pipeName: path.join(base, "broker.sock"),
      protocolMajor: 1,
      protocolMinor: 1,
      packageVersion: "0.1.0",
      instanceId: "migrated-visible-broker",
      authSecret: "test-secret"
    });
    const call = vi.fn(async (method: string) => {
      if (method === "broker.health") return { browser: { channel: "msedge", headless: false } };
      await rm(paths.descriptor, { force: true });
      return {};
    });
    const close = vi.fn();
    connectExistingBrokerMock.mockResolvedValue({ call, close });
    const runtime = fakeRuntime(paths, entry);
    try {
      await expect(restartBrokerIfStale(runtime)).resolves.toBe(true);
      expect(call).toHaveBeenNthCalledWith(1, "broker.health", {}, undefined, expect.any(AbortSignal));
      expect(call).toHaveBeenNthCalledWith(2, "broker.shutdown", {});
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  it("restarts a legacy visible broker even after the migration marker", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-stale-"));
    const paths = appPaths(base);
    const entry = path.join(base, "process.js");
    await writeFile(entry, "// broker");
    const config = defaultGlobalConfig(path.join(base, "profile"));
    await saveGlobalConfig(paths, { ...config, browser: { ...config.browser, headless: false } });
    await writeDescriptor(paths, {
      pid: DEAD_PID,
      pipeName: path.join(base, "broker.sock"),
      protocolMajor: 1,
      protocolMinor: 1,
      packageVersion: "0.1.0",
      instanceId: "explicit-visible-broker",
      authSecret: "test-secret"
    });
    const call = vi.fn(async (method: string) => {
      if (method === "broker.shutdown") await rm(paths.descriptor, { force: true });
      return { browser: { channel: "msedge", headless: false } };
    });
    const close = vi.fn();
    connectExistingBrokerMock.mockResolvedValue({ call, close });
    const runtime = fakeRuntime(paths, entry);
    try {
      await expect(restartBrokerIfStale(runtime)).resolves.toBe(true);
      expect(call).toHaveBeenNthCalledWith(1, "broker.health", {}, undefined, expect.any(AbortSignal));
      expect(call).toHaveBeenCalledWith("broker.shutdown", {});
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  it("does not wait for health when the descriptor build is already stale", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-stale-"));
    const paths = appPaths(base);
    const entry = path.join(base, "process.js");
    await writeFile(entry, "// broker");
    await saveGlobalConfig(paths, defaultGlobalConfig(path.join(base, "profile")));
    await writeDescriptor(paths, {
      pid: DEAD_PID,
      pipeName: path.join(base, "broker.sock"),
      protocolMajor: 1,
      protocolMinor: 1,
      packageVersion: "0.1.0",
      instanceId: "stale-build-broker",
      authSecret: "test-secret",
      build: { entry: "/old-extension/dist/broker/process.js", mtimeMs: 1 }
    });
    const call = vi.fn(async (method: string) => {
      if (method === "broker.health") throw new Error("health should not be requested");
      await rm(paths.descriptor, { force: true });
      return {};
    });
    const close = vi.fn();
    connectExistingBrokerMock.mockResolvedValue({ call, close });
    const runtime = fakeRuntime(paths, entry);
    try {
      await expect(restartBrokerIfStale(runtime)).resolves.toBe(true);
      expect(call).toHaveBeenCalledWith("broker.shutdown", {});
      expect(call).not.toHaveBeenCalledWith("broker.health", expect.anything());
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });
});

/**
 * §4.7 C13 as clarified on 2026-09-13: when `install.json` exists, the extension follows it for the
 * broker *regardless of which entry point is newer*, and judges the running broker by the version
 * `install.json` records -- never by its own `dist/broker/process.js`. Without both halves, a
 * machine install's perfectly current broker is stale to the extension on every activation (its
 * `build.entry` is a file this VSIX never wrote) and the archive and the VSIX restart each other's
 * broker forever.
 */
describe("the extension's broker decision with a machine install (§4.7 C13)", () => {
  let harness: RuntimeHarness;

  afterEach(async () => {
    connectExistingBrokerMock.mockReset();
    await harness.dispose();
  });

  function installJson(overrides: Partial<InstallJson> = {}): InstallJson {
    return {
      version: "9.9.9",
      installedBy: "archive",
      runtime: { path: "/machine/bin/node", source: "bundled", nodeVersion: "22.14.0" },
      identity: { command: "/machine/bin/node", args: ["/machine/bin/apl.js", "serve"] },
      clients: ["vscode"],
      workspaces: [],
      platform: process.platform,
      updatedAt: "2026-09-13T00:00:00.000Z",
      ...overrides
    };
  }

  /** A live broker of `version`, whose `build` names a file this machine does not have -- the shape
   * a broker spawned from `<home>/app/<version>` always has as far as the extension is concerned. */
  async function seedLiveBroker(version: string): Promise<{ call: ReturnType<typeof vi.fn> }> {
    const paths = harness.runtime.paths;
    const config = defaultGlobalConfig(path.join(harness.home, "profile"));
    await saveGlobalConfig(paths, config);
    await writeDescriptor(paths, {
      pid: DEAD_PID,
      pipeName: path.join(harness.home, "broker.sock"),
      protocolMajor: 1,
      protocolMinor: 3,
      packageVersion: version,
      instanceId: "machine-install-broker",
      authSecret: "test-secret",
      build: { entry: "/machine/app/dist/broker/process.js", mtimeMs: 1234 }
    });
    const call = vi.fn(async (method: string) => {
      if (method === "broker.health") return { browser: { channel: config.browser.channel, headless: true } };
      await rm(paths.descriptor, { force: true });
      return {};
    });
    connectExistingBrokerMock.mockResolvedValue({ call, close: vi.fn() });
    return { call };
  }

  it("leaves the machine install's own broker alone when its version matches install.json", async () => {
    resetVscodeMock();
    harness = await createRuntimeHarness();
    await writeInstallJson(harness.installHome, installJson({ version: "9.9.9" }));
    const { call } = await seedLiveBroker("9.9.9");

    await expect(restartBrokerIfStale(harness.runtime)).resolves.toBe(false);

    expect(call).not.toHaveBeenCalledWith("broker.shutdown", {});
    expect(harness.runtime.brokerEntry()).toBe(
      path.join(harness.installHome, "app", "9.9.9", "dist", "broker", "process.js")
    );
  });

  it("still leaves it alone when this extension is newer than the machine install, and says so once", async () => {
    resetVscodeMock();
    harness = await createRuntimeHarness(); // the harness extension version is "0.1.0"
    await writeInstallJson(harness.installHome, installJson({ version: "0.0.1" }));
    const { call } = await seedLiveBroker("0.0.1");

    await expect(restartBrokerIfStale(harness.runtime)).resolves.toBe(false);

    expect(call).not.toHaveBeenCalledWith("broker.shutdown", {});
    // C13: the broker follows install.json even though C4 keeps `cliEntry()` on the newer VSIX.
    expect(harness.runtime.brokerEntry()).toBe(
      path.join(harness.installHome, "app", "0.0.1", "dist", "broker", "process.js")
    );
    expect(harness.runtime.cliEntry()).toBe(path.join(harness.extensionRoot, "dist", "cli", "index.js"));
    expect(logText()).toContain("machine install 0.0.1 is older than the extension 0.1.0");
  });

  it("restarts a broker whose version is not the one install.json records", async () => {
    resetVscodeMock();
    harness = await createRuntimeHarness();
    await writeInstallJson(harness.installHome, installJson({ version: "9.9.9" }));
    const { call } = await seedLiveBroker("9.9.8"); // left over from the previous machine install

    await expect(restartBrokerIfStale(harness.runtime)).resolves.toBe(true);

    expect(call).toHaveBeenCalledWith("broker.shutdown", {});
  });
});
