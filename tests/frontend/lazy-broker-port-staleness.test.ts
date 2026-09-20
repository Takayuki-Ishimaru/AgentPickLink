/**
 * §4.7 C13's staleness guard as wired into `LazyBrokerPort` (docs/extension-less-onboarding.md
 * §4.2, "the moved `restartBrokerIfStale` is therefore called from `install` and from `serve`'s
 * first broker connect (`LazyBrokerPort`)"). Two things are covered here:
 *
 * - `LazyBrokerPort` itself: `checkStaleness` runs exactly once, before the very first real
 *   connect, never blocks that connect even when it rejects, and never re-runs on a later
 *   reconnect (idle shutdown/restart) -- using an injected fake, no real filesystem/broker I/O.
 * - `defaultBrokerStalenessCheck` (what `serve` actually gets when it does not override
 *   `checkStaleness`): resolves the machine install's broker entry + expected version from
 *   `install.json` when one exists, else this tree's own broker entry with no `expected`, and logs
 *   through stderr only -- never stdout, which is the MCP JSON-RPC stream.
 */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LazyBrokerPort } from "../../src/frontend/lazy-broker-port.js";
import type { FrontendBrokerPort } from "../../src/frontend/broker-port.js";

describe("LazyBrokerPort's checkStaleness hook", () => {
  it("runs exactly once, before the first real connect, and does not block it when it rejects", async () => {
    const checkStaleness = vi.fn().mockRejectedValue(new Error("probe failed"));
    const backing: FrontendBrokerPort = {
      list: vi.fn(async (_root, requestId) => ({ ok: true, requestId }))
    };
    const factory = vi.fn().mockResolvedValue(backing);
    const port = new LazyBrokerPort(factory, checkStaleness);

    const first = await port.list("/repo", "req-1");

    expect(checkStaleness).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ ok: true, requestId: "req-1" });
    expect(factory).toHaveBeenCalledTimes(1);

    await port.list("/repo", "req-2");
    expect(checkStaleness).toHaveBeenCalledTimes(1); // memoised connection: no second call at all
  });

  it("does not re-run checkStaleness on a reconnect after the broker goes idle", async () => {
    const checkStaleness = vi.fn().mockResolvedValue(undefined);
    let live = true;
    const first = { list: vi.fn(async () => ({ ok: true })), isConnected: () => live };
    const second = { list: vi.fn(async () => ({ ok: true })), isConnected: () => true };
    const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const port = new LazyBrokerPort(factory, checkStaleness);

    await port.list("/repo", "req-1");
    live = false; // the memoised port now reports disconnected
    await port.list("/repo", "req-2");

    expect(factory).toHaveBeenCalledTimes(2);
    expect(checkStaleness).toHaveBeenCalledTimes(1);
  });

  it("runs before the factory even when the factory never settles", async () => {
    const order: string[] = [];
    const checkStaleness = vi.fn(async () => {
      order.push("staleness");
    });
    let resolveFactory!: (port: FrontendBrokerPort) => void;
    const factory = vi.fn(
      () =>
        new Promise<FrontendBrokerPort>((resolve) => {
          order.push("factory-called");
          resolveFactory = resolve;
        })
    );
    const port = new LazyBrokerPort(factory, checkStaleness);

    const pending = port.list("/repo", "req-1");
    // Flush every pending microtask hop before the factory is actually invoked (checkStaleness's
    // own await runs first).
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveFactory({ list: vi.fn(async () => ({ ok: true })) });
    await pending;

    expect(order).toEqual(["staleness", "factory-called"]);
  });
});

describe("defaultBrokerStalenessCheck", () => {
  it("uses the machine install's broker entry and expected version when install.json exists, and never writes to stdout", async () => {
    vi.resetModules();
    const restartBrokerIfStale = vi.fn().mockResolvedValue(false);
    vi.doMock("../../src/services/broker-staleness.js", () => ({
      restartBrokerIfStale,
      stalenessExpectationFrom: (installJson?: { version: string }) =>
        installJson ? { packageVersion: installJson.version } : undefined
    }));
    vi.doMock("../../src/config/paths.js", () => ({
      appPaths: () => ({ descriptor: "/fake/descriptor.json" })
    }));
    vi.doMock("../../src/services/install-home.js", () => ({
      resolveInstallHome: () => "/fake/home",
      readInstallJson: async () => ({
        version: "9.9.9",
        identity: { command: "/fake/home/bin/node", args: ["/fake/home/bin/apl.js", "serve"] }
      })
    }));
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { defaultBrokerStalenessCheck } = await import("../../src/frontend/lazy-broker-port.js");
      await defaultBrokerStalenessCheck();

      expect(restartBrokerIfStale).toHaveBeenCalledTimes(1);
      const call = restartBrokerIfStale.mock.calls[0][0];
      expect(call.brokerEntry).toContain(path.join("app", "9.9.9", "dist", "broker", "process.js"));
      expect(call.expected).toEqual({ packageVersion: "9.9.9" });
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      vi.doUnmock("../../src/services/broker-staleness.js");
      vi.doUnmock("../../src/config/paths.js");
      vi.doUnmock("../../src/services/install-home.js");
      vi.resetModules();
    }
  });

  it("falls back to this tree's own broker entry with no expected version when there is no install.json", async () => {
    vi.resetModules();
    const restartBrokerIfStale = vi.fn().mockResolvedValue(false);
    vi.doMock("../../src/services/broker-staleness.js", () => ({
      restartBrokerIfStale,
      stalenessExpectationFrom: (installJson?: { version: string }) =>
        installJson ? { packageVersion: installJson.version } : undefined
    }));
    vi.doMock("../../src/config/paths.js", () => ({
      appPaths: () => ({ descriptor: "/fake/descriptor.json" })
    }));
    vi.doMock("../../src/services/install-home.js", () => ({
      resolveInstallHome: () => "/fake/home",
      readInstallJson: async () => undefined
    }));
    try {
      const { defaultBrokerStalenessCheck } = await import("../../src/frontend/lazy-broker-port.js");
      await defaultBrokerStalenessCheck();

      expect(restartBrokerIfStale).toHaveBeenCalledTimes(1);
      const call = restartBrokerIfStale.mock.calls[0][0];
      expect(call.brokerEntry).toContain(path.join("broker", "process.js"));
      expect(call.expected).toBeUndefined();
    } finally {
      vi.doUnmock("../../src/services/broker-staleness.js");
      vi.doUnmock("../../src/config/paths.js");
      vi.doUnmock("../../src/services/install-home.js");
      vi.resetModules();
    }
  });

  it("never throws even when restartBrokerIfStale itself throws", async () => {
    vi.resetModules();
    vi.doMock("../../src/services/broker-staleness.js", () => ({
      restartBrokerIfStale: vi.fn().mockRejectedValue(new Error("boom")),
      stalenessExpectationFrom: () => undefined
    }));
    vi.doMock("../../src/config/paths.js", () => ({
      appPaths: () => ({ descriptor: "/fake/descriptor.json" })
    }));
    vi.doMock("../../src/services/install-home.js", () => ({
      resolveInstallHome: () => "/fake/home",
      readInstallJson: async () => undefined
    }));
    try {
      const { defaultBrokerStalenessCheck } = await import("../../src/frontend/lazy-broker-port.js");
      await expect(defaultBrokerStalenessCheck()).resolves.toBeUndefined();
    } finally {
      vi.doUnmock("../../src/services/broker-staleness.js");
      vi.doUnmock("../../src/config/paths.js");
      vi.doUnmock("../../src/services/install-home.js");
      vi.resetModules();
    }
  });
});
