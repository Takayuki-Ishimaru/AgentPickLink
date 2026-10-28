/**
 * Regression tests for the Linux portable build (release CI): GNU tar cannot read or write .zip,
 * so scripts/assemble-portable.mjs must extract the official Windows-target Node.js .zip with
 * `unzip` on Linux hosts and create the output .zip with `zip`, while a missing required member
 * (LICENSE) must still fail the build and clean up every staging directory.
 *
 * The child script's only network call (the official SHASUMS256.txt) is mocked through a
 * `--import` preload that rejects every other URL; the Node.js archives themselves are cached
 * fixture .zips written by the store-only ZIP builder below, so nothing touches the network.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const isLinux = process.platform === "linux";
const toolAvailable = (args: string[]) =>
  spawnSync(args[0], args.slice(1), { stdio: "ignore", timeout: 5_000 }).status === 0;
// `unzip` extracts the Windows-target fixtures on Linux and reads the output archives back;
// `zip` is what the script itself needs on Linux to create them.
const fixturesReady = isLinux && toolAvailable(["unzip", "-v"]) && toolAvailable(["zip", "-v"]);

const NODE_VERSION = "24.22.1";
const PACKAGE_VERSION = "0.2.15";
const PLATFORMS = ["win-x64", "win-arm64"] as const;
const scriptPath = path.join(__dirname, "..", "..", "scripts", "assemble-portable.mjs");

let rootDir = "";

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal store-only (method 0) .zip writer: enough for `unzip` to consume fixture archives
// without adding a runtime or dev dependency.
function buildZip(entries: Array<{ name: string; data: Uint8Array }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, Buffer.from(entry.data));
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(entry.data.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += 30 + name.length + entry.data.length;
  }
  const centralStart = offset;
  for (const chunk of central) {
    chunks.push(chunk);
    offset += chunk.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  chunks.push(end);
  return Buffer.concat(chunks);
}

// `omitLicenseFor` lists platforms whose fixture .zip lacks the required LICENSE member.
async function writeFixtureCache(cacheDir: string, omitLicenseFor: readonly string[]): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const sums: string[] = [];
  for (const platform of PLATFORMS) {
    const filename = `node-v${NODE_VERSION}-${platform}.zip`;
    const top = `node-v${NODE_VERSION}-${platform}`;
    const entries = [{ name: `${top}/node.exe`, data: Buffer.from(`binary:${platform}`) }];
    if (!omitLicenseFor.includes(platform)) {
      entries.push({ name: `${top}/LICENSE`, data: Buffer.from(`license:${platform}`) });
    }
    const archive = buildZip(entries);
    await writeFile(path.join(cacheDir, filename), archive);
    sums.push(`${sha256(archive)}  ${filename}`);
  }
  return sums.join("\n") + "\n";
}

// Preload that answers only the official SHASUMS256.txt URL with the fixture checksums.
async function writeFetchMock(mockFile: string, shasums: string): Promise<void> {
  await writeFile(
    mockFile,
    `globalThis.fetch = async (url) => {
  if (String(url) === "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt") {
    return new Response(${JSON.stringify(shasums)});
  }
  throw new Error("Unexpected network: " + url);
};
`
  );
}

interface AssemblyRun {
  code: number | null;
  output: string;
  outDir: string;
  childTemp: string;
}

// Asynchronous on purpose: the concurrent test must have both CLI children alive at once
// (spawnSync would serialize them). `pathPrepend` shims PATH for the missing-zip-utility test.
async function runAssembly(
  name: string,
  cacheDir: string,
  platforms: readonly string[] = PLATFORMS,
  options: { pathPrepend?: string } = {}
): Promise<AssemblyRun> {
  const outDir = path.join(rootDir, `out-${name}`);
  const childTemp = path.join(rootDir, `tmp-${name}`);
  await mkdir(childTemp, { recursive: true });
  const env = { ...process.env, TMPDIR: childTemp };
  if (options.pathPrepend) env.PATH = `${options.pathPrepend}${path.delimiter}${process.env.PATH}`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.join(rootDir, "mock-fetch.mjs"),
      scriptPath,
      "--package",
      path.join(rootDir, "package"),
      ...platforms.flatMap((platform) => ["--platform", platform]),
      "--out",
      outDir,
      "--cache",
      cacheDir
    ],
    { env }
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("error", reject);
    child.once("close", (closeCode) => {
      clearTimeout(timer);
      resolve(closeCode);
    });
  });
  return { code, output, outDir, childTemp };
}

function unzipMember(archivePath: string, member: string): string {
  const result = spawnSync("unzip", ["-p", archivePath, member], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 5_000
  });
  expect(result.status, `unzip -p ${member}: ${result.stderr}`).toBe(0);
  return result.stdout.toString();
}

async function expectCleanAssembly(run: AssemblyRun): Promise<void> {
  const folder = `AgentPickLink-${PACKAGE_VERSION}`;
  for (const platform of PLATFORMS) {
    const archive = path.join(run.outDir, `${folder}-${platform}.zip`);
    expect(unzipMember(archive, `${folder}/runtime/node.exe`)).toBe(`binary:${platform}`);
    expect(unzipMember(archive, `${folder}/runtime/LICENSE-node`)).toBe(`license:${platform}`);
    expect(unzipMember(archive, `${folder}/dist/cli/index.js`)).toBe('console.log("fixture");');
  }
  const sums = (await readFile(path.join(run.outDir, "SHA256SUMS"), "utf8")).trim().split(/\r?\n/);
  expect(sums).toHaveLength(PLATFORMS.length);
  for (const line of sums) {
    const [hash, archiveName] = line.split("  ");
    expect(hash).toBe(sha256(await readFile(path.join(run.outDir, archiveName))));
  }
  expect(await readdir(run.childTemp)).toEqual([]);
}

describe.runIf(fixturesReady)("assemble-portable on Linux hosts", () => {
  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "apl-portable-test-"));
    const packageDir = path.join(rootDir, "package");
    await mkdir(path.join(packageDir, "dist", "cli"), { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `{"name":"agent-pick-link","version":"${PACKAGE_VERSION}"}`
    );
    await writeFile(path.join(packageDir, "dist", "cli", "index.js"), 'console.log("fixture");');
    const shasums = await writeFixtureCache(path.join(rootDir, "cache"), []);
    await writeFetchMock(path.join(rootDir, "mock-fetch.mjs"), shasums);
  });

  afterAll(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("extracts Windows-target .zip archives with real Linux tools and keeps required bytes", async () => {
    const run = await runAssembly("ok", path.join(rootDir, "cache"));
    expect(run.code, run.output).toBe(0);
    await expectCleanAssembly(run);
  }, 15_000);

  it("fails and cleans staging when a required archive member is missing", async () => {
    const failingCache = path.join(rootDir, "cache-missing-license");
    const shasums = await writeFixtureCache(failingCache, ["win-arm64"]);
    await writeFetchMock(path.join(rootDir, "mock-fetch.mjs"), shasums);
    try {
      const run = await runAssembly("missing", failingCache, ["win-arm64"]);
      expect(run.code).not.toBe(0);
      const produced = await readdir(run.outDir).catch(() => []);
      expect(produced.filter((name) => name.endsWith(".zip"))).toEqual([]);
      expect(await readdir(run.childTemp)).toEqual([]);
    } finally {
      const shasumsAgain = await writeFixtureCache(path.join(rootDir, "cache"), []);
      await writeFetchMock(path.join(rootDir, "mock-fetch.mjs"), shasumsAgain);
    }
  }, 15_000);

  it("fails without a disguised tar .zip when the zip utility is missing on a Linux host", async () => {
    const shimDir = path.join(rootDir, "shim-no-zip");
    await mkdir(shimDir, { recursive: true });
    const shim = path.join(shimDir, "which");
    await writeFile(shim, '#!/bin/sh\nif [ "$1" = "zip" ]; then exit 1; fi\nexec /usr/bin/which "$@"\n');
    await chmod(shim, 0o755);
    const run = await runAssembly("no-zip", path.join(rootDir, "cache"), PLATFORMS, { pathPrepend: shimDir });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain("zip");
    const produced = await readdir(run.outDir).catch(() => []);
    expect(produced.filter((name) => name.endsWith(".zip"))).toEqual([]);
    expect(await readdir(run.childTemp)).toEqual([]);
  }, 15_000);

  it("keeps concurrent independent assemblies independent", async () => {
    const [left, right] = await Promise.all([
      runAssembly("left", path.join(rootDir, "cache")),
      runAssembly("right", path.join(rootDir, "cache"))
    ]);
    for (const run of [left, right]) {
      expect(run.code, run.output).toBe(0);
      await expectCleanAssembly(run);
    }
  }, 15_000);
});
