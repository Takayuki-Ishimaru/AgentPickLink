import { testIpcEndpoint } from "../helpers/platform.js";
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { IpcServer } from "../../src/ipc/server.js";
import { IpcClient } from "../../src/ipc/client.js";
import { encodeFrame } from "../../src/ipc/framing.js";
import { BROKER_PROTOCOL, type BrokerDescriptor } from "../../src/ipc/protocol.js";
import { HandshakeSchema } from "../../src/ipc/schemas.js";
describe("authenticated broker IPC", () => {
  it("accepts its descriptor secret and rejects another secret", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-ipc-"));
    const pipe = testIpcEndpoint(directory, "broker.sock");
    const secret = "a".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_test" },
      async (method) => ({ method })
    );
    await server.listen();
    const descriptor: BrokerDescriptor = {
      pid: process.pid,
      pipeName: pipe,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_test",
      authSecret: secret,
      createdAt: new Date().toISOString()
    };
    const valid = new IpcClient(descriptor);
    await expect(valid.connect()).resolves.toMatchObject({ instanceId: "broker_test", capabilities: [] });
    await expect(valid.call("broker.health", {})).resolves.toEqual({ method: "broker.health" });
    await expect(valid.call("broker.health", { unexpected: true })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT"
    });
    await expect(valid.call("not.a.method", {})).rejects.toMatchObject({ code: "BROKER_PROTOCOL_ERROR" });
    await expect(valid.call("broker.health", {}, "../../diagnostic")).rejects.toMatchObject({
      code: "BROKER_PROTOCOL_ERROR"
    });
    valid.close();
    const invalid = new IpcClient({ ...descriptor, authSecret: "b".repeat(43) });
    await expect(invalid.connect()).rejects.toMatchObject({ code: "BROKER_AUTH_FAILED" });
    invalid.close();
    await server.close();
  });
  it("negotiates only the capability intersection", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-ipc-capabilities-"));
    const pipe = testIpcEndpoint(directory, "broker.sock");
    const secret = "e".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: ["conversation", "server-only"], instanceId: "broker_caps" },
      async () => ({})
    );
    await server.listen();
    const descriptor: BrokerDescriptor = {
      pid: process.pid,
      pipeName: pipe,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_caps",
      authSecret: secret,
      createdAt: new Date().toISOString()
    };
    const client = new IpcClient(descriptor, "test", ["conversation", "client-only"]);
    await expect(client.connect()).resolves.toMatchObject({ capabilities: ["conversation"] });
    client.close();
    await server.close();
  });
  it("shares one handshake when concurrent callers connect the same client", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-ipc-connect-single-flight-"));
    const pipe = testIpcEndpoint(directory, "broker.sock");
    const secret = "f".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_connect_single_flight" },
      async () => ({ ok: true })
    );
    await server.listen();
    const descriptor: BrokerDescriptor = {
      pid: process.pid,
      pipeName: pipe,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_connect_single_flight",
      authSecret: secret,
      createdAt: new Date().toISOString()
    };
    const client = new IpcClient(descriptor);
    const hellos = await Promise.all(Array.from({ length: 8 }, () => client.connect()));
    expect(hellos).toHaveLength(8);
    expect(hellos.every((hello) => hello.instanceId === descriptor.instanceId)).toBe(true);
    await expect(client.call("broker.health", {})).resolves.toEqual({ ok: true });
    client.close();
    await server.close();
  });
  it("fails incompatible versions before connecting and rejects malformed handshakes", async () => {
    const descriptor: BrokerDescriptor = {
      pid: process.pid,
      pipeName: "/does/not/exist",
      protocolMajor: BROKER_PROTOCOL.major + 1,
      protocolMinor: 0,
      packageVersion: "test",
      instanceId: "broker_other",
      authSecret: "a".repeat(43),
      createdAt: new Date().toISOString()
    };
    await expect(new IpcClient(descriptor).connect()).rejects.toMatchObject({
      code: "BROKER_VERSION_MISMATCH"
    });
    expect(
      HandshakeSchema.safeParse({
        type: "hello",
        authSecret: "a".repeat(43),
        protocolMajor: 1,
        protocolMinor: 0,
        packageVersion: "test",
        capabilities: [],
        unexpected: true
      }).success
    ).toBe(false);
    expect(
      HandshakeSchema.safeParse({
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        packageVersion: "test",
        capabilities: []
      }).success
    ).toBe(false);
  });
  it("cancels an in-progress handshake when the client is closed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-ipc-connect-close-"));
    const pipe = testIpcEndpoint(directory, "broker.sock");
    const rawServer = net.createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(pipe, resolve);
    });
    const client = new IpcClient({
      pid: process.pid,
      pipeName: pipe,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_connect_close",
      authSecret: "j".repeat(43),
      createdAt: new Date().toISOString()
    });
    const pending = client.connect(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    client.close();
    await expect(pending).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    await new Promise<void>((resolve, reject) =>
      rawServer.close((error) => (error ? reject(error) : resolve()))
    );
    const server = new IpcServer(
      pipe,
      "j".repeat(43),
      { packageVersion: "test", capabilities: [], instanceId: "broker_connect_close" },
      async () => ({ reconnected: true })
    );
    await server.listen();
    await expect(client.connect()).resolves.toMatchObject({ instanceId: "broker_connect_close" });
    await expect(client.call("broker.health", {})).resolves.toEqual({ reconnected: true });
    client.close();
    await server.close();
  });
  it("clears a remotely closed connection so a later call reconnects cleanly", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-ipc-reconnect-"));
    const pipe = testIpcEndpoint(directory, "broker.sock");
    const secret = "k".repeat(43);
    const descriptor: BrokerDescriptor = {
      pid: process.pid,
      pipeName: pipe,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_reconnect",
      authSecret: secret,
      createdAt: new Date().toISOString()
    };
    const first = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_reconnect" },
      async () => ({ generation: 1 })
    );
    await first.listen();
    const client = new IpcClient(descriptor);
    await client.connect();
    await first.close();
    await expect(client.call("broker.health", {})).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });

    const second = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_reconnect" },
      async () => ({ generation: 2 })
    );
    await second.listen();
    await expect(client.call("broker.health", {})).resolves.toEqual({ generation: 2 });
    client.close();
    await second.close();
  });
  it("stops a cancelled caller without closing the broker or reissuing the request", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-ipc-cancel-"));
    const pipe = testIpcEndpoint(directory, "broker.sock");
    const secret = "c".repeat(43);
    let calls = 0;
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_cancel" },
      async () => {
        calls++;
        if (calls === 1) {
          started();
          await gate;
        }
        return { calls };
      }
    );
    await server.listen();
    const descriptor: BrokerDescriptor = {
      pid: process.pid,
      pipeName: pipe,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_cancel",
      authSecret: secret,
      createdAt: new Date().toISOString()
    };
    const client = new IpcClient(descriptor);
    await client.connect();
    const controller = new AbortController();
    const pending = client.call("broker.health", {}, "cancel-me", controller.signal);
    await began;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "SUBMIT_STATE_UNKNOWN",
      options: { submissionState: "unknown" }
    });
    release();
    await expect(client.call("broker.health", {})).resolves.toEqual({ calls: 2 });
    expect(calls).toBe(2);
    client.close();
    await server.close();
  });
  it("closes promptly while multiple authenticated clients remain connected", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-ipc-close-"));
    const pipe = testIpcEndpoint(directory, "broker.sock");
    const secret = "d".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_close" },
      async () => ({})
    );
    await server.listen();
    const descriptor: BrokerDescriptor = {
      pid: process.pid,
      pipeName: pipe,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_close",
      authSecret: secret,
      createdAt: new Date().toISOString()
    };
    const one = new IpcClient(descriptor);
    const two = new IpcClient(descriptor);
    await Promise.all([one.connect(), two.connect()]);
    await expect(server.close()).resolves.toBeUndefined();
    one.close();
    two.close();
  });
  it("keeps other in-flight calls alive when a malformed envelope arrives on the same connection", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-ipc-malformed-"));
    const pipe = testIpcEndpoint(directory, "broker.sock");
    const secret = "g".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_malformed" },
      async (_method, _params, requestId) => ({ requestId })
    );
    await server.listen();
    const descriptor: BrokerDescriptor = {
      pid: process.pid,
      pipeName: pipe,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: BROKER_PROTOCOL.minor,
      packageVersion: "test",
      instanceId: "broker_malformed",
      authSecret: secret,
      createdAt: new Date().toISOString()
    };
    const client = new IpcClient(descriptor);
    await client.connect();
    // Two calls in flight at once, then a raw malformed envelope (no "id" the server can key a
    // response to) is injected directly on the wire, bypassing the client's own request encoding.
    const first = client.call("broker.health", {}, "req-one");
    const second = client.call("broker.health", {}, "req-two");
    (client as unknown as { socket: net.Socket }).socket.write(
      encodeFrame({ method: "broker.health", params: {} })
    );
    await expect(first).resolves.toEqual({ requestId: "req-one" });
    await expect(second).resolves.toEqual({ requestId: "req-two" });
    // The connection must still be usable afterward, not torn down by the malformed frame.
    await expect(client.call("broker.health", {}, "req-three")).resolves.toEqual({ requestId: "req-three" });
    client.close();
    await server.close();
  });
  it("refuses to start on win32 when another endpoint is already listening on the pipe name (squatting protection)", async () => {
    // net.Server cannot set a DACL on a Windows named pipe, so IpcServer instead probes for an
    // already-listening endpoint before binding. The `platform` constructor parameter lets this
    // run deterministically on any OS: the underlying transport is still a plain local socket,
    // but the win32-only pre-listen probe is exercised.
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-ipc-squat-"));
    const pipe = testIpcEndpoint(directory, "broker.pipe");
    const first = new IpcServer(
      pipe,
      "h".repeat(43),
      { packageVersion: "test", capabilities: [], instanceId: "broker_first" },
      async () => ({}),
      "win32"
    );
    await first.listen();
    const second = new IpcServer(
      pipe,
      "i".repeat(43),
      { packageVersion: "test", capabilities: [], instanceId: "broker_second" },
      async () => ({}),
      "win32"
    );
    await expect(second.listen()).rejects.toMatchObject({ code: "BROKER_START_FAILED" });
    await first.close();
  });
});
