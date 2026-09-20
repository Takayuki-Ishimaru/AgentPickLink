import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { doctorFindings, runDoctor } from "../../src/cli/commands/doctor.js";
import { buildProgram } from "../../src/cli/index.js";
import type { CliApi } from "../../src/cli/api.js";
import { HealthService } from "../../src/services/health-service.js";
import { identityFor, writeInstallJson, writeLaunchers } from "../../src/services/install-home.js";
import { makeCommandDeps, makeFakeBrokerClient, makeTempPaths } from "./helpers.js";

const healthy = {
  topology: { supported: true },
  node: { supported: true },
  browser: { installed: true },
  appData: { protected: true, writable: true },
  globalConfig: { valid: true },
  profile: { safe: true, owned: true, writable: true },
  workspace: { approvalStatus: "approved", assignments: [] },
  installConsistency: {
    versionSkew: "none",
    runtime: { live: true },
    aplJsTarget: "0.2.1",
    clients: [],
    policies: []
  }
};
const originalExit = process.exitCode;
const roots: string[] = [];
afterEach(async () => {
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("does not interpret an unrequested broker auth state as a failed optional probe", () => {
  expect(doctorFindings({ ...healthy, broker: { authState: { state: "sign-in-required" } } })).toEqual([]);
});

it.each([
  ["authentication", { state: "authenticated" }, []],
  ["authentication", { state: "sign-in-required" }, ["authentication.sign-in-required"]],
  ["authentication", { state: "interactive-auth" }, ["authentication.interactive-auth"]],
  ["authentication", { state: "access-denied" }, ["authentication.access-denied"]],
  ["authentication", { state: "unknown" }, ["authentication.unknown"]],
  ["authentication", {}, ["authentication.unknown"]],
  ["authentication", { code: "BROKER_UNAVAILABLE" }, ["authentication.error"]],
  ["agent", { valid: true }, []],
  ["agent", { valid: false, reason: "AGENT_UNVERIFIED" }, ["agent.invalid"]],
  ["agent", {}, ["agent.unknown"]],
  ["agent", { code: "BROKER_UNAVAILABLE" }, ["agent.error"]]
] as const)(
  "aggregates requested %s probe %j into findings, ok and CLI exit status",
  async (name, probe, findings) => {
    expect(doctorFindings({ ...healthy, [name]: probe })).toEqual(findings);
    const home = await mkdtemp(path.join(os.tmpdir(), "apl-doctor-optional-"));
    roots.push(home);
    const paths = await makeTempPaths();
    roots.push(path.dirname(paths.root));
    const broker = makeFakeBrokerClient({
      "broker.health": {},
      "browser.authState": probe,
      "agent.validate": probe
    });
    const { deps } = makeCommandDeps({
      paths,
      version: "0.2.1",
      homedir: () => home,
      env: { M365_AGENT_INSTALL_ROOT: home },
      connectExistingBroker: async () => broker as never,
      exec: async () => ({ stdout: "v24.21.0\n" })
    });
    await writeLaunchers({ home, version: deps.version, platform: deps.platform });
    const identity = identityFor({ home, platform: deps.platform });
    await writeInstallJson(home, {
      version: deps.version,
      installedBy: "archive",
      runtime: { path: identity.command, source: "bundled" },
      identity,
      clients: [],
      workspaces: [],
      platform: deps.platform,
      updatedAt: new Date().toISOString()
    });
    vi.spyOn(HealthService.prototype, "localReport").mockResolvedValue({
      topologyReady: true,
      checks: healthy
    });
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    const api = {
      doctor: (options: { auth?: boolean; agent?: string }) => runDoctor(deps, options)
    } as CliApi;
    await buildProgram(api).parseAsync([
      "node",
      "apl",
      "doctor",
      ...(name === "authentication" ? ["--auth"] : ["--agent", "test"]),
      "--json"
    ]);
    expect(JSON.parse(stdout)).toMatchObject({ [name]: probe, findings, ok: findings.length === 0 });
    expect(process.exitCode).toBe(findings.length ? 1 : 0);
    expect(broker.closed).toBe(true);
    if (name === "agent")
      expect(broker.calls).toContainEqual({
        method: "agent.validate",
        params: { agent: "test", sendTestMessage: false }
      });
  }
);
