import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

const { connectExistingBrokerMock, connectOrStartBrokerMock } = vi.hoisted(() => ({
  connectExistingBrokerMock: vi.fn(),
  connectOrStartBrokerMock: vi.fn()
}));
vi.mock("../../src/broker/broker-lifecycle.js", () => ({
  connectExistingBroker: connectExistingBrokerMock,
  connectOrStartBroker: connectOrStartBrokerMock
}));

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
    const runtime = {
      paths,
      brokerEntry: () => entry,
      log: (message: string) => logs.push(message)
    } as unknown as ExtensionRuntime;
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
      pid: process.pid,
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
    const runtime = {
      paths,
      brokerEntry: () => entry,
      log: (message: string) => logs.push(message)
    } as unknown as ExtensionRuntime;
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
      pid: process.pid,
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
    const runtime = { paths, brokerEntry: () => entry, log: vi.fn() } as unknown as ExtensionRuntime;
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
      pid: process.pid,
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
    const runtime = { paths, brokerEntry: () => entry, log: vi.fn() } as unknown as ExtensionRuntime;
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
      pid: process.pid,
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
    const runtime = { paths, brokerEntry: () => entry, log: vi.fn() } as unknown as ExtensionRuntime;
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
      pid: process.pid,
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
    const runtime = { paths, brokerEntry: () => entry, log: vi.fn() } as unknown as ExtensionRuntime;
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
