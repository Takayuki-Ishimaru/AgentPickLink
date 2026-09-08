import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli/index.js";
import type { CliApi } from "../../src/cli/api.js";

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

async function run(
  program: ReturnType<typeof buildProgram>,
  args: string[]
): Promise<{ out: string[]; errors: string[] }> {
  const out: string[] = [];
  const errors: string[] = [];
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
    await program.parseAsync(["node", "m365-agent", ...args]);
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
  }
  return { out, errors };
}

describe("agent add flag validation (index.ts, before reaching CliApi)", () => {
  it("rejects --capture and --url together", async () => {
    let called = false;
    const program = buildProgram(
      api({
        agentAdd: async () => {
          called = true;
          return { ok: true };
        }
      })
    );
    const { errors } = await run(program, [
      "agent",
      "add",
      "--capture",
      "--url",
      "https://contoso.example/chat"
    ]);
    expect(errors.join("")).toContain("Use either --capture or --url, not both.");
    expect(called).toBe(false);
  });

  it("rejects neither --capture nor --url", async () => {
    let called = false;
    const program = buildProgram(
      api({
        agentAdd: async () => {
          called = true;
          return { ok: true };
        }
      })
    );
    const { errors } = await run(program, ["agent", "add"]);
    expect(errors.join("")).toContain("Specify --capture or --url <url>.");
    expect(called).toBe(false);
  });

  it("--capture alone reaches agentAdd", async () => {
    let received: unknown;
    const program = buildProgram(
      api({
        agentAdd: async (options) => {
          received = options;
          return { ok: true };
        }
      })
    );
    await run(program, ["agent", "add", "--capture"]);
    expect(received).toMatchObject({ capture: true });
  });

  it("--url alone reaches agentAdd", async () => {
    let received: unknown;
    const program = buildProgram(
      api({
        agentAdd: async (options) => {
          received = options;
          return { ok: true };
        }
      })
    );
    await run(program, ["agent", "add", "--url", "https://contoso.example/chat"]);
    expect(received).toMatchObject({ url: "https://contoso.example/chat" });
  });
});
