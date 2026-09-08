import { testIpcEndpoint } from "../helpers/platform.js";
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type net from "node:net";
import { IpcServer } from "../../src/ipc/server.js";
import { IpcClient } from "../../src/ipc/client.js";
import { encodeFrame } from "../../src/ipc/framing.js";
import { BROKER_PROTOCOL, type BrokerDescriptor } from "../../src/ipc/protocol.js";
import type { ProgressEvent, ProgressSink } from "../../src/domain/progress.js";

async function makePipe(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  return testIpcEndpoint(directory, "broker.sock");
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

describe("IPC progress notifications", () => {
  it("delivers progress frames to onProgress before the final response, and ignores a late notify sent after the response was written", async () => {
    const pipe = await makePipe("apl-ipc-progress-");
    const secret = "p".repeat(43);
    let capturedNotify: ProgressSink | undefined;
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_progress" },
      async (_method, _params, _requestId, notify) => {
        capturedNotify = notify;
        notify({ phase: "connecting" });
        notify({ phase: "navigating", elapsedMs: 5 });
        return { done: true };
      }
    );
    await server.listen();
    const client = new IpcClient(makeDescriptor(pipe, secret, "broker_progress"));
    await client.connect();

    const events: ProgressEvent[] = [];
    const result = await client.call("broker.health", {}, "req-progress", undefined, {
      onProgress: (event) => events.push(event)
    });

    expect(result).toEqual({ done: true });
    expect(events).toEqual([{ phase: "connecting" }, { phase: "navigating", elapsedMs: 5 }]);

    // The handler kept a reference to its `notify` and calls it again after this request's
    // response has already been written. The server-side guard must drop it silently: no waiter
    // is listening for "req-progress" any more, so no new event may reach the client.
    expect(capturedNotify).toBeTypeOf("function");
    capturedNotify!({ phase: "done" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([{ phase: "connecting" }, { phase: "navigating", elapsedMs: 5 }]);

    client.close();
    await server.close();
  });

  it("drops an invalid progress payload server-side before it ever reaches the client", async () => {
    const pipe = await makePipe("apl-ipc-progress-invalid-");
    const secret = "q".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_progress_invalid" },
      async (_method, _params, _requestId, notify) => {
        // Not a ProgressEvent (no "phase"): the server must validate with isProgressEvent and
        // never encode/write this one.
        (notify as (value: unknown) => void)({ not: "a-progress-event" });
        notify({ phase: "done" });
        return { ok: true };
      }
    );
    await server.listen();
    const client = new IpcClient(makeDescriptor(pipe, secret, "broker_progress_invalid"));
    await client.connect();

    const events: ProgressEvent[] = [];
    const result = await client.call("broker.health", {}, "req-invalid", undefined, {
      onProgress: (event) => events.push(event)
    });

    expect(result).toEqual({ ok: true });
    expect(events).toEqual([{ phase: "done" }]);

    client.close();
    await server.close();
  });

  it("ignores a progress frame for an unknown request id without disrupting other in-flight calls", async () => {
    const pipe = await makePipe("apl-ipc-progress-unknown-");
    const secret = "r".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_progress_unknown" },
      async (_method, _params, requestId) => ({ requestId })
    );
    await server.listen();
    const client = new IpcClient(makeDescriptor(pipe, secret, "broker_progress_unknown"));
    await client.connect();

    // Injected directly on the wire, bypassing the client's own request tracking: no waiter was
    // ever registered for "no-such-request", so this must be silently ignored.
    (client as unknown as { socket: net.Socket }).socket.write(
      encodeFrame({ id: "no-such-request", event: "progress", data: { phase: "connecting" } })
    );

    await expect(client.call("broker.health", {}, "req-still-works")).resolves.toEqual({
      requestId: "req-still-works"
    });

    client.close();
    await server.close();
  });

  it("never settles the call's promise from a progress frame, even when many are sent", async () => {
    const pipe = await makePipe("apl-ipc-progress-many-");
    const secret = "s".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_progress_many" },
      async (_method, _params, _requestId, notify) => {
        for (let i = 0; i < 5; i++) notify({ phase: "streaming", responseChars: i * 10 });
        return { finished: true };
      }
    );
    await server.listen();
    const client = new IpcClient(makeDescriptor(pipe, secret, "broker_progress_many"));
    await client.connect();

    const events: ProgressEvent[] = [];
    let resolvedBeforeAllProgress = false;
    const pending = client
      .call("broker.health", {}, "req-many", undefined, {
        onProgress: (event) => events.push(event)
      })
      .then((value) => {
        resolvedBeforeAllProgress = events.length < 5;
        return value;
      });

    await expect(pending).resolves.toEqual({ finished: true });
    expect(events).toHaveLength(5);
    expect(resolvedBeforeAllProgress).toBe(false);

    client.close();
    await server.close();
  });
});
