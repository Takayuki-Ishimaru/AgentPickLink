/**
 * `ExtensionRuntime` reading `<home>/install.json` (docs/extension-less-onboarding.md §4.7 C2, C4,
 * C13): when a usable machine install exists (present, version >= this extension's own),
 * `integrationDefinition()`/`cliEntry()`/`brokerEntry()`/`node()` defer to it instead of the
 * extension's own tree. Uses the same `createRuntimeHarness()` fixture as the other extension
 * tests, but restores the real `node()` implementation (the harness stubs it by default) so these
 * tests exercise `ExtensionRuntime`'s own install.json-aware logic rather than the fake.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeInstallJson, type InstallJson } from "../../src/services/install-home.js";
import type { NodeProbe } from "../../src/extension/node-runtime.js";
import { createRuntimeHarness, logText, type RuntimeHarness } from "./harness.js";
import { resetVscodeMock } from "./vscode-mock.js";

let harness: RuntimeHarness;

beforeEach(async () => {
  resetVscodeMock();
  harness = await createRuntimeHarness();
  // The harness stubs `node()` to a fake resolution; delete the instance-own override so calls
  // fall back to ExtensionRuntime.prototype.node(), the implementation under test here.
  delete (harness.runtime as unknown as Record<string, unknown>).node;
});

afterEach(async () => {
  await harness.dispose();
});

/** What `resolveInstallHome` returns inside a harness: the temp `<home>` the harness pins through
 * `M365_AGENT_INSTALL_ROOT` (see `RuntimeHarness.installHome`). */
function installHomeDir(): string {
  return harness.installHome;
}

function fakeInstallJson(overrides: Partial<InstallJson> = {}): InstallJson {
  return {
    version: "9.9.9",
    installedBy: "archive",
    runtime: { path: "/machine/bin/node", source: "bundled", nodeVersion: "22.14.0" },
    identity: { command: "/machine/bin/node", args: ["/machine/bin/apl.js", "serve"] },
    clients: ["vscode"],
    workspaces: [harness.workspaceRoot],
    platform: process.platform,
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides
  };
}

async function seedInstallJson(overrides: Partial<InstallJson> = {}): Promise<void> {
  await writeInstallJson(installHomeDir(), fakeInstallJson(overrides));
}

