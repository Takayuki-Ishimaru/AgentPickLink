/** Single-session loopback transport. Tokens and request bodies never enter diagnostics. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseWebviewMessage, type WebviewMessage } from "../../services/setup-protocol.js";

export const SETUP_LIFETIME_MS = 15 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;
export type SetupServer = {
  /** Display only to the initiating terminal or browser; never log or persist. */
  url: string;
  active(): boolean;
  send(message: unknown): void;
  close(): Promise<void>;
};
export type SetupServerOptions = {
  mediaDirectory: string;
  onMessage(message: WebviewMessage): Promise<void>;
  onExpired(): void;
  /** Test clock seam. Production always uses the hard fifteen-minute deadline. */
  schedule?: (expire: () => void, ms: number) => () => void;
};

export async function startSetupServer(options: SetupServerOptions): Promise<SetupServer> {
  const [script, shim, css, standaloneCss] = await Promise.all(
    ["setup.js", "setup-browser.js", "setup.css", "setup-standalone.css"].map((name) =>
      readFile(path.join(options.mediaDirectory, name), "utf8")
    )
  );
  let pathToken: string | undefined = randomBytes(32).toString("hex");
  const session = randomBytes(32).toString("hex");
  const nonce = randomBytes(24).toString("base64");
  let active = true;
  let events: ServerResponse | undefined;
  let latest: unknown;
  let origin = "";
  let host = "";
  let busy = false;
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  };
  const reply = (res: ServerResponse, status: number, body = ""): void => {
    res.writeHead(status, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
    res.end(body);
  };
  const authorized = (req: IncomingMessage): boolean => {
    const value = req.headers["x-apl-session"];
    return (
      typeof value === "string" &&
      /^[a-f0-9]{64}$/.test(value) &&
      timingSafeEqual(Buffer.from(value), Buffer.from(session))
    );
  };
  const send = (message: unknown): void => {
    latest = message;
    if (events && !events.write(`data: ${JSON.stringify(message)}\n\n`)) {
      // Bound memory even when a token holder stops reading the event stream.
      events.destroy();
      events = undefined;
    }
  };
  const server = createServer((req, res) => {
    void (async () => {
      if (!active) return reply(res, 410);
      const hostCount = req.rawHeaders.filter(
        (value, index) => index % 2 === 0 && value.toLowerCase() === "host"
      ).length;
      if (hostCount !== 1 || req.headers.host !== host) return reply(res, 403);
      if (req.method === "OPTIONS") return reply(res, 403);
      if (req.headers.origin !== undefined && req.headers.origin !== origin) return reply(res, 403);
      if (req.method === "GET" && pathToken && req.url === `/s/${pathToken}`) {
        pathToken = undefined; // Consume before any asynchronous work or response write.
        res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
        const safeScript = (value: string): string => value.replace(/<\/script/gi, "<\\/script");
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AgentPickLink</title><style nonce="${nonce}">${css}\n${standaloneCss}</style></head><body><div id="terminal-notice" role="status"></div><div id="app"></div><script nonce="${nonce}">window.aplSession=${JSON.stringify(session)};\n${safeScript(shim)}\n${safeScript(script)}</script></body></html>`
        );
        return;
      }
      if (!authorized(req)) return reply(res, 403);
      if (req.method === "GET" && req.url === "/events") {
        if (events) return reply(res, 409);
        res.writeHead(200, {
          ...headers,
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive"
        });
        events = res;
        res.write(": connected\n\n");
        res.on("close", () => {
          if (events === res) events = undefined;
        });
        if (latest !== undefined) send(latest);
        return;
      }
      if (req.method !== "POST" || req.url !== "/message") return reply(res, 404);
      if (req.headers.origin !== origin || req.headers["content-type"] !== "application/json")
        return reply(res, 403);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) return reply(res, 413);
        chunks.push(Buffer.from(chunk));
      }
      if (!active) return reply(res, 410);
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(res, 400);
      }
      const message = parseWebviewMessage(parsed);
      if (!message) return reply(res, 400);
      const cancellation = message.type === "cancelDiscovery" || message.type === "cancelSignIn";
      if (busy && !cancellation) return reply(res, 409);
      if (!cancellation) busy = true;
      try {
        await options.onMessage(message);
        reply(res, 204);
      } finally {
        if (!cancellation) busy = false;
      }
    })().catch(() => {
      if (!res.headersSent) reply(res, 500);
      else res.end();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Setup server did not bind.");
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  let cancelDeadline = (): void => {};
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      active = false;
      pathToken = undefined;
      latest = undefined;
      cancelDeadline();
      events?.end();
      events = undefined;
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  const schedule =
    options.schedule ??
    ((expire, ms) => {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    });
  cancelDeadline = schedule(() => {
    void close();
    options.onExpired();
  }, SETUP_LIFETIME_MS);
  return { url: `${origin}/s/${pathToken}`, active: () => active, send, close };
}
