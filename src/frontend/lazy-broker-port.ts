import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FrontendBrokerPort } from "./broker-port.js";
import type { AskInput, AskResult, ListResult, SessionInput, SessionResult, ToolError } from "./schemas.js";
import { DomainError, asDomainError } from "../domain/errors.js";
import type { ProgressSink } from "../domain/progress.js";
import { appPaths } from "../config/paths.js";
import { restartBrokerIfStale, stalenessExpectationFrom } from "../services/broker-staleness.js";
import { readInstallJson, resolveInstallHome } from "../services/install-home.js";

const KNOWN_BROKER_CODES = [
  "BROKER_UNAVAILABLE",
  "BROKER_START_FAILED",
  "BROKER_VERSION_MISMATCH",
  "BROKER_AUTH_FAILED"
] as const;

/** §4.7 C13: called once, before this port's very first real broker connect (never on later
 * reconnects), to stop a broker left running from an older build/version so the connect that
 * follows spawns/talks to the current one instead. Metadata-only lines go to stderr -- stdout is
 * the MCP JSON-RPC stream (`src/frontend/mcp-server.ts`'s `serveStdio`) and must never carry
 * anything else. Never throws: a failure here must not prevent the real connect attempt that
 * follows it (the caller awaits this and discards any rejection). Exported as `BrokerStalenessCheck`
 * so a test can inject a fake instead of touching the real filesystem/`appPaths()`. */
export type BrokerStalenessCheck = () => Promise<void>;

/** `<home>/app/<version>/dist/broker/process.js` when `install.json` exists (§4.7 C13's "the
 * machine install's broker entry"), else this running tree's own sibling `dist/broker/process.js`
 * (resolved from this module's own compiled location, the same trick `spawnBundledBroker` in
 * `src/broker/broker-lifecycle.ts` uses, since `serve` may run from a checkout, an installed
 * package, or a staged `app/<version>` with no other reference point). `expected.packageVersion`
 * is set only in the machine-install case: `restartBrokerIfStale` compares it against the running
 * broker's own reported version instead of `stat()`-ing `brokerEntry` (see that field's doc
 * comment in `src/services/broker-staleness.ts` for why `serve` -- which does not stage anything
 * itself -- prefers the exact comparison over the mtime heuristic). */
export async function defaultBrokerStalenessCheck(): Promise<void> {
  const log = (line: string): void => {
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      /* best effort only; never let a failed write affect anything else */
    }
  };
  try {
    const paths = appPaths();
    const home = resolveInstallHome({ env: process.env, platform: process.platform, homedir: os.homedir() });
    const installJson = await readInstallJson(home).catch(() => undefined);
    const brokerEntry = installJson
      ? path.join(home, "app", installJson.version, "dist", "broker", "process.js")
      : fileURLToPath(new URL("../broker/process.js", import.meta.url));
    const expected = stalenessExpectationFrom(installJson);
    await restartBrokerIfStale({ paths, brokerEntry, log, ...(expected ? { expected } : {}) });
  } catch {
    // A staleness probe is a courtesy, not a precondition: `serve` must still try to connect.
  }
}

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
 *
 * §4.7 C13: before the very first real connect, `checkStaleness` (by default
 * `defaultBrokerStalenessCheck` above) runs once so a broker left running by an older build or
 * version is stopped before this `serve` process talks to it.
 */
export class LazyBrokerPort implements FrontendBrokerPort {
  private connecting?: Promise<FrontendBrokerPort>;
  private port?: FrontendBrokerPort;
  private closed = false;
  private staleCheckStarted = false;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly factory: (signal: AbortSignal) => Promise<FrontendBrokerPort>,
    private readonly checkStaleness: BrokerStalenessCheck = defaultBrokerStalenessCheck
  ) {}

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

  /** Runs `checkStaleness()` exactly once per port lifetime, before the first real connect
   * (never on a later reconnect after idle shutdown/restart -- the point is to catch a broker left
   * running from *before this process started*, not one this same process already talked to).
   * Swallows any rejection: a broken staleness probe must never block the connect it guards. */
  private async ensureNotStale(): Promise<void> {
    if (this.staleCheckStarted) return;
    this.staleCheckStarted = true;
    await this.checkStaleness().catch(() => undefined);
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
        .then(() => this.ensureNotStale())
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
