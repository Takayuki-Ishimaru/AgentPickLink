import type { FrontendBrokerPort } from "./broker-port.js";
import type { AskInput, AskResult, ListResult, SessionInput, SessionResult, ToolError } from "./schemas.js";
import { DomainError, asDomainError } from "../domain/errors.js";
import type { ProgressSink } from "../domain/progress.js";

const KNOWN_BROKER_CODES = [
  "BROKER_UNAVAILABLE",
  "BROKER_START_FAILED",
  "BROKER_VERSION_MISMATCH",
  "BROKER_AUTH_FAILED"
] as const;

/**
 * Wraps a `() => Promise<FrontendBrokerPort>` factory so the underlying broker
 * connection (spawning/handshaking with the broker process) happens lazily, on
 * the first tool call, rather than blocking `serve` startup before the MCP
 * stdio transport is even listening. A successful connection is memoised and
 * reused by every later call. A failed connection is NOT memoised: the next
 * call retries the factory, since the broker may become reachable afterward
 * (e.g. the user runs `m365-agent broker restart`). Factory failures never
 * throw out of list/ask/session -- they are converted into a structured
 * ToolError (BROKER_UNAVAILABLE, or the more specific broker code the factory
 * failed with) so the frontend always returns the normal error envelope.
 */
export class LazyBrokerPort implements FrontendBrokerPort {
  private connecting?: Promise<FrontendBrokerPort>;
  private port?: FrontendBrokerPort;
  private closed = false;
  private readonly lifetime = new AbortController();

  constructor(private readonly factory: (signal: AbortSignal) => Promise<FrontendBrokerPort>) {}

  async list(
    workspaceRoot: string,
    requestId: string,
    signal?: AbortSignal
  ): Promise<ListResult | ToolError> {
    return this.delegate(requestId, (port) => port.list(workspaceRoot, requestId, signal));
  }
  async ask(
    workspaceRoot: string,
    input: AskInput,
    requestId: string,
    signal?: AbortSignal,
    onProgress?: ProgressSink
  ): Promise<AskResult | ToolError> {
    return this.delegate(requestId, (port) => port.ask(workspaceRoot, input, requestId, signal, onProgress));
  }
  async session(
    workspaceRoot: string,
    input: SessionInput,
    requestId: string,
    signal?: AbortSignal,
    onProgress?: ProgressSink
  ): Promise<SessionResult | ToolError> {
    return this.delegate(requestId, (port) =>
      port.session(workspaceRoot, input, requestId, signal, onProgress)
    );
  }
  async health(requestId: string): Promise<Record<string, unknown> | ToolError> {
    return this.delegate(requestId, (port) =>
      port.health ? port.health(requestId) : Promise.resolve({ live: false })
    );
  }

  /** True once a broker connection has actually been established (used to decide whether there is a client to close on shutdown). */
  isConnected(): boolean {
    return !!this.port && this.port.isConnected?.() !== false;
  }

  close(): void {
    this.closed = true;
    this.lifetime.abort();
    this.port?.close?.();
    this.port = undefined;
    this.connecting = undefined;
  }

  private async delegate<T>(
    requestId: string,
    use: (port: FrontendBrokerPort) => Promise<T | ToolError>
  ): Promise<T | ToolError> {
    let port: FrontendBrokerPort;
    try {
      port = await this.connect();
      if (this.closed) throw new DomainError("BROKER_UNAVAILABLE", "The MCP frontend has closed.");
    } catch (error) {
      return toBrokerError(error, requestId);
    }
    return use(port);
  }

  private connect(): Promise<FrontendBrokerPort> {
    if (this.closed)
      return Promise.reject(new DomainError("BROKER_UNAVAILABLE", "The MCP frontend has closed."));
    // Reconnect before a new call after broker idle shutdown/restart. Never replay a submitted call.
    if (this.port?.isConnected?.() === false) {
      this.port.close?.();
      this.port = undefined;
      this.connecting = undefined;
    }
    if (!this.connecting) {
      const attempt = Promise.resolve()
        .then(() => {
          this.lifetime.signal.throwIfAborted();
          return this.factory(this.lifetime.signal);
        })
        .then((port) => {
          // stdin can close while startup/handshake is still in flight.
          if (this.closed) {
            port.close?.();
            throw new DomainError("BROKER_UNAVAILABLE", "The MCP frontend has closed.");
          }
          this.port = port;
          return port;
        })
        .catch((error: unknown) => {
          // Do not keep serving this failure forever: let the next call retry the factory.
          if (this.connecting === attempt) this.connecting = undefined;
          throw error;
        });
      this.connecting = attempt;
    }
    return this.connecting;
  }
}

function toBrokerError(error: unknown, requestId: string): ToolError {
  const domain = error instanceof DomainError ? error : asDomainError(error);
  if ((KNOWN_BROKER_CODES as readonly string[]).includes(domain.code))
    return domain.toResult(requestId).error;
  const fallback = new DomainError(
    "BROKER_UNAVAILABLE",
    domain.message || "The local Microsoft 365 broker is unavailable.",
    true,
    { remediation: "Run: m365-agent broker status" }
  );
  return fallback.toResult(requestId).error;
}
