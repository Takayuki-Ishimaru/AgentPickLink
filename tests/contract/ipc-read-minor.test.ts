import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import type { ProgressEvent, ProgressSink } from "../../src/domain/progress.js";
import { IpcClient } from "../../src/ipc/client.js";
import { encodeFrame, FrameDecoder } from "../../src/ipc/framing.js";
import { BROKER_PROTOCOL, type BrokerDescriptor } from "../../src/ipc/protocol.js";
import { IpcServer, type BrokerHandler } from "../../src/ipc/server.js";
import { testIpcEndpoint } from "../helpers/platform.js";

/**
 * Protocol minor 5 added `conversation.read`, `expectFiles` on `conversation.invoke` and
 * `conversationHandle` on a failed invoke's error. A client talking to a broker that negotiated an
 * older minor must not send what that broker would refuse, and must say why in the case of a read.
 */

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
    instanceId: "broker_minor5",
    authSecret: secret,
    createdAt: new Date().toISOString()
  };
}

type Frame = { id?: string; method?: string; params?: unknown };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A broker that negotiates `minor`, records every request after the handshake and answers it with
 * whatever `answer` returns (a request it does not answer stays pending). */
async function startBrokerOfMinor(
  minor: number,
  answer: (frame: Frame) => Record<string, unknown> | undefined = () => undefined
) {
  const pipe = await makePipe(`apl-ipc-minor-${minor}-`);
  const secret = "m".repeat(43);
  const received: Frame[] = [];
  const fake = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const value of decoder.push(chunk) as Array<Frame & { type?: string }>) {
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
          continue;
        }
        received.push(value);
        const reply = answer(value);
        if (reply) socket.write(encodeFrame({ id: value.id, ...reply }));
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => fake.listen(pipe, resolve));
  const client = new IpcClient(makeDescriptor(pipe, secret));
  cleanups.push(async () => {
    client.close();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });
  await client.connect();
  return { client, received };
}

/** A real broker server (which negotiates minor 5 with this client) recording what its handler gets. */
async function startCurrentBroker(handler?: BrokerHandler) {
  const pipe = await makePipe("apl-ipc-minor-5-");
  const secret = "n".repeat(43);
  const calls: Array<{ method: string; params: unknown; requestId: string }> = [];
  const server = new IpcServer(
    pipe,
    secret,
    { packageVersion: "test", capabilities: [], instanceId: "broker_minor5" },
    async (method, params, requestId, notify, signal) => {
      calls.push({ method, params, requestId });
      return handler ? handler(method, params, requestId, notify, signal) : { ok: true };
    }
  );
  await server.listen();
  const client = new IpcClient(makeDescriptor(pipe, secret));
  cleanups.push(async () => {
    client.close();
    await server.close();
  });
  await client.connect();
  return { client, server, calls };
}

const readParams = { root: "/workspace", conversationHandle: "conv_kept" };
const invokeParams = { root: "/workspace", agent: "requirements", message: "hello" };
const failureOf = (pending: Promise<unknown>) =>
  pending.then(
    () => undefined,
    (reason: unknown) => reason
  );

describe("conversation.read against a broker older than protocol minor 5", () => {
  it.each([0, 3, 4])(
    "is refused as BROKER_VERSION_MISMATCH without sending anything to a broker of minor %s",
    async (minor) => {
      const { client, received } = await startBrokerOfMinor(minor, () => ({
        ok: true,
        result: { listed: true }
      }));

      const error = await failureOf(client.call("conversation.read", readParams, "req-read"));

      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: "BROKER_VERSION_MISMATCH", retryable: false });
      const { remediation } = (error as DomainError).options;
      expect(remediation).toContain("broker restart");
      expect((error as DomainError).toResult("req-read").error.remediation).toBe(remediation);
      // Frames reach the broker in the order they were written: had the read been written, it
      // would be the first thing it saw, ahead of this request.
      await expect(client.call("workspace.list", { root: "/workspace" }, "req-after")).resolves.toEqual({
        listed: true
      });
      expect(received.map((frame) => frame.method)).toEqual(["workspace.list"]);
    }
  );

  it("does not leave the request id pending, so the same read can be refused again", async () => {
    const { client, received } = await startBrokerOfMinor(4);

    const first = await failureOf(client.call("conversation.read", readParams, "req-same"));
    const second = await failureOf(client.call("conversation.read", readParams, "req-same"));

    expect(first).toMatchObject({ code: "BROKER_VERSION_MISMATCH" });
    expect(second).toMatchObject({ code: "BROKER_VERSION_MISMATCH" });
    expect(received).toEqual([]);
  });
});

