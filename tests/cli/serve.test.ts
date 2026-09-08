import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/cli/index.js";
import { printResult, type CliApi, type CliContext } from "../../src/cli/api.js";
import { runServe } from "../../src/cli/commands/serve.js";
import { makeCommandDeps, makeFakeBrokerClient, makeTempPaths } from "./helpers.js";

const api = (overrides: Partial<CliApi> = {}): CliApi => {
  const done = async () => ({ ok: true });
  return {
    init: done,
    login: done,
    logout: done,
    doctor: done,
    broker: done,
    agentAdd: done,
    agentRemove: done,
    agentList: async () => ({ agents: [] }),
    agentTest: done,
    workspaceConfigure: done,
    workspaceList: done,
    workspaceValidate: done,
    workspaceApprove: done,
    workspaceApprovalStatus: done,
    workspaceRevoke: done,
    serve: async () => undefined,
    ...overrides
  };
};

describe("serve never corrupts the stdio transport", () => {
  it("writes nothing to stdout when api.serve() resolves undefined", async () => {
    const out: string[] = [];
    const errors: string[] = [];
    const program = buildProgram(api());
    // buildProgram wires context() from program options at action time; drive it through the
    // real CLI parse path so this exercises exactly what a user invoking `m365-agent serve` runs.
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalErrorWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await program.parseAsync(["node", "m365-agent", "serve"]);
    } finally {
      process.stdout.write = originalWrite;
      process.stderr.write = originalErrorWrite;
    }
    expect(out).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("reports a serve() rejection on stderr without printing to stdout", async () => {
    const out: string[] = [];
    const errors: string[] = [];
    const program = buildProgram(
      api({
        serve: async () => {
          throw new Error("broker unavailable");
        }
      })
    );
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalErrorWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await program.parseAsync(["node", "m365-agent", "serve"]);
    } finally {
      process.stdout.write = originalWrite;
      process.stderr.write = originalErrorWrite;
    }
    expect(out).toEqual([]);
    expect(errors.join("")).toContain("broker unavailable");
  });

  it("printResult(context, undefined) writes nothing regardless of --json", () => {
    const out: string[] = [];
    const errors: string[] = [];
    const context: CliContext = {
      workspaceRoot: "/repo",
      json: false,
      yes: false,
      out: (s) => out.push(s),
      error: (s) => errors.push(s),
      api: api()
    };
    printResult(context, undefined);
    printResult({ ...context, json: true }, undefined);
    expect(out).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("runServe", () => {
  it("does not start a broker when stdin closes during local profile preparation", async () => {
    const paths = await makeTempPaths();
    let finish!: (value: typeof paths) => void;
    let entered!: () => void;
    const initializing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const initializeLocalState = vi.fn(
      () =>
        new Promise<typeof paths>((resolve) => {
          finish = resolve;
          entered();
        })
    );
    const connectOrStartDefaultBroker = vi.fn();
    let pending!: Promise<unknown>;
    const { deps } = makeCommandDeps({
      paths,
      initializeLocalState,
      connectOrStartDefaultBroker,
      serveStdio: async (port) => {
        pending = port.list("/repo", "closing");
        await initializing;
      }
    });
    await runServe(deps);
    finish(paths);
    await expect(pending).resolves.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    expect(connectOrStartDefaultBroker).not.toHaveBeenCalled();
  });

  it("does no profile initialization or broker startup when a workspace only opens MCP", async () => {
    const initializeLocalState = vi.fn();
    const connectOrStartDefaultBroker = vi.fn();
    const { deps } = makeCommandDeps({
      paths: await makeTempPaths(),
      initializeLocalState,
      connectOrStartDefaultBroker,
      serveStdio: async () => undefined
    });
    await runServe(deps);
    expect(initializeLocalState).not.toHaveBeenCalled();
    expect(connectOrStartDefaultBroker).not.toHaveBeenCalled();
  });

  it("initializes once on first use and closes the shared connection when MCP ends", async () => {
    const paths = await makeTempPaths();
    const initializeLocalState = vi.fn(async () => paths);
    const client = makeFakeBrokerClient({ "workspace.list": { workspace: {}, agents: [] } });
    const connectOrStartDefaultBroker = vi.fn(async () => client as never);
    const { deps } = makeCommandDeps({
      paths,
      initializeLocalState,
      connectOrStartDefaultBroker,
      serveStdio: async (port) => {
        expect(initializeLocalState).not.toHaveBeenCalled();
        await Promise.all([port.list("/repo", "one"), port.list("/repo", "two")]);
      }
    });
    await runServe(deps);
    expect(initializeLocalState).toHaveBeenCalledTimes(1);
    expect(connectOrStartDefaultBroker).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(true);
  });

  it("passes the workspace's attachments directory to serveStdio", async () => {
    const paths = await makeTempPaths();
    let receivedOptions: unknown;
    const { deps } = makeCommandDeps({
      paths,
      serveStdio: async (_port, _workspaceRoot, options) => {
        receivedOptions = options;
      }
    });

    await runServe(deps);

    expect(receivedOptions).toEqual({ attachmentsDirectory: path.join("/repo", "APL_downloads") });
  });
});
