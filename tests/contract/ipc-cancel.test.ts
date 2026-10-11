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

  // The broker may already have pressed send when its connection is lost: a request that can
  // submit a message is then unknown and must not invite a blind retry. Others stay retryable.
  it("never offers a lost in-flight submission for retry", async () => {
    const pipe = await makePipe("apl-ipc-lost-");
    const secret = "k".repeat(43);
    const { server, signals } = await startCancellableServer(pipe, secret);
    const client = new IpcClient(makeDescriptor(pipe, secret));
    try {
      await client.connect();
      const failure = (pending: Promise<unknown>) =>
        pending.then(
          () => undefined,
          (reason: unknown) => reason
        );
      const [invoke, test, check, list] = [
        client.call("conversation.invoke", invokeParams, "req-invoke"),
        client.call("agent.validate", { agent: "requirements", sendTestMessage: true }, "req-test"),
        client.call("agent.validate", { agent: "requirements" }, "req-check"),
        client.call("workspace.list", { root: "/workspace" }, "req-list")
      ].map(failure);
      await expect.poll(() => signals.size).toBe(4);
      await server.close();
      const lost = {
        code: "BROKER_UNAVAILABLE",
        retryable: false,
        options: { submissionState: "unknown" }
      };
      expect(await invoke).toMatchObject(lost);
      expect(await test).toMatchObject(lost);
      for (const pending of [check, list]) {
        const error = await pending;
        expect(error).toMatchObject({ code: "BROKER_UNAVAILABLE", retryable: true });
        expect((error as { options: { submissionState?: string } }).options.submissionState).toBeUndefined();
      }
    } finally {
      client.close();
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

  it.each(["oversized", "circular"])(
    "does not reserve a request ID when its %s parameters cannot be encoded",
    async (kind) => {
      const pipe = await makePipe("apl-ipc-encode-");
      const secret = "m".repeat(43);
      let calls = 0;
      const server = new IpcServer(
        pipe,
        secret,
        { packageVersion: "test", capabilities: [], instanceId: "broker_encode" },
        async () => ({ calls: ++calls })
      );
      await server.listen();
      const client = new IpcClient(makeDescriptor(pipe, secret));
      try {
        await client.connect();
        const params: Record<string, unknown> = {};
        if (kind === "oversized") params.data = "x".repeat(1_100_000);
        else params.self = params;
        await expect(client.call("broker.health", params, "req-encode")).rejects.toThrow();
        await expect(client.call("broker.health", {}, "req-encode")).resolves.toEqual({ calls: 1 });
      } finally {
        client.close();
        await server.close();
      }
    }
  );

  it("keeps a cancelled ID reserved until its late response arrives", async () => {
    const pipe = await makePipe("apl-ipc-cancel-reuse-");
    const secret = "n".repeat(43);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_cancel_reuse" },
      async (_method, _params, _id, _notify, signal) => {
        const call = ++calls;
        if (call === 1) {
          firstSignal = signal;
          await gate;
        }
        return { call };
      }
    );
    await server.listen();
    const client = new IpcClient(makeDescriptor(pipe, secret));
    try {
      await client.connect();
      const controller = new AbortController();
      const first = client.call("broker.health", {}, "req-reused", controller.signal);
      await expect.poll(() => firstSignal !== undefined).toBe(true);
      controller.abort();
      await expect(first).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
      await expect.poll(() => firstSignal!.aborted).toBe(true);
      await expect(client.call("broker.health", {}, "req-reused")).rejects.toMatchObject({
        code: "BROKER_PROTOCOL_ERROR"
      });
      expect(calls).toBe(1);
      release();
      // This reply follows the first reply on the same socket, so it is a delivery barrier.
      await expect(client.call("broker.health", {}, "req-barrier")).resolves.toEqual({ call: 2 });
      await expect(client.call("broker.health", {}, "req-reused")).resolves.toEqual({ call: 3 });
    } finally {
      release();
      client.close();
      await server.close();
    }
  });

  it.each([
    { method: "broker.health", params: {} },
    { method: "broker.cancel", params: { requestId: "req-duplicate" } },
    { method: "unknown", params: {} },
    { params: {} }
  ])("closes a connection that reuses an active ID ($method)", async (duplicate) => {
    const pipe = await makePipe("apl-ipc-duplicate-");
    const secret = "p".repeat(43);
    const signals: AbortSignal[] = [];
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_duplicate" },
      async (_method, _params, _id, _notify, signal) => {
        signals.push(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
        return { stopped: true };
      }
    );
    await server.listen();
    const socket = net.createConnection(pipe);
    const decoder = new FrameDecoder();
    const frames: unknown[] = [];
    socket.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
    socket.on("error", () => undefined);
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
      // A single chunk exercises ID reservation before the handler's first await completes.
      socket.write(
        Buffer.concat([
          encodeFrame({ id: "req-duplicate", method: "conversation.invoke", params: invokeParams }),
          encodeFrame({ id: "req-duplicate", ...duplicate })
        ])
      );
      await expect.poll(() => socket.destroyed, { timeout: 1_000 }).toBe(true);
      await expect.poll(() => signals[0]?.aborted).toBe(true);
      expect(signals).toHaveLength(1);
    } finally {
      socket.destroy();
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
