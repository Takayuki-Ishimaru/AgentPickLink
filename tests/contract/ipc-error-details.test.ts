import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testIpcEndpoint } from "../helpers/platform.js";
import { DomainError } from "../../src/domain/errors.js";
import { IpcClient } from "../../src/ipc/client.js";
import { BROKER_PROTOCOL, type BrokerDescriptor } from "../../src/ipc/protocol.js";
import { IpcServer } from "../../src/ipc/server.js";

async function makePipe(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  return testIpcEndpoint(directory, "broker.sock");
}

function makeDescriptor(pipe: string, secret: string, instanceId: string): BrokerDescriptor {
  return {
    pid: process.pid,
    pipeName: pipe,
    protocolMajor: BROKER_PROTOCOL.major,
    protocolMinor: BROKER_PROTOCOL.minor,
    packageVersion: "test",
    instanceId,
    authSecret: secret,
    createdAt: new Date().toISOString()
  };
}

/**
 * Item 1: `BrowserTransportError.details.callLog`/`.timedOut` (a redacted, size-bounded
 * Playwright launch call log -- see `src/transports/browser/browser-manager.ts`'s
 * `launchFailure`) is copied by `mapTransportError` into the `DomainError`'s own options
 * (src/transports/browser/browser-transport.ts) and must cross the broker's IPC wire intact so
 * the CLI/extension can append it to their own log file
 * (src/services/setup-controller.ts's `exclusive()`, prefixed `browser-log:`).
 */
describe("IPC error details: callLog/timedOut cross the wire", () => {
  it("reconstructs a DomainError on the client with the server's callLog/timedOut intact", async () => {
    const pipe = await makePipe("apl-ipc-error-details-");
    const secret = "t".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_error_details" },
      async () => {
        throw new DomainError(
          "BROWSER_START_FAILED",
          "The msedge browser did not start: Timeout 30000ms exceeded.",
          false,
          {
            callLog: ["<launching> [redacted-url]", "<launched> pid=4242", "[pid=4242][err] some line"],
            timedOut: true
          }
        );
      }
    );
    await server.listen();
    const client = new IpcClient(makeDescriptor(pipe, secret, "broker_error_details"));
    await client.connect();

    const error = await client
      .call("broker.health", {}, "req-error-details")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    const domain = error as DomainError;
    expect(domain.code).toBe("BROWSER_START_FAILED");
    expect(domain.options.callLog).toEqual([
      "<launching> [redacted-url]",
      "<launched> pid=4242",
      "[pid=4242][err] some line"
    ]);
    expect(domain.options.timedOut).toBe(true);

    client.close();
    await server.close();
  });

  it("omits callLog/timedOut on the client when the server never set them", async () => {
    const pipe = await makePipe("apl-ipc-error-details-absent-");
    const secret = "u".repeat(43);
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId: "broker_error_details_absent" },
      async () => {
        throw new DomainError("AUTH_REQUIRED", "Microsoft 365 sign-in is required.");
      }
    );
    await server.listen();
    const client = new IpcClient(makeDescriptor(pipe, secret, "broker_error_details_absent"));
    await client.connect();

    const error = await client
      .call("broker.health", {}, "req-error-details-absent")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    const domain = error as DomainError;
    expect(domain.options.callLog).toBeUndefined();
    expect(domain.options.timedOut).toBeUndefined();

    client.close();
    await server.close();
  });
});
