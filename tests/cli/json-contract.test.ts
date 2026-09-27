import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildProgram, main } from "../../src/cli/index.js";
import { runCommand, type CliApi } from "../../src/cli/api.js";
import { DomainError } from "../../src/domain/errors.js";
import { runInstall } from "../../src/cli/commands/install.js";
import { runIntegrationsWrite } from "../../src/cli/commands/integrations.js";
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
// APL-REVIEW-02: `integrations write`/`remove` used to return `written: []`/`skipped: [...]` and
// still exit 0, so a caller that only checks the exit code believed a requested integration exists.
// These drive the real `buildProgram` wiring (src/cli/index.ts's `write.action`), with `api.integrations`
// delegating to the real `runIntegrationsWrite` (rather than a hard-coded stub) so the malformed-file
// scenario is genuine end to end, not just an assertion about a hand-built result object.
it("integrations write: a malformed .vscode/mcp.json prints one JSON object with ok:false and exits 1", async () => {
  const out = output();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-json-contract-ws-"));
  const osHome = await mkdtemp(path.join(os.tmpdir(), "apl-json-contract-home-"));
  await mkdir(path.join(workspace, ".vscode"), { recursive: true });
  await writeFile(path.join(workspace, ".vscode", "mcp.json"), "// comment\n{ broken }\n", "utf8");
  const { deps } = makeCommandDeps({ paths: await makeTempPaths(), homedir: () => osHome });

  await buildProgram({
    integrations: (_action, options) => runIntegrationsWrite(deps, options ?? {})
  } as unknown as CliApi).parseAsync([
    "node",
    "apl",
    "integrations",
    "write",
    "--client",
    "vscode-workspace",
    "--workspace",
    workspace,
    "--json"
  ]);

  const parsed = out.read();
  expect(parsed).toMatchObject({ ok: false, written: [] });
  expect(process.exitCode).toBe(1);
});

it("integrations write: a clean write prints ok:true and exits 0", async () => {
  const out = output();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "apl-json-contract-ws-"));
  const osHome = await mkdtemp(path.join(os.tmpdir(), "apl-json-contract-home-"));
  const { deps } = makeCommandDeps({ paths: await makeTempPaths(), homedir: () => osHome });

  await buildProgram({
    integrations: (_action, options) => runIntegrationsWrite(deps, options ?? {})
  } as unknown as CliApi).parseAsync([
    "node",
    "apl",
    "integrations",
    "write",
    "--client",
    "vscode-workspace",
    "--workspace",
    workspace,
    "--json"
  ]);

  const parsed = out.read();
  expect(parsed.ok).toBe(true);
  expect(process.exitCode).toBe(0);
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
