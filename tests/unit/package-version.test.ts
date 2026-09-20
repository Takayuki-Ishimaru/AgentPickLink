/**
 * P0-1: one version constant. Every surface that reports "which AgentPickLink is this" -- the
 * broker descriptor, the IPC hello, the MCP server's own `version`, and `m365-agent --version` --
 * must read `package.json` at run time rather than repeat a literal.
 *
 * This is not cosmetic. docs/extension-less-onboarding.md §4.7 C13 has every `serve` and every
 * activation compare the running broker's `packageVersion` against `install.json`'s version: a
 * literal left behind after a release bump makes that comparison permanently false, and the entry
 * points restart the broker forever.
 */
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerServer } from "../../src/broker/broker-server.js";
import { readDescriptor } from "../../src/broker/broker-descriptor.js";
import { buildProgram } from "../../src/cli/index.js";
import { PACKAGE_VERSION } from "../../src/config/package-version.js";
import { appPaths } from "../../src/config/paths.js";
import { initializeLocalState } from "../../src/config/init.js";
import { TransportRouter } from "../../src/transports/transport-router.js";
import { testIpcEndpoint } from "../helpers/platform.js";

const manifest = createRequire(import.meta.url)("../../package.json") as { version: string };

const noopLocalStatePreparer = {
  async prepareLocalState() {
    /* no browser profile to prepare in this test */
  }
};

describe("PACKAGE_VERSION", () => {
  it("is package.json's own version", () => {
    expect(PACKAGE_VERSION).toBe(manifest.version);
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is the only place a version string lives under src/", async () => {
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    const offenders: string[] = [];
    const literal = new RegExp(`["'\`]${manifest.version.replace(/\./g, "\\.")}["'\`]`);
    const { readdir } = await import("node:fs/promises");
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || full.endsWith(path.join("config", "package-version.ts"))) continue;
        if (literal.test(await readFile(full, "utf8"))) offenders.push(path.relative(root, full));
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });

  it("is what `m365-agent --version` reports", () => {
    // commander's own accessor: `.version()` with no argument returns what was registered.
    expect(buildProgram({} as never).version()).toBe(manifest.version);
  });
});

describe("the broker descriptor's packageVersion", () => {
  const servers: BrokerServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop().catch(() => undefined)));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it("equals package.json's version, exactly as src/broker/process.ts passes it", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-broker-version-"));
    directories.push(base);
    const paths = await initializeLocalState(appPaths(path.join(base, "appdata")), noopLocalStatePreparer);
    const server = new BrokerServer({
      paths,
      pipeName: testIpcEndpoint(base),
      // The exact expression src/broker/process.ts uses; the test above proves the two files agree
      // on where that value comes from.
      packageVersion: PACKAGE_VERSION,
      router: new TransportRouter()
    });
    servers.push(server);
    await server.start();

    const descriptor = await readDescriptor(paths);

    expect(descriptor?.packageVersion).toBe(manifest.version);
  });
});