describe("expectFiles on conversation.invoke against a broker older than protocol minor 5", () => {
  it.each([3, 4])("is dropped before the request is written to a broker of minor %s", async (minor) => {
    const { client, received } = await startBrokerOfMinor(minor, () => ({
      ok: true,
      result: { done: true }
    }));
    const params = { ...invokeParams, conversationHandle: "conv_existing", expectFiles: false };

    await expect(client.call("conversation.invoke", params, "req-invoke")).resolves.toEqual({ done: true });

    expect(received).toEqual([
      {
        id: "req-invoke",
        method: "conversation.invoke",
        params: { ...invokeParams, conversationHandle: "conv_existing" }
      }
    ]);
    expect(Object.hasOwn(received[0]!.params as object, "expectFiles")).toBe(false);
    // The caller's own object is left as it was.
    expect(params).toEqual({ ...invokeParams, conversationHandle: "conv_existing", expectFiles: false });
  });

  it("drops expectFiles=true as well, which an older broker equally refuses", async () => {
    const { client, received } = await startBrokerOfMinor(4, () => ({ ok: true, result: {} }));

    await client.call("conversation.invoke", { ...invokeParams, expectFiles: true }, "req-invoke");

    expect(received[0]!.params).toEqual(invokeParams);
  });

  it("changes nothing for an invoke that does not use it", async () => {
    const { client, received } = await startBrokerOfMinor(4, () => ({ ok: true, result: {} }));

    await client.call("conversation.invoke", invokeParams, "req-invoke");

    expect(received[0]!.params).toEqual(invokeParams);
  });

  it("leaves an invoke that lost expectFiles cancellable on a broker of minor 4", async () => {
    const { client, received } = await startBrokerOfMinor(4);
    const controller = new AbortController();

    const pending = failureOf(
      client.call(
        "conversation.invoke",
        { ...invokeParams, expectFiles: false },
        "req-invoke",
        controller.signal
      )
    );
    await expect.poll(() => received.length, { timeout: 3_000 }).toBe(1);
    controller.abort();
    await pending;
    await expect
      .poll(() => received.map((frame) => frame.method), { timeout: 3_000 })
      .toEqual(["conversation.invoke", "broker.cancel"]);
  });
});

describe("conversation.read and expectFiles against a broker of protocol minor 5", () => {
  it("passes a conversation.read through to the handler, with its progress", async () => {
    const { client, calls } = await startCurrentBroker(async (_method, _params, _requestId, notify) => {
      notify({ phase: "checking-message", elapsedMs: 5 });
      notify({ phase: "confirming-response", elapsedMs: 9 });
      return { reply: "complete" };
    });
    const events: ProgressEvent[] = [];
    const onProgress: ProgressSink = (event) => events.push(event);

    const result = await client.call("conversation.read", readParams, "req-read", undefined, { onProgress });

    expect(result).toEqual({ reply: "complete" });
    expect(calls).toEqual([{ method: "conversation.read", params: readParams, requestId: "req-read" }]);
    expect(events).toEqual([
      { phase: "checking-message", elapsedMs: 5 },
      { phase: "confirming-response", elapsedMs: 9 }
    ]);
  });

  it.each([[true], [false]])(
    "passes expectFiles=%s on conversation.invoke through to the handler",
    async (expectFiles) => {
      const { client, calls } = await startCurrentBroker();

      await client.call("conversation.invoke", { ...invokeParams, expectFiles }, "req-invoke");

      expect(calls).toEqual([
        { method: "conversation.invoke", params: { ...invokeParams, expectFiles }, requestId: "req-invoke" }
      ]);
    }
  );

  it("refuses what the broker's schemas refuse before any handler runs", async () => {
    const { client, calls } = await startCurrentBroker();

    const refused = [
      ["conversation.read", { root: "/workspace" }],
      ["conversation.read", { ...readParams, agent: "requirements" }],
      ["conversation.read", { root: "/workspace", conversationHandle: "raw" }],
      ["conversation.invoke", { ...invokeParams, message: "  \n\t " }],
      ["conversation.invoke", { ...invokeParams, message: "" }],
      ["conversation.invoke", { ...invokeParams, expectFiles: "no" }]
    ] as const;
    // A request id is letters, digits, "_" and "-" only, so the method name is not part of it.
    for (const [index, [method, params]] of refused.entries())
      await expect(client.call(method, params, `req-refused-${index}`)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT"
      });

    expect(calls).toEqual([]);
  });

  it("a read lost with the connection can simply be repeated: it submitted nothing", async () => {
    const { client, server, calls } = await startCurrentBroker(
      () => new Promise<never>(() => undefined) // never answers
    );

    const read = failureOf(client.call("conversation.read", readParams, "req-read"));
    const invoke = failureOf(client.call("conversation.invoke", invokeParams, "req-invoke"));
    await expect.poll(() => calls.length, { timeout: 3_000 }).toBe(2);
    await server.close();

    expect(await read).toMatchObject({ code: "BROKER_UNAVAILABLE", retryable: true });
    expect((await read) as DomainError).toHaveProperty("options", {});
    expect(await invoke).toMatchObject({
      code: "BROKER_UNAVAILABLE",
      retryable: false,
      options: { submissionState: "unknown" }
    });
  });
});

