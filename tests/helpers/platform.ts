import { createHash } from "node:crypto";
import path from "node:path";

/** Isolated transport address: real named pipes on Windows, Unix sockets elsewhere. */
export function testIpcEndpoint(directory: string, name = "broker.sock"): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\apl-test-${createHash("sha256").update(path.join(directory, name)).digest("hex").slice(0, 24)}`
    : path.join(directory, name);
}
