import { testIpcEndpoint } from "../helpers/platform.js";
import { mkdtemp } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectExistingBroker,
  connectOrStartBroker,
  terminateDescriptorBroker
} from "../../src/broker/broker-lifecycle.js";
import { readDescriptor, removeDescriptor, writeDescriptor } from "../../src/broker/broker-descriptor.js";
import * as brokerDescriptor from "../../src/broker/broker-descriptor.js";
import { initializeLocalState } from "../../src/config/init.js";
import { appPaths } from "../../src/config/paths.js";
import { IpcServer } from "../../src/ipc/server.js";
import { BROKER_PROTOCOL } from "../../src/ipc/protocol.js";
import { spawn } from "node:child_process";

const noopLocalStatePreparer = {
  async prepareLocalState() {
    /* no browser profile to prepare in this test */
  }
};

describe("broker startup coordination", () => {
  const servers: IpcServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("recovers a stale live-PID descriptor and lets two clients share one startup", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-lifecycle-"));
    const paths = await initializeLocalState(appPaths(path.join(base, "appdata")), noopLocalStatePreparer);
    await writeDescriptor(paths, {
      pid: process.pid,
      pipeName: testIpcEndpoint(base, "missing.sock"),
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_stale",
      authSecret: "s".repeat(43),
      createdAt: new Date().toISOString()
    });
    let starts = 0;
    const spawn = async () => {
      starts++;
      const pipeName = testIpcEndpoint(base, "live.sock");
      const authSecret = "n".repeat(43);
      const server = new IpcServer(
        pipeName,
        authSecret,
        { packageVersion: "test", capabilities: [], instanceId: "broker_live" },
        async () => ({ healthy: true })
      );
      servers.push(server);
      await server.listen();
      await writeDescriptor(paths, {
        pid: process.pid,
        pipeName,
        protocolMajor: BROKER_PROTOCOL.major,
        protocolMinor: BROKER_PROTOCOL.minor,
        packageVersion: "test",
        instanceId: "broker_live",
        authSecret,
        createdAt: new Date().toISOString()
      });
    };
    const [one, two] = await Promise.all([
      connectOrStartBroker(paths, spawn),
      connectOrStartBroker(paths, spawn)
    ]);
    expect(starts).toBe(1);
    await expect(one.call("broker.health", {})).resolves.toEqual({ healthy: true });
    await expect(two.call("broker.health", {})).resolves.toEqual({ healthy: true });
    one.close();
    two.close();
  });
  it("explicitly terminates a broker represented by an incompatible descriptor", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-old-broker-"));
    const paths = await initializeLocalState(appPaths(path.join(base, "appdata")), noopLocalStatePreparer);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "broker/process.js"], {
      stdio: "ignore"
    });
    await new Promise<void>((resolve, reject) => child.once("spawn", resolve).once("error", reject));
    await writeDescriptor(paths, {
      pid: child.pid!,
      pipeName: testIpcEndpoint(base, "old.sock"),
      protocolMajor: BROKER_PROTOCOL.major + 1,
      protocolMinor: 0,
      packageVersion: "old",
      instanceId: "broker_old",
      authSecret: "o".repeat(43),
      createdAt: new Date().toISOString()
    });
    await expect(terminateDescriptorBroker(paths, 2_000)).resolves.toMatchObject({
      stopped: true,
      pid: child.pid
    });
  });
  it("never spawns a parallel broker when the descriptor belongs to a live broker process", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-live-broker-"));
    const paths = await initializeLocalState(appPaths(path.join(base, "appdata")), noopLocalStatePreparer);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "broker/process.js"], {
      stdio: "ignore"
    });
    await new Promise<void>((resolve, reject) => child.once("spawn", resolve).once("error", reject));
    let starts = 0;
    try {
      await writeDescriptor(paths, {
        pid: child.pid!,
        pipeName: testIpcEndpoint(base, "not-yet-listening.sock"),
        protocolMajor: BROKER_PROTOCOL.major,
        protocolMinor: BROKER_PROTOCOL.minor,
        packageVersion: "test",
        instanceId: "broker_starting",
        authSecret: "p".repeat(43),
        createdAt: new Date().toISOString()
      });
      await expect(
        connectOrStartBroker(paths, async () => {
          starts++;
        })
      ).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
      expect(starts).toBe(0);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });
  it("waits for a shutting-down owner to release its descriptor before electing a replacement", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-shutdown-race-"));
    const paths = await initializeLocalState(appPaths(path.join(base, "appdata")), noopLocalStatePreparer);
    const oldOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "broker/process.js"], {
      stdio: "ignore"
    });
    await new Promise<void>((resolve, reject) => oldOwner.once("spawn", resolve).once("error", reject));
    try {
      await writeDescriptor(paths, {
        pid: oldOwner.pid!,
        pipeName: testIpcEndpoint(base, "closing.sock"),
        protocolMajor: BROKER_PROTOCOL.major,
        protocolMinor: BROKER_PROTOCOL.minor,
        packageVersion: "test",
        instanceId: "broker_closing",
        authSecret: "c".repeat(43),
        createdAt: new Date().toISOString(),
        state: "stopping"
      });
      setTimeout(() => void removeDescriptor(paths), 75).unref();
      let starts = 0;
      const client = await connectOrStartBroker(
        paths,
        async () => {
          starts++;
          const pipeName = testIpcEndpoint(base, "replacement.sock");
          const authSecret = "d".repeat(43);
          const server = new IpcServer(
            pipeName,
            authSecret,
            { packageVersion: "test", capabilities: [], instanceId: "broker_replacement" },
            async () => ({ healthy: true })
          );
          servers.push(server);
          await server.listen();
          await writeDescriptor(paths, {
            pid: process.pid,
            pipeName,
            protocolMajor: BROKER_PROTOCOL.major,
            protocolMinor: BROKER_PROTOCOL.minor,
            packageVersion: "test",
            instanceId: "broker_replacement",
            authSecret,
            createdAt: new Date().toISOString()
          });
        },
        2_000
      );
      expect(starts).toBe(1);
      await expect(client.call("broker.health", {})).resolves.toEqual({ healthy: true });
      client.close();
    } finally {
      oldOwner.kill("SIGTERM");
      await new Promise<void>((resolve) => oldOwner.once("exit", () => resolve()));
    }
  });
  it("does not delete a fresh descriptor written by a race winner while cleaning up a dead-PID descriptor", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-dead-pid-"));
    const paths = await initializeLocalState(appPaths(path.join(base, "appdata")), noopLocalStatePreparer);
    const deadPid = 999_999; // not alive, and isPidAlive is stubbed below regardless
    await writeDescriptor(paths, {
      pid: deadPid,
      pipeName: testIpcEndpoint(base, "dead.sock"),
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_dead",
      authSecret: "q".repeat(43),
      createdAt: new Date().toISOString()
    });
    const winner = {
      pid: process.pid,
      pipeName: testIpcEndpoint(base, "winner.sock"),
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_winner",
      authSecret: "r".repeat(43),
      createdAt: new Date().toISOString()
    };
    // Simulate another process winning the startup race and publishing a fresh descriptor
    // synchronously, in the same tick isPidAlive reports the old PID as dead — before
    // connectExistingBroker's own (async) cleanup read runs.
    const spy = vi.spyOn(brokerDescriptor, "isPidAlive").mockImplementation((pid: number) => {
      if (pid === deadPid) {
        writeFileSync(paths.descriptor, `${JSON.stringify(winner)}\n`, { encoding: "utf8", mode: 0o600 });
        return false;
      }
      return true;
    });
    try {
      await expect(connectExistingBroker(paths)).resolves.toBeUndefined();
      await expect(readDescriptor(paths)).resolves.toMatchObject({ instanceId: "broker_winner" });
    } finally {
      spy.mockRestore();
    }
  });
});
