import { testIpcEndpoint } from "../helpers/platform.js";
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { IpcServer } from "../../src/ipc/server.js";
import { IpcClient } from "../../src/ipc/client.js";
import { encodeFrame, FrameDecoder } from "../../src/ipc/framing.js";
import { BROKER_PROTOCOL, type BrokerDescriptor } from "../../src/ipc/protocol.js";

async function makePipe(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  return testIpcEndpoint(directory, "broker.sock");
}

function makeDescriptor(pipe: string, secret: string): BrokerDescriptor {
  return {
    pid: process.pid,
    pipeName: pipe,
    protocolMajor: BROKER_PROTOCOL.major,
    protocolMinor: BROKER_PROTOCOL.minor,
    packageVersion: "test",
    instanceId: "broker_cancel",
    authSecret: secret,
    createdAt: new Date().toISOString()
  };
}

const invokeParams = { root: "/workspace", agent: "requirements", message: "hello" };

/** A broker whose handlers run until their request is cancelled, recording each signal. */
async function startCancellableServer(pipe: string, secret: string) {
  const signals = new Map<string, AbortSignal>();
  const server = new IpcServer(
    pipe,
    secret,
    { packageVersion: "test", capabilities: [], instanceId: "broker_cancel" },
    async (_method, _params, requestId, _notify, signal) => {
      signals.set(requestId, signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { stopped: true };
    }
  );
  await server.listen();
  return { server, signals };
}

describe("IPC request cancellation (protocol minor 4)", () => {
  it("aborts the handler's signal when the requesting client stops waiting", async () => {
    const pipe = await makePipe("apl-ipc-cancel-");
    const secret = "c".repeat(43);
    const { server, signals } = await startCancellableServer(pipe, secret);
    const client = new IpcClient(makeDescriptor(pipe, secret));
    try {
      await client.connect();
      const controller = new AbortController();
      const pending = client.call("conversation.invoke", invokeParams, "req-cancel", controller.signal);
      await expect.poll(() => signals.has("req-cancel")).toBe(true);
      expect(signals.get("req-cancel")!.aborted).toBe(false);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
      await expect.poll(() => signals.get("req-cancel")!.aborted).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });

  it("lets only the requesting connection cancel, and answers unknown ids with cancelled: false", async () => {
    const pipe = await makePipe("apl-ipc-cancel-scope-");
    const secret = "d".repeat(43);
    const { server, signals } = await startCancellableServer(pipe, secret);
    const owner = new IpcClient(makeDescriptor(pipe, secret));
    const other = new IpcClient(makeDescriptor(pipe, secret));
    try {
      await owner.connect();
      await other.connect();
      const controller = new AbortController();
      const pending = owner.call("conversation.invoke", invokeParams, "req-owned", controller.signal);
      await expect.poll(() => signals.has("req-owned")).toBe(true);
      await expect(other.call("broker.cancel", { requestId: "req-owned" })).resolves.toEqual({
        cancelled: false
      });
      await expect(owner.call("broker.cancel", { requestId: "req-unknown" })).resolves.toEqual({
        cancelled: false
      });
      expect(signals.get("req-owned")!.aborted).toBe(false);
      await expect(owner.call("broker.cancel", { requestId: "req-owned" })).resolves.toEqual({
        cancelled: true
      });
      await expect(pending).resolves.toEqual({ stopped: true });
      controller.abort();
    } finally {
      owner.close();
      other.close();
      await server.close();
    }
  });

  it("cancels a connection's in-flight requests when that client goes away", async () => {
    const pipe = await makePipe("apl-ipc-cancel-close-");
    const secret = "h".repeat(43);
    const { server, signals } = await startCancellableServer(pipe, secret);
    const client = new IpcClient(makeDescriptor(pipe, secret));
    try {
      await client.connect();
      const pending = client.call("conversation.invoke", invokeParams, "req-orphaned");
      await expect.poll(() => signals.has("req-orphaned")).toBe(true);
      client.close();
      await expect(pending).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
      await expect.poll(() => signals.get("req-orphaned")!.aborted).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("fails only the request whose result cannot be sent, keeping the broker and connection up", async () => {
    const pipe = await makePipe("apl-ipc-oversize-");
    const secret = "g".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_oversize" },
      async (method) => (method === "workspace.list" ? { text: "x".repeat(1_100_000) } : { ok: true })
    );
    await server.listen();
    const client = new IpcClient(makeDescriptor(pipe, secret));
    try {
      await client.connect();
      await expect(client.call("workspace.list", { root: "/workspace" })).rejects.toMatchObject({
        code: "BROKER_PROTOCOL_ERROR"
      });
      await expect(client.call("broker.health", {})).resolves.toEqual({ ok: true });
    } finally {
      client.close();
      await server.close();
    }
  });

  it("handles a cancel written in the same chunk right behind another pending request", async () => {
    const pipe = await makePipe("apl-ipc-cancel-chunk-");
    const secret = "e".repeat(43);
    const { server, signals } = await startCancellableServer(pipe, secret);
    const socket = net.createConnection(pipe);
    const decoder = new FrameDecoder();
    const frames: unknown[] = [];
    socket.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
    try {
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write(
        encodeFrame({
          type: "hello",
          authSecret: secret,
          protocolMajor: BROKER_PROTOCOL.major,
          protocolMinor: BROKER_PROTOCOL.minor,
          packageVersion: "test",
          capabilities: []
        })
      );
      await expect.poll(() => frames.length).toBe(1);
      socket.write(encodeFrame({ id: "req-first", method: "conversation.invoke", params: invokeParams }));
      await expect.poll(() => signals.has("req-first")).toBe(true);
      // One write: a request that never finishes on its own, then the cancel for the first one.
      socket.write(
        Buffer.concat([
          encodeFrame({ id: "req-second", method: "conversation.invoke", params: invokeParams }),
          encodeFrame({ id: "req-cancel", method: "broker.cancel", params: { requestId: "req-first" } })
        ])
      );
      await expect
        .poll(() => frames)
        .toEqual(
          expect.arrayContaining([
            { id: "req-cancel", ok: true, result: { cancelled: true } },
            { id: "req-first", ok: true, result: { stopped: true } }
          ])
        );
      expect(signals.get("req-second")!.aborted).toBe(false);
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it.each([
    { minor: 3, sendsCancel: false },
    { minor: 4, sendsCancel: true }
  ])(
    "sends broker.cancel on abort only to a broker that negotiated minor 4 (negotiated $minor)",
    async ({ minor, sendsCancel }) => {
      const pipe = await makePipe("apl-ipc-cancel-minor-");
      const secret = "f".repeat(43);
      const received: Array<{ method?: string; params?: unknown }> = [];
      // A broker that negotiates the given minor and never answers requests.
      const fake = net.createServer((socket) => {
        const decoder = new FrameDecoder();
        socket.on("data", (chunk: Buffer) => {
          for (const value of decoder.push(chunk) as Array<{ type?: string; method?: string }>) {
            if (value.type === "hello") {
              socket.write(
                encodeFrame({
                  ok: true,
                  hello: {
                    protocolMajor: BROKER_PROTOCOL.major,
                    protocolMinor: minor,
                    packageVersion: "fake",
                    capabilities: [],
                    instanceId: "broker_fake"
                  }
                })
              );
            } else received.push(value);
          }
        });
        socket.on("error", () => undefined);
      });
      await new Promise<void>((resolve) => fake.listen(pipe, resolve));
      const client = new IpcClient(makeDescriptor(pipe, secret));
      try {
        await client.connect();
        const controller = new AbortController();
        const pending = client.call("conversation.invoke", invokeParams, "req-minor", controller.signal);
        await expect.poll(() => received.length).toBe(1);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(received.map((frame) => frame.method)).toEqual(
          sendsCancel ? ["conversation.invoke", "broker.cancel"] : ["conversation.invoke"]
        );
        if (sendsCancel) expect(received[1]!.params).toEqual({ requestId: "req-minor" });
      } finally {
        client.close();
        await new Promise<void>((resolve) => fake.close(() => resolve()));
      }
    }
  );
});
