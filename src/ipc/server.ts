import net from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { encodeFrame, FrameDecoder } from "./framing.js";
import { HandshakeSchema, IpcEnvelopeSchema, parseMethod, type BrokerMethod } from "./schemas.js";
import { BROKER_PROTOCOL, type BrokerHello, type IpcResponse } from "./protocol.js";
import { DomainError, asDomainError } from "../domain/errors.js";
import { isProgressEvent, type ProgressSink } from "../domain/progress.js";
export type BrokerHandler = (
  method: BrokerMethod,
  params: Record<string, unknown>,
  requestId: string,
  notify: ProgressSink,
  /** Aborted when the requesting client sends `broker.cancel` for this request. */
  signal: AbortSignal,
  /** The requesting connection: the protocol minor negotiated with its client, which decides what
   * that client can be offered (a minor-4 client cannot read a conversation, for one). */
  client?: { protocolMinor: number }
) => Promise<unknown>;
export class IpcServer {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  constructor(
    private readonly pipeName: string,
    private readonly authSecret: string,
    private readonly hello: Omit<BrokerHello, "protocolMajor" | "protocolMinor">,
    private readonly handler: BrokerHandler,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}
  async listen(): Promise<void> {
    if (this.platform !== "win32")
      await unlink(this.pipeName).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    else await this.assertPipeNameNotSquatted();
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.pipeName, resolve);
    });
    if (this.platform !== "win32") await chmod(this.pipeName, 0o600);
  }
  /**
   * Node's net.Server cannot set a DACL on a Windows named pipe (see docs/security.md), so a
   * lower-privileged process could pre-create ("squat") a pipe of the same name before the
   * broker starts and intercept the handshake. Best-effort mitigation: probe for an
   * already-listening endpoint first and refuse to start rather than silently binding behind it.
   * This narrows, but does not eliminate, the squatting window (TOCTOU between probe and listen);
   * the handshake secret plus strict schemas remain the primary defense — see docs/security.md
   * and docs/threat-model.md.
   */
  private async assertPipeNameNotSquatted(): Promise<void> {
    const alreadyListening = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(this.pipeName);
      const settle = (value: boolean) => {
        probe.removeAllListeners();
        probe.destroy();
        resolve(value);
      };
      probe.once("connect", () => settle(true));
      probe.once("error", () => settle(false));
    });
    if (alreadyListening)
      throw new DomainError(
        "BROKER_START_FAILED",
        "Another process is already listening on this named pipe.",
        false,
        { remediation: "Run: m365-agent broker restart" }
      );
  }
  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    for (const socket of this.sockets) socket.destroySoon();
    await closed;
    this.sockets.clear();
    if (this.platform !== "win32") await unlink(this.pipeName).catch(() => undefined);
  }
  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    let authenticated = false;
    let protocolMinor = 0;
    // Requests of this connection still running, so only this client can cancel them.
    const inFlight = new Map<string, AbortController>();
    const decoder = new FrameDecoder();
    socket.on("data", async (chunk: Buffer) => {
      try {
        for (const value of decoder.push(chunk)) {
          if (!authenticated) {
            const handshake = HandshakeSchema.parse(value);
            if (handshake.protocolMajor !== BROKER_PROTOCOL.major)
              throw new DomainError(
                "BROKER_VERSION_MISMATCH",
                "Broker protocol major versions are incompatible."
              );
            const supplied = Buffer.from(handshake.authSecret);
            const expected = Buffer.from(this.authSecret);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
              throw new DomainError("BROKER_AUTH_FAILED", "Broker authentication failed.");
            authenticated = true;
            protocolMinor = Math.min(BROKER_PROTOCOL.minor, handshake.protocolMinor);
            const capabilities = this.hello.capabilities.filter((capability) =>
              handshake.capabilities.includes(capability)
            );
            socket.write(
              encodeFrame({
                ok: true,
                hello: {
                  ...this.hello,
                  protocolMajor: BROKER_PROTOCOL.major,
                  protocolMinor,
                  capabilities
                }
              })
            );
            continue;
          }
          let envelope: z.infer<typeof IpcEnvelopeSchema>;
          try {
            envelope = IpcEnvelopeSchema.parse(value);
          } catch {
            const domain = new DomainError("BROKER_PROTOCOL_ERROR", "Malformed IPC request.");
            const rawId =
              value !== null &&
              typeof value === "object" &&
              typeof (value as { id?: unknown }).id === "string"
                ? (value as { id: string }).id
                : undefined;
            socket.write(
              encodeFrame(
                rawId !== undefined
                  ? { id: rawId, ok: false, error: domain.toResult(rawId).error }
                  : { ok: false, error: domain.toResult("protocol").error }
              )
            );
            continue;
          }
          let parsed: ReturnType<typeof parseMethod>;
          try {
            parsed = parseMethod(envelope.method, envelope.params);
          } catch (error) {
            const domain = asDomainError(error);
            socket.write(
              encodeFrame({ id: envelope.id, ok: false, error: domain.toResult(envelope.id).error })
            );
            continue;
          }
          if (parsed.method === "broker.cancel") {
            const target = inFlight.get(parsed.params.requestId as string);
            target?.abort();
            socket.write(encodeFrame({ id: envelope.id, ok: true, result: { cancelled: !!target } }));
            continue;
          }
          // Not awaited: a later frame of the same chunk -- a cancel above all -- must not wait
          // for this request, just as frames of later chunks already do not. dispatch() answers
          // every failure itself; anything else still ends only this connection.
          void this.dispatch(socket, envelope.id, parsed, inFlight, protocolMinor).catch(() =>
            socket.destroy()
          );
        }
      } catch (error) {
        const domain = asDomainError(error);
        socket.write(encodeFrame({ ok: false, error: domain.toResult("handshake").error }));
        socket.destroy();
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      // A client that went away no longer waits for anything it asked for.
      for (const controller of inFlight.values()) controller.abort();
    });
    socket.on("error", () => undefined);
  }

  private async dispatch(
    socket: net.Socket,
    id: string,
    parsed: ReturnType<typeof parseMethod>,
    inFlight: Map<string, AbortController>,
    protocolMinor: number
  ): Promise<void> {
    // Progress frames may be written on this socket, keyed to this request's id, any number of
    // times while the handler runs; they must never race or replace the final response. `settled`
    // is flipped only once that response has actually been written, so a handler that
    // (incorrectly) calls notify afterward is silently ignored rather than corrupting a later
    // request/response on the same connection.
    let settled = false;
    const notify: ProgressSink = (event) => {
      if (settled || socket.destroyed || !isProgressEvent(event)) return;
      socket.write(encodeFrame({ id, event: "progress", data: event }));
    };
    const controller = new AbortController();
    inFlight.set(id, controller);
    let response: IpcResponse;
    try {
      const result = await this.handler(parsed.method, parsed.params, id, notify, controller.signal, {
        protocolMinor
      });
      response = { id, ok: true, result };
    } catch (error) {
      const domain = asDomainError(error);
      response = { id, ok: false, error: domain.toResult(id).error };
    } finally {
      if (inFlight.get(id) === controller) inFlight.delete(id);
    }
    let frame: Buffer;
    try {
      frame = encodeFrame(response);
    } catch (error) {
      // A result that cannot be sent (e.g. over MAX_FRAME_BYTES) fails only its own request.
      frame = encodeFrame({ id, ok: false, error: asDomainError(error).toResult(id).error });
    }
    socket.write(frame);
    settled = true;
  }
}
