/**
 * v0.2.3 re-evaluation, finding A: `doctor` must close the broker connection it holds, and still
 * return its normal report, whatever the broker RPCs do. The connection used to be closed only
 * after every RPC had succeeded, so `doctor --auth` printed BROWSER_START_FAILED and then never
 * exited: the open IPC socket kept the CLI process alive.
 */
import { mkdtemp } from "node:fs/promises";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliApi } from "../../src/cli/api.js";
import { runDoctor } from "../../src/cli/commands/doctor.js";
import { buildProgram } from "../../src/cli/index.js";
import { DomainError } from "../../src/domain/errors.js";
import type { ErrorCode } from "../../src/frontend/schemas.js";
import { IpcClient } from "../../src/ipc/client.js";
import { BROKER_PROTOCOL, type BrokerDescriptor } from "../../src/ipc/protocol.js";
import { IpcServer } from "../../src/ipc/server.js";
import { brokerLogPath } from "../../src/observability/broker-log.js";
import { HealthService } from "../../src/services/health-service.js";
import { testIpcEndpoint } from "../helpers/platform.js";
import { makeCommandDeps, makeTempPaths } from "./helpers.js";

const originalExit = process.exitCode;
afterEach(() => {
  process.exitCode = originalExit;
  vi.restoreAllMocks();
});

/** A scripted broker that counts `close()` calls; a function answer runs on each call and may throw. */
function countingBroker(answers: Record<string, unknown>) {
  const broker = {
    closeCalls: 0,
    methods: [] as string[],
    async call(method: string): Promise<unknown> {
      broker.methods.push(method);
      const answer = answers[method];
      return typeof answer === "function" ? (answer as () => unknown)() : (answer ?? {});
    },
    close(): void {
      broker.closeCalls += 1;
    }
  };
  return broker;
}

function rejectWith(code: ErrorCode, message: string, retryable = false, timedOut?: boolean): () => never {
  return () => {
    throw new DomainError(code, message, retryable, timedOut ? { timedOut } : undefined);
  };
}