describe("ExtensionRuntime + install.json (§4.7 C2, C4, C13)", () => {
  it("keeps today's behaviour (own extensionRoot) when there is no install.json", async () => {
    expect(harness.runtime.cliEntry()).toBe(path.join(harness.extensionRoot, "dist", "cli", "index.js"));
    expect(harness.runtime.brokerEntry()).toBe(
      path.join(harness.extensionRoot, "dist", "broker", "process.js")
    );
    const definition = await harness.runtime.integrationDefinition();
    expect(definition.command).not.toBe("/machine/bin/node");
  });

  it("defers to the machine install when its version is >= the extension's own", async () => {
    await seedInstallJson({ version: "9.9.9" }); // harness extension version is "0.1.0"
    // cliEntry()/brokerEntry() are synchronous and only reflect install.json once the background
    // read has resolved; awaiting an async accessor first is the documented, bounded race window.
    await harness.runtime.integrationDefinition();

    const home = installHomeDir();
    expect(harness.runtime.cliEntry()).toBe(path.join(home, "app", "9.9.9", "dist", "cli", "index.js"));
    expect(harness.runtime.brokerEntry()).toBe(
      path.join(home, "app", "9.9.9", "dist", "broker", "process.js")
    );
  });

  it("also defers when the machine install's version exactly equals the extension's own", async () => {
    await seedInstallJson({ version: "0.1.0" }); // matches createExtensionContext's default version
    await harness.runtime.integrationDefinition();
    expect(harness.runtime.cliEntry()).toContain(path.join("app", "0.1.0", "dist", "cli", "index.js"));
  });

  it("keeps today's behaviour and logs one line when the machine install is older", async () => {
    await seedInstallJson({ version: "0.0.1" }); // older than the extension's "0.1.0"
    await harness.runtime.integrationDefinition();

    expect(harness.runtime.cliEntry()).toBe(path.join(harness.extensionRoot, "dist", "cli", "index.js"));
    expect(logText()).toContain("machine install 0.0.1 is older than the extension 0.1.0");
  });

  it("integrationDefinition() returns install.json's identity plus the ownership marker", async () => {
    await seedInstallJson({
      version: "9.9.9",
      identity: { command: "/machine/bin/node", args: ["/machine/bin/apl.js", "serve"] }
    });

    const definition = await harness.runtime.integrationDefinition();

    expect(definition.command).toBe("/machine/bin/node");
    expect(definition.args).toEqual(["/machine/bin/apl.js", "serve"]);
    expect(definition.env?.M365_AGENT_MANAGED).toBe("1");
  });

  it("node() resolves to the recorded runtime path with an empty env for a bundled/node runtime", async () => {
    // P1-5: the recorded binary has to actually exist; a version new enough to satisfy
    // MINIMUM_NODE_MAJOR is taken from install.json without ever running it.
    const recorded = path.join(harness.home, "machine-node");
    await fs.writeFile(recorded, "#!/bin/sh\n", "utf8");
    await seedInstallJson({
      version: "9.9.9",
      runtime: { path: recorded, source: "bundled", nodeVersion: "22.14.0" }
    });

    const resolution = await harness.runtime.node();

    expect(resolution.command).toBe(recorded);
    expect(resolution.env).toEqual({});
    expect(resolution.version).toBe("22.14.0");
  });

  /** A probe that never touches the real machine: `run` answers from `versions` (keyed by the
   * command) and rejects for anything else, and there are no nvm directories to walk. */
  function fakeProbe(versions: Record<string, string> = {}): NodeProbe {
    return {
      run: async (command) => {
        const version = versions[command];
        if (version === undefined) throw new Error(`${command} is not runnable here`);
        return version;
      },
      listDirectory: async () => [],
      platform: process.platform,
      env: {},
      homedir: harness.home,
      execPath: "/fake/vscode/Electron"
    };
  }

  // P1-5: `install.json` records what another entry point did, possibly long ago on a machine whose
  // <home> has since been moved, pruned or restored from a backup.
  it("node() falls back, with one line, when the recorded runtime is no longer on disk", async () => {
    Object.assign(harness.runtime, { nodeProbe: () => fakeProbe() });
    await seedInstallJson({
      version: "9.9.9",
      runtime: { path: path.join(harness.home, "gone", "node"), source: "bundled", nodeVersion: "22.14.0" }
    });

    const resolution = await harness.runtime.node();

    expect(resolution.command).toBe("/fake/vscode/Electron");
    expect(logText()).toContain("is missing; falling back");
  });

  it("node() falls back when the recorded runtime turns out to be older than Node 22", async () => {
    const recorded = path.join(harness.home, "old-node");
    await fs.writeFile(recorded, "#!/bin/sh\n", "utf8");
    Object.assign(harness.runtime, { nodeProbe: () => fakeProbe({ [recorded]: "v18.19.0\n" }) });
    // install.json's own record already says 18, which is reason enough to probe rather than trust.
    await seedInstallJson({
      version: "9.9.9",
      runtime: { path: recorded, source: "bundled", nodeVersion: "18.19.0" }
    });

    const resolution = await harness.runtime.node();

    expect(resolution.command).toBe("/fake/vscode/Electron");
    expect(logText()).toContain("is Node 18.19.0; 22+ is required");
  });

  it("node() probes the recorded runtime when install.json records no version at all", async () => {
    const recorded = path.join(harness.home, "unversioned-node");
    await fs.writeFile(recorded, "#!/bin/sh\n", "utf8");
    Object.assign(harness.runtime, { nodeProbe: () => fakeProbe({ [recorded]: "v24.4.1\n" }) });
    await seedInstallJson({ version: "9.9.9", runtime: { path: recorded, source: "bundled" } });

    const resolution = await harness.runtime.node();

    expect(resolution.command).toBe(recorded);
    expect(resolution.version).toBe("24.4.1");
  });

  it("node() keeps today's Electron behaviour instead of using the recorded path", async () => {
    Object.assign(harness.runtime, { nodeProbe: () => fakeProbe() });
    await seedInstallJson({
      version: "9.9.9",
      runtime: { path: "/electron-runtime-from-vsix/Code", source: "electron" }
    });

    const resolution = await harness.runtime.node();

    // The real resolveNodeRuntime() ran instead of trusting install.json's electron path verbatim.
    expect(resolution.command).not.toBe("/electron-runtime-from-vsix/Code");
  });

  // §P2: a Zod error's own message quotes the offending values; the output channel gets metadata.
  it("logs an invalid install.json as issue count and property paths, never its content", async () => {
    await fs.mkdir(harness.installHome, { recursive: true });
    await fs.writeFile(
      path.join(harness.installHome, "install.json"),
      JSON.stringify({ version: "1.0.0", installedBy: "archive", secretish: "s3cr3t-value" }),
      "utf8"
    );

    expect(harness.runtime.cliEntry()).toBe(path.join(harness.extensionRoot, "dist", "cli", "index.js"));
    await harness.runtime.ready();

    expect(logText()).toMatch(/install\.json invalid \(\d+ issues? at [^)]+\)/);
    expect(logText()).not.toContain("s3cr3t-value");
  });

  it("logs one line when install.json's own version cannot be parsed", async () => {
    await seedInstallJson({ version: "not-a-version" });

    await harness.runtime.ready();

    expect(logText()).toContain("its version could not be parsed");
  });
});
