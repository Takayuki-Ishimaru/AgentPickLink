import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildProgram, main } from "../../src/cli/index.js";
import { runCommand, type CliApi } from "../../src/cli/api.js";
import { DomainError } from "../../src/domain/errors.js";
import { runInstall } from "../../src/cli/commands/install.js";
import { makeCommandDeps, makeTempPaths } from "./helpers.js";
const originalExit = process.exitCode;
afterEach(() => {
  process.exitCode = originalExit;
  vi.restoreAllMocks();
});
function output() {
  let stdout = "",
    stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((text: string) => {
    stdout += text;
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((text: string) => {
    stderr += text;
    return true;
  }) as never);
  return { read: () => JSON.parse(stdout), stderr: () => stderr };
}
it.each([true, false, "error", "throw"])(
  "doctor result %s agrees with its JSON and exit code",
  async (mode) => {
    const out = output();
    const api = {
      doctor: async () => {
        if (mode === "throw") throw new Error("failed");
        return mode === "error"
          ? { code: "INTERNAL_ERROR", message: "failed", retryable: false }
          : { ok: mode, findings: mode ? [] : ["workspace.approval"] };
      }
    } as unknown as CliApi;
    await buildProgram(api).parseAsync(["node", "apl", "doctor", "--json"]);
    expect(process.exitCode).toBe(typeof mode === "string" ? 2 : mode ? 0 : 1);
    expect(out.read()).toMatchObject(typeof mode === "string" ? { code: "INTERNAL_ERROR" } : { ok: mode });
  }
);
it.each([{ args: ["install", "--unknown", "--json"] }, { args: ["self", "use", "--json"] }])(
  "formats parser errors as JSON: %j",
  async ({ args }) => {
    const out = output();
    await main(["node", "apl", ...args]);
    expect(out.read()).toMatchObject({ code: "INVALID_ARGUMENT", retryable: false });
    expect(process.exitCode).toBe(1);
  }
);
it("prints a structured argument error from install", async () => {
  const out = output();
  await buildProgram({
    install: async () => ({ code: "INVALID_ARGUMENT", message: "bad clients", retryable: false })
  } as unknown as CliApi).parseAsync(["node", "apl", "install", "--clients", "bad", "--json"]);
  expect(out.read()).toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(process.exitCode).toBe(1);
});
it("returns thrown command errors as a single JSON object", async () => {
  const lines: string[] = [];
  await runCommand(
    {
      json: true,
      out: (line) => lines.push(line),
      error: () => {
        throw new Error("unexpected stderr");
      }
    } as never,
    async () => {
      throw new DomainError("INVALID_ARGUMENT", "invalid");
    }
  );
  expect(JSON.parse(lines.join(""))).toMatchObject({ code: "INVALID_ARGUMENT" });
});
it("sends dry-run progress to stderr and leaves stdout for the report", async () => {
  const { deps, stdoutLines, stderrLines } = makeCommandDeps({ paths: await makeTempPaths() });
  deps.packageRoot = async () => path.dirname(deps.paths.root);
  const result = await runInstall(deps, {
    dryRun: true,
    clients: "none",
    json: true,
    workspaces: [path.dirname(deps.paths.root)]
  });
  expect(result.dryRun).toBe(true);
  expect(stdoutLines).toEqual([]);
  expect(stderrLines.join("")).toContain("Install plan");
});