describe("doctor closes the broker connection whatever its RPCs do", () => {
  it.each([
    {
      name: "broker.health fails",
      answers: { "broker.health": rejectWith("BROKER_PROTOCOL_ERROR", "health failed") },
      options: {},
      item: "broker",
      recorded: { live: true, descriptorPresent: true, error: { code: "BROKER_PROTOCOL_ERROR" } },
      finding: "broker.error"
    },
    {
      name: "browser.authState cannot start the browser",
      answers: {
        "browser.authState": rejectWith("BROWSER_START_FAILED", "The msedge browser could not be started.")
      },
      options: { auth: true },
      item: "authentication",
      recorded: { code: "BROWSER_START_FAILED" },
      finding: "authentication.error"
    },
    {
      name: "agent.validate fails",
      answers: { "agent.validate": rejectWith("AGENT_NOT_FOUND", "No such agent.") },
      options: { agent: "requirements" },
      item: "agent",
      recorded: { code: "AGENT_NOT_FOUND" },
      finding: "agent.error"
    },
    {
      name: "agent.validate times out in the broker",
      answers: { "agent.validate": rejectWith("RESPONSE_TIMEOUT", "Timed out.", true, true) },
      options: { agent: "requirements" },
      item: "agent",
      recorded: { code: "RESPONSE_TIMEOUT", retryable: true },
      finding: "agent.error"
    },
    {
      name: "the connection drops during browser.authState",
      answers: { "browser.authState": rejectWith("BROKER_UNAVAILABLE", "Broker connection closed.", true) },
      options: { auth: true },
      item: "authentication",
      recorded: { code: "BROKER_UNAVAILABLE", retryable: true },
      finding: "authentication.error"
    }
  ])("$name: closed once, the failure recorded on its item, ok:false", async (scenario) => {
    const paths = await makeTempPaths();
    const broker = countingBroker(scenario.answers);
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps, scenario.options);

    expect(broker.closeCalls).toBe(1);
    expect(result[scenario.item]).toMatchObject(scenario.recorded);
    expect(result.ok).toBe(false);
    expect(result.findings).toContain(scenario.finding);
  });

  it("control: a successful auth probe also closes the connection exactly once, without an auth finding", async () => {
    const paths = await makeTempPaths();
    const broker = countingBroker({ "browser.authState": { state: "authenticated" } });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps, { auth: true });

    expect(broker.closeCalls).toBe(1);
    expect(result.authentication).toEqual({ state: "authenticated" });
    expect((result.findings as string[]).filter((item) => /^(authentication|broker)\./.test(item))).toEqual(
      []
    );
  });

  it("a failed broker.health does not stop the requested probes that follow it", async () => {
    const paths = await makeTempPaths();
    const broker = countingBroker({
      "broker.health": rejectWith("BROKER_PROTOCOL_ERROR", "health failed"),
      "browser.authState": { state: "authenticated" },
      "agent.validate": rejectWith("AGENT_NOT_FOUND", "No such agent.")
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });

    const result = await runDoctor(deps, { auth: true, agent: "requirements" });

    expect(broker.methods).toEqual(["broker.health", "browser.authState", "agent.validate"]);
    expect(broker.closeCalls).toBe(1);
    expect(result.authentication).toEqual({ state: "authenticated" });
    expect(result.findings).toEqual(expect.arrayContaining(["broker.error", "agent.error"]));
    expect(result.findings).not.toContain("authentication.error");
  });

  it("closes a broker it had to start itself when the auth probe fails", async () => {
    const paths = await makeTempPaths();
    const started = countingBroker({
      "browser.authState": rejectWith("BROWSER_START_FAILED", "The msedge browser could not be started.")
    });
    const { deps } = makeCommandDeps({
      paths,
      connectExistingBroker: async () => undefined,
      connectOrStartDefaultBroker: async () => started as never
    });
    vi.spyOn(HealthService.prototype, "localReport").mockResolvedValue({ topologyReady: true, checks: {} });

    const result = await runDoctor(deps, { auth: true });

    expect(started.closeCalls).toBe(1);
    expect(result.broker).toMatchObject({ live: false });
    expect(result.authentication).toMatchObject({ code: "BROWSER_START_FAILED" });
    expect(result.brokerLog).toMatchObject({ path: brokerLogPath(paths.logs) });
  });

  it("CLI: `doctor --auth --json` prints the report with brokerLog and exits 1, not a bare error with exit 2", async () => {
    const paths = await makeTempPaths();
    const broker = countingBroker({
      "browser.authState": rejectWith("BROWSER_START_FAILED", "The msedge browser could not be started.")
    });
    const { deps } = makeCommandDeps({ paths, connectExistingBroker: async () => broker as never });
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    const api = {
      doctor: (options: { auth?: boolean; agent?: string }) => runDoctor(deps, options)
    } as CliApi;

    await buildProgram(api).parseAsync(["node", "apl", "doctor", "--auth", "--json"]);

    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      ok: false,
      authentication: { code: "BROWSER_START_FAILED" },
      brokerLog: { path: brokerLogPath(paths.logs) }
    });
    expect(report.findings).toContain("authentication.error");
    expect(process.exitCode).toBe(1);
    expect(broker.closeCalls).toBe(1);
  });
});

describe("doctor over a real broker socket", () => {
  function descriptorFor(pipe: string, secret: string, instanceId: string): BrokerDescriptor {
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

  it("releases the connection after browser.authState fails with BROWSER_START_FAILED", async () => {
    const pipe = testIpcEndpoint(await mkdtemp(path.join(os.tmpdir(), "apl-doctor-ipc-")), "broker.sock");
    const secret = "d".repeat(43);
    const instanceId = "broker_doctor_release";
    const server = new IpcServer(
      pipe,
      secret,
      { packageVersion: "test", capabilities: [], instanceId },
      async (method) => {
        if (method === "browser.authState")
          throw new DomainError(
            "BROWSER_START_FAILED",
            "The msedge browser could not be started: its executable was not found.",
            false
          );
        return {};
      }
    );
    await server.listen();
    // The server's accepted sockets: one per connected client, removed on the socket's `close`.
    const accepted = (server as unknown as { sockets: Set<net.Socket> }).sockets;
    let client: IpcClient | undefined;
    try {
      const paths = await makeTempPaths();
      const { deps } = makeCommandDeps({
        paths,
        connectExistingBroker: async () => {
          client = new IpcClient(descriptorFor(pipe, secret, instanceId));
          await client.connect();
          return client;
        }
      });

      const result = await runDoctor(deps, { auth: true });

      expect(result.authentication).toMatchObject({ code: "BROWSER_START_FAILED" });
      expect(result.findings).toContain("authentication.error");
      expect(client?.isConnected()).toBe(false);
      await vi.waitFor(() => expect(accepted.size).toBe(0), { timeout: 2_000 });
    } finally {
      client?.close();
      await server.close();
    }
  });
});