describe("the error of a failed invoke that left its conversation open", () => {
  it("reaches the caller with its conversationHandle", async () => {
    const { client } = await startCurrentBroker(async () => {
      throw new DomainError("SUBMIT_STATE_UNKNOWN", "The message may have been submitted.", false, {
        submissionState: "unknown",
        conversationHandle: "conv_kept",
        remediation: "Read the conversation."
      });
    });

    const error = await failureOf(client.call("conversation.invoke", invokeParams, "req-invoke"));

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: "SUBMIT_STATE_UNKNOWN",
      retryable: false,
      options: {
        submissionState: "unknown",
        conversationHandle: "conv_kept",
        remediation: "Read the conversation."
      }
    });
    expect((error as DomainError).toResult("req-invoke").error).toMatchObject({
      conversationHandle: "conv_kept"
    });
  });

  it("carries a partial response with it for a timeout", async () => {
    const { client } = await startCurrentBroker(async () => {
      throw new DomainError("RESPONSE_TIMEOUT", "The response did not finish.", false, {
        submissionState: "sent",
        partialResponse: { text: "so far", citations: [] },
        conversationHandle: "conv_kept"
      });
    });

    const error = await failureOf(client.call("conversation.invoke", invokeParams, "req-invoke"));

    expect(error).toMatchObject({
      code: "RESPONSE_TIMEOUT",
      options: {
        submissionState: "sent",
        partialResponse: { text: "so far", citations: [] },
        conversationHandle: "conv_kept"
      }
    });
  });

  it("has no conversationHandle when the broker named none", async () => {
    const { client } = await startCurrentBroker(async () => {
      throw new DomainError("UI_CHANGED", "The chat structure changed.", false, {
        submissionState: "not-sent"
      });
    });

    const error = (await failureOf(
      client.call("conversation.invoke", invokeParams, "req-invoke")
    )) as DomainError;

    expect(error).toMatchObject({ code: "UI_CHANGED" });
    expect(Object.hasOwn(error.options, "conversationHandle")).toBe(false);
    expect(error.toResult("req-invoke").error).not.toHaveProperty("conversationHandle");
  });
});

describe("a caller that stops waiting for an invoke", () => {
  it("gets SUBMIT_STATE_UNKNOWN with the stock remediation, which points to reading the conversation", async () => {
    const { client } = await startBrokerOfMinor(BROKER_PROTOCOL.minor);
    const controller = new AbortController();

    const pending = failureOf(
      client.call("conversation.invoke", invokeParams, "req-invoke", controller.signal)
    );
    controller.abort();
    const error = (await pending) as DomainError;

    expect(error).toMatchObject({
      code: "SUBMIT_STATE_UNKNOWN",
      retryable: false,
      options: { submissionState: "unknown" }
    });
    // No explicit remediation: the default one for the code applies.
    expect(error.options.remediation).toBeUndefined();
    const { remediation } = error.toResult("req-invoke").error;
    expect(remediation).toContain("m365_agent_session");
    expect(remediation).toContain("action=read");
  });
});

/** A client of protocol minor `minor`, speaking frames directly: the hello, then one request. */
async function rawClientRequest(
  pipe: string,
  secret: string,
  minor: number,
  method: string,
  params: unknown
) {
  const socket = net.createConnection(pipe);
  cleanups.push(() => void socket.destroy());
  const decoder = new FrameDecoder();
  const frames: Array<Record<string, unknown>> = [];
  socket.on("data", (chunk: Buffer) =>
    frames.push(...(decoder.push(chunk) as Array<Record<string, unknown>>))
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    encodeFrame({
      type: "hello",
      authSecret: secret,
      protocolMajor: BROKER_PROTOCOL.major,
      protocolMinor: minor,
      packageVersion: "old-frontend",
      capabilities: []
    })
  );
  await expect.poll(() => frames.length, { timeout: 3_000 }).toBe(1);
  socket.write(encodeFrame({ id: "req-raw", method, params }));
  await expect.poll(() => frames.length, { timeout: 3_000 }).toBe(2);
  return { hello: frames[0], response: frames[1] };
}

// Independent review of the 2026-10-10 fixes: the broker must know what the requesting client can
// do -- a minor-4 client cannot read a conversation, so a failed ask must not leave it one to read.
describe("the protocol minor each request's client negotiated", () => {
  it.each([3, 4, BROKER_PROTOCOL.minor])(
    "reaches the broker's handler for a client of minor %s",
    async (minor) => {
      const pipe = await makePipe("apl-ipc-client-minor-");
      const secret = "p".repeat(43);
      const seen: Array<{ method: string; client?: { protocolMinor: number } }> = [];
      const server = new IpcServer(
        pipe,
        secret,
        { packageVersion: "test", capabilities: [], instanceId: "broker_client_minor" },
        async (method, _params, _requestId, _notify, _signal, client) => {
          seen.push({ method, client });
          return { ok: true };
        }
      );
      await server.listen();
      cleanups.push(() => server.close());

      const { hello, response } = await rawClientRequest(pipe, secret, minor, "conversation.list", {
        root: "/workspace"
      });

      expect(hello).toMatchObject({
        ok: true,
        hello: { protocolMinor: Math.min(minor, BROKER_PROTOCOL.minor) }
      });
      expect(response).toMatchObject({ id: "req-raw", ok: true });
      expect(seen).toEqual([{ method: "conversation.list", client: { protocolMinor: minor } }]);
    }
  );
});
