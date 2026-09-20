/**
 * A dependency-free stdio MCP client used only to *verify* that a spawned command speaks MCP: the
 * install verify step (WP-C/WP-B) and `scripts/smoke-package.mjs` both need this, and neither may
 * pull in `@modelcontextprotocol/client` as a runtime dependency (it stays a devDependency used
 * only by the smoke script today). §4.6 ("shared handshake module").
 *
 * Speaks the same newline-delimited JSON-RPC framing `@modelcontextprotocol/server`'s stdio
 * transport uses (confirmed by reading `node_modules/@modelcontextprotocol/server/dist/stdio.mjs`:
 * `ReadBuffer`/`serializeMessage` split on `\n`, no `Content-Length` framing) -- so this never has
 * to import the SDK. It sends `initialize`, then `notifications/initialized`, then `tools/list`,
 * and never logs stdout content: lines that fail to parse as JSON are silently ignored, matching
 * `ReadBuffer.readMessage`'s own behaviour.
 */
import { spawn } from "node:child_process";
import { DomainError } from "../domain/errors.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "agentpicklink-install";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Applied independently to the accumulated stdout line buffer and to captured stderr: a
 * well-behaved MCP server never gets close to this during the opening handshake, so exceeding it
 * means something is malformed (or hostile) rather than merely slow. */
const MAX_BUFFER_BYTES = 1024 * 1024;
/** Grace period after SIGTERM before escalating to SIGKILL. */
const KILL_GRACE_MS = 2_000;

export type McpHandshakeOptions = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
};

export type McpHandshakeResult = {
  serverName: string;
  serverVersion: string;
  tools: string[];
  instructionsPresent: boolean;
  /** Everything the child wrote to stderr during the handshake (diagnostic only). */
  stderr: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type PendingCall = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/** Terminates the handshake's child process without ever making the CLI wait on it: SIGTERM first,
 * escalating to SIGKILL after `KILL_GRACE_MS` for a server that ignores SIGTERM, and `unref()`d
 * throughout so neither the child itself nor the escalation timer keeps the event loop alive. */
function terminateChild(child: ReturnType<typeof spawn>): void {
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  if (!alreadyExited) {
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    forceKill.unref();
    child.once("exit", () => clearTimeout(forceKill));
  }
  child.unref();
}

/**
 * Spawns `command`, performs the MCP opening handshake (`initialize` -> `notifications/initialized`
 * -> `tools/list`), and always kills the child afterwards (success, failure, or timeout).
 */
export async function mcpHandshake(opts: McpHandshakeOptions): Promise<McpHandshakeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  // An EPIPE writing to stdin after the child has already exited (e.g. it died between
  // `initialize` and `tools/list`) would otherwise surface as an uncaught 'error' event on the
  // stream -- there is a DomainError for that case already (`exitedEarly`, below); this only
  // silences the raw stream-level symptom so that DomainError is what callers actually see.
  child.stdin?.on("error", () => undefined);

  let protocolErrorReject!: (error: unknown) => void;
  const protocolError = new Promise<never>((_resolve, reject) => {
    protocolErrorReject = reject;
  });
  protocolError.catch(() => undefined);

  let stderr = "";
  let stderrOverLimit = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrOverLimit) return;
    stderr += chunk.toString("utf8");
    if (stderr.length > MAX_BUFFER_BYTES) {
      stderrOverLimit = true;
      protocolErrorReject(
        new DomainError(
          "BROKER_PROTOCOL_ERROR",
          `${opts.command} wrote more than ${MAX_BUFFER_BYTES} bytes to stderr during the MCP handshake.`
        )
      );
    }
  });

  const pending = new Map<string, PendingCall>();
  let nextId = 1;
  let buffer = "";
  let stdoutOverLimit = false;

  const send = (message: Record<string, unknown>): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };

  const call = (method: string, params: unknown): Promise<unknown> => {
    const id = String(nextId);
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };

  const notify = (method: string): void => {
    send({ jsonrpc: "2.0", method });
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdoutOverLimit) return;
    buffer += chunk.toString("utf8");
    if (buffer.length > MAX_BUFFER_BYTES) {
      stdoutOverLimit = true;
      buffer = "";
      protocolErrorReject(
        new DomainError(
          "BROKER_PROTOCOL_ERROR",
          `${opts.command} sent more than ${MAX_BUFFER_BYTES} bytes without a newline during the MCP handshake.`
        )
      );
      return;
    }
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        // Never surfaced: matches ReadBuffer.readMessage's own "skip unparsable lines" behaviour,
        // and this must never log stdout content.
        continue;
      }
      const record = asRecord(message);
      if (!record || record.id === undefined) continue;
      const waiter = pending.get(String(record.id));
      if (!waiter) continue;
      pending.delete(String(record.id));
      if ("error" in record) {
        const error = asRecord(record.error);
        waiter.reject(new Error(typeof error?.message === "string" ? error.message : "MCP error response"));
      } else {
        waiter.resolve(record.result);
      }
    }
  });

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new DomainError(
          "RESPONSE_TIMEOUT",
          `MCP handshake with ${opts.command} timed out after ${timeoutMs}ms.`,
          true
        )
      );
    }, timeoutMs);
  });
  timedOut.catch(() => undefined);

  const exitedEarly = new Promise<never>((_resolve, reject) => {
    child.once("error", (error) => {
      reject(new DomainError("BROKER_START_FAILED", `Could not start ${opts.command}: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      reject(
        new DomainError(
          "BROKER_START_FAILED",
          `${opts.command} exited before the MCP handshake completed (code=${code ?? "null"}, signal=${signal ?? "null"}).`
        )
      );
    });
  });
  exitedEarly.catch(() => undefined);

  try {
    const initializeResult = asRecord(
      await Promise.race([
        call("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: "0.0.0" }
        }),
        timedOut,
        exitedEarly,
        protocolError
      ])
    );
    notify("notifications/initialized");
    const toolsResult = asRecord(
      await Promise.race([call("tools/list", {}), timedOut, exitedEarly, protocolError])
    );

    const serverInfo = asRecord(initializeResult?.serverInfo);
    const instructions = initializeResult?.instructions;
    const toolsValue = toolsResult?.tools;
    const tools = Array.isArray(toolsValue)
      ? toolsValue
          .map((tool) => asRecord(tool)?.name)
          .filter((name): name is string => typeof name === "string")
      : [];

    return {
      serverName: typeof serverInfo?.name === "string" ? serverInfo.name : "",
      serverVersion: typeof serverInfo?.version === "string" ? serverInfo.version : "",
      tools,
      instructionsPresent: typeof instructions === "string" && instructions.length > 0,
      stderr
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    terminateChild(child);
  }
}
