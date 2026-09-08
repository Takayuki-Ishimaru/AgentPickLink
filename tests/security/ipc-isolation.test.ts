import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IpcServer } from "../../src/ipc/server.js";
import { IpcClient } from "../../src/ipc/client.js";
import { BROKER_PROTOCOL, type BrokerDescriptor } from "../../src/ipc/protocol.js";
import type { ProgressEvent } from "../../src/domain/progress.js";

async function makePipe(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(directory, "broker.sock");
}

function makeDescriptor(pipe: string, secret: string, instanceId: string): BrokerDescriptor {
  return {
    pid: process.pid,
    pipeName: pipe,
    protocolMajor: BROKER_PROTOCOL.major,
    protocolMinor: BROKER_PROTOCOL.minor,
    packageVersion: "test",
    instanceId,
    authSecret: secret,
    createdAt: new Date().toISOString()
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/**
 * §H4(a): two IpcClients connected to one IpcServer must never let a progress frame meant for one
 * client's request reach the other's onProgress sink. This holds structurally today because
 * IpcServer.accept() closes each connection's `notify` callback over that connection's own
 * socket (see src/ipc/server.ts), but the guarantee is worth a regression test of its own: a
 * future refactor that hoisted `notify` (or the per-request `settled` bookkeeping) out of the
 * per-socket closure could silently reintroduce cross-client delivery.
 */
describe("IPC per-connection isolation", () => {
  it("never delivers a progress frame from one client's request to another client's onProgress sink", async () => {
    const pipe = await makePipe("apl-ipc-isolation-");
    const secret = "t".repeat(43);
    const notifies: Array<(event: ProgressEvent) => void> = [];
    const releases: Array<() => void> = [];
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_isolation" },
      async (_method, _params, requestId, notify) => {
        notifies.push(notify);
        // Held open deliberately so the test can fire a captured `notify` while both requests are
        // still in flight, before either connection's `settled` flag would silently drop it.
        await new Promise<void>((resolve) => releases.push(resolve));
        return { requestId };
      }
    );
    await server.listen();

    const clientA = new IpcClient(makeDescriptor(pipe, secret, "broker_isolation"));
    const clientB = new IpcClient(makeDescriptor(pipe, secret, "broker_isolation"));
    await clientA.connect();
    await clientB.connect();

    const eventsA: ProgressEvent[] = [];
    const eventsB: ProgressEvent[] = [];
    // Both clients deliberately use the identical request id: if a progress frame were ever
    // written to every open socket instead of just the one that owns the request (the bug this
    // test guards against), a client with a same-id pending call is exactly what would let it be
    // silently accepted instead of ignored as "unknown request id".
    const callA = clientA.call("broker.health", {}, "shared-id", undefined, {
      onProgress: (event) => eventsA.push(event)
    });
    await settle();
    const callB = clientB.call("broker.health", {}, "shared-id", undefined, {
      onProgress: (event) => eventsB.push(event)
    });
    await settle();

    expect(notifies).toHaveLength(2);
    // Fire the notify captured for client A's request only.
    notifies[0]!({ phase: "connecting", message: "for-a-only" });
    await settle();

    expect(eventsA).toEqual([{ phase: "connecting", message: "for-a-only" }]);
    expect(eventsB).toEqual([]);

    // Client B's own call must still complete normally -- isolation must never break B's request.
    releases.forEach((release) => release());
    await expect(callA).resolves.toEqual({ requestId: "shared-id" });
    await expect(callB).resolves.toEqual({ requestId: "shared-id" });
    expect(eventsB).toEqual([]);

    clientA.close();
    clientB.close();
    await server.close();
  });
});
