import net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameDecoder } from "./framing.js";
import type { BrokerDescriptor, BrokerHello, IpcProgressFrame, IpcResponse } from "./protocol.js";
import { BROKER_CAPABILITIES, BROKER_PROTOCOL } from "./protocol.js";
import { DomainError } from "../domain/errors.js";
import type { ProgressSink } from "../domain/progress.js";
export class IpcClient {
  private socket?: net.Socket;
  private readonly waiting = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      cleanup(): void;
      onProgress?: ProgressSink;
    }
  >();
  private hello?: BrokerHello;
  /** Coalesces simultaneous callers during the handshake. Without this, concurrent `call()`s
   * could replace `this.socket` with a second connection while the first was still authenticating. */
  private connecting?: Promise<BrokerHello>;
  private connectingReject?: (error: unknown) => void;
  /** Invalidates listeners from a socket that has been closed or replaced. */
  private connectionGeneration = 0;
  constructor(
    private readonly descriptor: BrokerDescriptor,
    private readonly packageVersion = "0.1.3",
    private readonly capabilities: readonly string[] = BROKER_CAPABILITIES
  ) {}
  isConnected(): boolean {
    return !!this.socket && !this.socket.destroyed && !!this.hello;
  }
  async connect(timeoutMs = 5000): Promise<BrokerHello> {
    if (this.isConnected()) return this.hello!;
    if (this.connecting) return this.connecting;
    if (this.descriptor.protocolMajor !== BROKER_PROTOCOL.major)
      throw new DomainError(
        "BROKER_VERSION_MISMATCH",
        "Broker protocol major versions are incompatible.",
        false,
        { remediation: "Run: m365-agent broker restart" }
      );
    const socket = net.createConnection(this.descriptor.pipeName);
    const generation = ++this.connectionGeneration;
    this.socket = socket;
    this.hello = undefined;
    const decoder = new FrameDecoder();
    const connecting = new Promise<BrokerHello>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        const wasSettled = settled;
        if (!wasSettled) {
          settled = true;
          clearTimeout(timer);
        }
        if (this.connectionGeneration === generation) {
          this.socket = undefined;
          this.hello = undefined;
          this.rejectWaiting();
        }
        socket.destroy();
        if (!wasSettled)
          reject(
            error instanceof DomainError
              ? error
              : new DomainError("BROKER_UNAVAILABLE", "The broker IPC endpoint is unavailable.", true)
          );
      };
      this.connectingReject = fail;
      const timer = setTimeout(
        () => fail(new DomainError("BROKER_UNAVAILABLE", "Broker handshake timed out.", true)),
        timeoutMs
      );
      socket.on("error", fail);
      socket.on("close", () => {
        // A reconnect may have replaced this socket before the old one emits `close`; stale
        // events must not reject requests belonging to the new connection.
        if (this.connectionGeneration !== generation) return;
        this.socket = undefined;
        this.hello = undefined;
        this.rejectWaiting();
        fail(new DomainError("BROKER_UNAVAILABLE", "Broker connection closed.", true));
      });
      socket.on("data", (chunk) => {
        if (this.connectionGeneration !== generation || this.socket !== socket) return;
        try {
          for (const message of decoder.push(chunk)) {
            const value = message as {
              ok?: boolean;
              hello?: BrokerHello;
              error?: { code: string; message: string; retryable?: boolean; remediation?: string };
            };
            if (value.ok && value.hello) {
              settled = true;
              clearTimeout(timer);
              this.hello = value.hello;
              resolve(value.hello);
            } else if (value.error && !Object.hasOwn(value, "id")) {
              // An id-less error can only be correlated to the handshake (pre-hello) or is a
              // per-message protocol error the server could not attach a request id to (post-hello,
              // e.g. a malformed envelope with no usable id). In the latter case it names no specific
              // waiter, so it must not reject unrelated in-flight calls or tear down the connection.
              const domain = new DomainError(
                value.error.code as never,
                value.error.message,
                !!value.error.retryable,
                { remediation: value.error.remediation }
              );
              if (!this.hello) fail(domain);
            } else if (
              (value as { event?: unknown }).event === "progress" &&
              typeof (value as { id?: unknown }).id === "string"
            )
              this.receiveProgress(message as IpcProgressFrame);
            else if ((message as IpcResponse).id) this.receive(message as IpcResponse);
          }
        } catch (error) {
          fail(error);
        }
      });
      socket.once("connect", () => {
        socket.write(
          encodeFrame({
            type: "hello",
            authSecret: this.descriptor.authSecret,
            protocolMajor: BROKER_PROTOCOL.major,
            protocolMinor: BROKER_PROTOCOL.minor,
            packageVersion: this.packageVersion,
            capabilities: [...new Set(this.capabilities)]
          }),
          (error) => {
            if (error) fail(error);
          }
        );
      });
    });
    this.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.connecting === connecting) {
        this.connecting = undefined;
        this.connectingReject = undefined;
      }
    }
  }
  async call(
    method: string,
    params: unknown,
    requestId = randomUUID(),
    signal?: AbortSignal,
    options?: { onProgress?: ProgressSink }
  ): Promise<unknown> {
    if (!this.isConnected()) await this.connect();
    if (signal?.aborted)
      throw new DomainError(
        "SUBMIT_FAILED",
        "The request was cancelled before it was sent to the broker.",
        false,
        { submissionState: "not-sent" }
      );
    if (this.waiting.has(requestId))
      throw new DomainError("BROKER_PROTOCOL_ERROR", "A broker request with this ID is already pending.");
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        const waiter = this.waiting.get(requestId);
        if (!waiter) return;
        this.waiting.delete(requestId);
        waiter.cleanup();
        reject(
          new DomainError(
            "SUBMIT_STATE_UNKNOWN",
            "The caller stopped waiting after the broker request was sent.",
            false,
            {
              submissionState: "unknown",
              remediation: "Inspect the existing conversation before deciding whether to send again."
            }
          )
        );
      };
      this.waiting.set(requestId, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
        onProgress: options?.onProgress
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.socket!.write(encodeFrame({ id: requestId, method, params }), (error) => {
        if (error) {
          const waiter = this.waiting.get(requestId);
          this.waiting.delete(requestId);
          waiter?.cleanup();
          reject(new DomainError("BROKER_UNAVAILABLE", "The broker request could not be written.", true));
        }
      });
    });
  }
  close(): void {
    const cancel = this.connectingReject;
    this.connectionGeneration += 1;
    this.connecting = undefined;
    this.connectingReject = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.hello = undefined;
    this.rejectWaiting();
    cancel?.(new DomainError("BROKER_UNAVAILABLE", "Broker connection closed.", true));
  }
  private rejectWaiting(
    error = new DomainError("BROKER_UNAVAILABLE", "Broker connection closed.", true)
  ): void {
    for (const waiter of this.waiting.values()) {
      waiter.cleanup();
      waiter.reject(error);
    }
    this.waiting.clear();
  }
  /** A progress frame for a still-pending, known waiter invokes its onProgress sink (never
   * settling the waiter); a frame for an unknown/already-settled id is silently ignored, and a
   * throwing sink can never break the call it is reporting progress for. */
  private receiveProgress(frame: IpcProgressFrame): void {
    const waiter = this.waiting.get(frame.id);
    if (!waiter?.onProgress) return;
    try {
      waiter.onProgress(frame.data);
    } catch {
      /* progress sinks must never break the underlying call */
    }
  }

  private receive(message: IpcResponse): void {
    const waiter = this.waiting.get(message.id);
    if (!waiter) return;
    this.waiting.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else
      waiter.reject(
        new DomainError(message.error.code as never, message.error.message, message.error.retryable, {
          remediation: message.error.remediation,
          submissionState: message.error.submissionState,
          partialResponse: message.error.partialResponse as never,
          retryAfterMs: message.error.retryAfterMs
        })
      );
  }
}
