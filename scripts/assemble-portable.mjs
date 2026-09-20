// Assembles per-platform portable AgentPickLink archives that bundle the official Node.js runtime, so a
// user never has to install Node.js themselves (docs/extension-less-onboarding.md, sections 3.1-3.2, 4.6).
//
// Usage:
//   node scripts/assemble-portable.mjs --package <dir-or-.tgz> \
//     --platform <win-x64|win-arm64|darwin-arm64|darwin-x64|linux-x64|host> [--platform ...] \
//     --out <dir> [--node-version <v24.x.y>] [--cache <dir>] [--smoke]
//
// Never runs `npm install`: the package layer is expected to already be self-contained via
// `bundleDependencies` (see package.json and scripts/prepare-release.mjs).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fssync from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// Pinned Node.js runtime version bundled into every portable archive. Looked up from
// https://nodejs.org/dist/latest-v24.x/ on 2026-09-13: v24.21.0 (Active LTS "Krypton", directory
// last-modified 2026-09-08 per the server). Override per invocation with --node-version.
const PINNED_NODE_VERSION = "24.21.0";

const PLATFORMS = {
  "win-x64": { nodePlatform: "win-x64", isWindows: true, outputExt: "zip" },
  "win-arm64": { nodePlatform: "win-arm64", isWindows: true, outputExt: "zip" },
  "darwin-arm64": { nodePlatform: "darwin-arm64", isWindows: false, outputExt: "tgz" },
  "darwin-x64": { nodePlatform: "darwin-x64", isWindows: false, outputExt: "tgz" },
  "linux-x64": { nodePlatform: "linux-x64", isWindows: false, outputExt: "tgz" }
};

function usageError(message) {
  process.stderr.write(
    `${message}\n\nUsage: node scripts/assemble-portable.mjs --package <dir-or-.tgz> --platform <${Object.keys(
      PLATFORMS
    ).join("|")}|host> [--platform ...] --out <dir> [--node-version <v24.x.y>] [--cache <dir>] [--smoke]\n`
  );
  process.exit(1);
}

function hostPlatformKey() {
  const { platform, arch } = process;
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (platform === "win32") return arch === "arm64" ? "win-arm64" : "win-x64";
  if (platform === "linux") return "linux-x64";
  throw new Error(`Unsupported host platform for portable assembly: ${platform}/${arch}`);
}

async function exists(target) {
  return (await stat(target).catch(() => null)) !== null;
}

async function commandExists(command) {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fssync.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function download(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  await mkdir(path.dirname(destPath), { recursive: true });
  const partial = `${destPath}.part`;
  await pipeline(response.body, fssync.createWriteStream(partial));
  await rename(partial, destPath);
}

// SHASUMS256.txt is only ~3 KB and is the integrity root for every cached Node.js archive below, so
// it is always re-fetched fresh rather than reused from a cached copy -- a stale or tampered-with
// cached checksum file would silently defeat the verification in `ensureNodeArchive`. Only the much
// larger Node.js archives themselves are cached.
async function loadShasums(version) {
  process.stdout.write(`Fetching SHASUMS256.txt for v${version}...\n`);
  const url = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  const text = await response.text();
  const map = new Map();
  for (const line of text.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name) map.set(name, hash.toLowerCase());
  }
  return map;
}

// Downloads (or reuses a cached copy of) the official Node.js archive for one platform and verifies its
// SHA-256 against a freshly fetched SHASUMS256.txt, failing closed on any mismatch or missing entry.
async function ensureNodeArchive(nodePlatform, version, cacheDir) {
  const ext = nodePlatform.startsWith("win-") ? "zip" : "tar.gz";
  const filename = `node-v${version}-${nodePlatform}.${ext}`;
  const dest = path.join(cacheDir, filename);
  const shasums = await loadShasums(version);
  const expected = shasums.get(filename);
  if (!expected) throw new Error(`SHASUMS256.txt has no entry for ${filename}`);
  if (!(await exists(dest))) {
    process.stdout.write(`Downloading ${filename}...\n`);
    await download(`https://nodejs.org/dist/v${version}/${filename}`, dest);
  }
  const actual = await sha256File(dest);
  if (actual !== expected) {
    await rm(dest, { force: true });
    throw new Error(`Checksum mismatch for ${filename}: expected ${expected}, got ${actual}`);
  }
  return dest;
}

// Extracts only the node binary and its LICENSE from the official archive into a flat runtime/ layout
// (runtime/node.exe or runtime/node, runtime/LICENSE-node) -- no bin/, no npm, no headers, no docs.
//
// windows-latest GitHub runners ship bsdtar as `tar.exe` but neither `zip` nor `unzip`
// (ubuntu-latest and macos-latest have both GNU/bsdtar and zip/unzip), so the Windows branch must
// extract the official .zip with `tar`, whose bundled libarchive reads .zip transparently, rather
// than shelling out to `unzip`.
async function extractNodeRuntime({ archivePath, nodePlatform, version, destDir, isWindows }) {
  const topFolder = `node-v${version}-${nodePlatform}`;
  await mkdir(destDir, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "apl-node-extract-"));
  try {
    if (isWindows) {
      await execFileAsync("tar", [
        "xf",
        archivePath,
        "-C",
        tmp,
        `${topFolder}/node.exe`,
        `${topFolder}/LICENSE`
      ]);
      await cp(path.join(tmp, topFolder, "node.exe"), path.join(destDir, "node.exe"));
      await cp(path.join(tmp, topFolder, "LICENSE"), path.join(destDir, "LICENSE-node"));
    } else {
      await execFileAsync("tar", [
        "xzf",
        archivePath,
        "-C",
        tmp,
        "--strip-components=1",
        `${topFolder}/bin/node`,
        `${topFolder}/LICENSE`
      ]);
      await cp(path.join(tmp, "bin", "node"), path.join(destDir, "node"));
      await chmod(path.join(destDir, "node"), 0o755);
      await cp(path.join(tmp, "LICENSE"), path.join(destDir, "LICENSE-node"));
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// A packed tree (an extracted `npm pack` .tgz, or its --package directory equivalent) never has
// these -- their presence means --package was pointed at a source checkout instead, which would
// bundle the whole repository (history included, via .git/) into every portable archive.
const FORBIDDEN_SOURCE_ENTRIES = ["src", "tests", ".git"];

async function assertNotSourceCheckout(packageDir) {
  const present = [];
  for (const name of FORBIDDEN_SOURCE_ENTRIES) {
    if (await exists(path.join(packageDir, name))) present.push(`${name}/`);
  }
  if (present.length > 0) {
    throw new Error(
      `--package ${packageDir} looks like a source checkout, not a packed tree: it contains ${present.join(", ")}. ` +
        `Pass the npm-packed output instead (e.g. \`npm pack --ignore-scripts\`, then point --package at the ` +
        `extracted package/ directory or the .tgz itself).`
    );
  }
}

// Stages the package layer (dist/, node_modules/, schemas/, media/, docs, README*.md, LICENSE, ...) into
// destDir, either by copying a directory or by extracting an `npm pack` .tgz's package/ contents.
async function stagePackage(packageArg, destDir) {
  const info = await stat(packageArg).catch(() => null);
  if (!info) throw new Error(`--package not found: ${packageArg}`);
  if (info.isDirectory()) await assertNotSourceCheckout(packageArg);
  await mkdir(destDir, { recursive: true });
  if (info.isDirectory()) {
    await cp(packageArg, destDir, { recursive: true });
  } else if (info.isFile() && /\.(tgz|tar\.gz)$/.test(packageArg)) {
    await execFileAsync("tar", ["xzf", path.resolve(packageArg), "-C", destDir, "--strip-components=1"]);
  } else {
    throw new Error(`--package must be a directory or a .tgz/.tar.gz file: ${packageArg}`);
  }
}

async function writeLaunchers(stageDir) {
  const cmdContent = ["@echo off", '"%~dp0runtime\\node.exe" "%~dp0dist\\cli\\index.js" install %*', ""].join(
    "\r\n"
  );
  await writeFile(path.join(stageDir, "apl-setup.cmd"), cmdContent);

  const shContent = [
    "#!/bin/sh",
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'exec "$DIR/runtime/node" "$DIR/dist/cli/index.js" install "$@"',
    ""
  ].join("\n");
  const shPath = path.join(stageDir, "apl-setup");
  await writeFile(shPath, shContent);
  await chmod(shPath, 0o755);
}

// Candidate locations for an existing THIRD-PARTY-NOTICES.txt inside the staged package layer,
// checked in order; the release package layer (see scripts/release-source-files.json) keeps it
// under release-docs/.
const THIRD_PARTY_NOTICES_CANDIDATES = [
  "THIRD-PARTY-NOTICES.txt",
  path.join("release-docs", "THIRD-PARTY-NOTICES.txt")
];

function nodeThirdPartyNoticeSection(version) {
  const header = `Node.js ${version} (runtime/LICENSE-node)`;
  const rule = "=".repeat(header.length);
  return [
    rule,
    header,
    rule,
    "",
    `This archive bundles the official Node.js ${version} runtime (see the "runtime/" directory) so`,
    "AgentPickLink can run without a separate Node.js installation.",
    "",
    "Node.js is distributed under the MIT License. The full license text for this specific bundled",
    "runtime is included at runtime/LICENSE-node inside this archive; the canonical source is",
    "https://github.com/nodejs/node/blob/main/LICENSE.",
    ""
  ].join("\n");
}

// Records the bundled Node.js runtime's license in the archive's third-party notices: appended to an
// existing THIRD-PARTY-NOTICES.txt when the package layer already ships one (the common case for a
// release package), or created fresh at the top of the archive otherwise. The release page's own
// SHA256SUMS remains the source of truth for archive checksums -- this script never writes an
// in-archive checksum file of its own.
async function addNodeThirdPartyNotice(stageDir, version) {
  const section = nodeThirdPartyNoticeSection(version);
  for (const relative of THIRD_PARTY_NOTICES_CANDIDATES) {
    const target = path.join(stageDir, relative);
    if (await exists(target)) {
      const existing = await readFile(target, "utf8");
      const separator = existing.endsWith("\n") ? "\n" : "\n\n";
      await writeFile(target, existing + separator + section);
      return target;
    }
  }
  const target = path.join(stageDir, "THIRD-PARTY-NOTICES.txt");
  await writeFile(target, section);
  return target;
}

async function writeReadmeInstall(stageDir) {
  const content = `# Installing AgentPickLink

1. Extract this archive anywhere (Explorer, Archive Utility, or \`tar\`/\`unzip\` all work).
2. Open a terminal (cmd, PowerShell, or a shell) in the extracted folder.
3. Run one command with the full path of the workspace (the folder VS Code opens):

   \`\`\`
   .\\apl-setup C:\\path\\to\\workspace          (Windows: cmd or PowerShell)
   ./apl-setup /path/to/workspace              (macOS / Linux)
   \`\`\`

Node.js is bundled in \`runtime/\` -- you do not need to install it yourself. \`runtime/LICENSE-node\` is the
Node.js license for that bundled runtime.
`;
  await writeFile(path.join(stageDir, "README-INSTALL.md"), content);
}

// windows-latest has no `zip`/`unzip` but ships bsdtar as `tar.exe`, which can create a .zip via
// `-a` (auto-compress by extension); ubuntu-latest and macos-latest both have `zip`, which is kept
// there since it is the more common tool for this format. Falls back to tar if `zip` is ever
// missing on a non-Windows runner.
async function createArchive({
  stageParent,
  folderName,
  outDir,
  version,
  platformKey,
  outputExt,
  isWindows
}) {
  const archiveName = `AgentPickLink-${version}-${platformKey}.${outputExt}`;
  const archivePath = path.join(outDir, archiveName);
  await rm(archivePath, { force: true });
  if (outputExt === "zip") {
    if (!isWindows && (await commandExists("zip"))) {
      await execFileAsync("zip", ["-rq", archivePath, folderName], { cwd: stageParent });
    } else {
      await execFileAsync("tar", ["-a", "-cf", archivePath, folderName], { cwd: stageParent });
    }
  } else {
    await execFileAsync("tar", ["czf", archivePath, folderName], { cwd: stageParent });
  }
  return archivePath;
}

// Merges into an existing SHA256SUMS so that platforms assembled in separate runs (for example
// win-x64 on one runner and darwin-arm64 on another, copied into one directory) accumulate instead of
// overwriting each other; a re-assembled archive replaces its own line.
async function writeShaSums(outDir, archivePaths) {
  const sumsPath = path.join(outDir, "SHA256SUMS");
  const entries = new Map();
  try {
    for (const line of (await readFile(sumsPath, "utf8")).split(/\r?\n/)) {
      const match = /^([0-9a-f]{64})  (\S.*)$/.exec(line.trim());
      if (match) entries.set(match[2], match[1]);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const archivePath of archivePaths) {
    entries.set(path.basename(archivePath), await sha256File(archivePath));
  }
  const lines = [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, hash]) => `${hash}  ${name}`);
  await writeFile(sumsPath, lines.join("\n") + "\n");
}

function runStreamed(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

async function runSmoke(archivePath, isWindows) {
  process.stdout.write(`\n--- smoke: ${path.basename(archivePath)} ---\n`);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "apl-portable-smoke-"));
  try {
    // See extractNodeRuntime: windows-latest has no unzip, so use tar (bsdtar reads .zip) there too.
    if (isWindows) await execFileAsync("tar", ["xf", archivePath, "-C", tmp]);
    else await execFileAsync("tar", ["xzf", archivePath, "-C", tmp]);
    const [entry] = await readdir(tmp);
    const extractedDir = path.join(tmp, entry);
    const nodeBin = path.join(extractedDir, "runtime", isWindows ? "node.exe" : "node");
    const cliPath = path.join(extractedDir, "dist", "cli", "index.js");
    const { stdout } = await execFileAsync(nodeBin, [cliPath, "--version"]);
    process.stdout.write(`Bundled runtime --version: ${stdout.trim()}\n`);
    const smokeScript = path.join(scriptDir, "smoke-package.mjs");
    await runStreamed(process.execPath, [smokeScript, extractedDir, "--node", nodeBin]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      package: { type: "string" },
      platform: { type: "string", multiple: true },
      out: { type: "string" },
      "node-version": { type: "string" },
      cache: { type: "string" },
      smoke: { type: "boolean", default: false }
    }
  });

  if (!values.package) usageError("--package is required");
  if (!values.platform || values.platform.length === 0) usageError("at least one --platform is required");
  if (!values.out) usageError("--out is required");

  const requestedKeys = [
    ...new Set(values.platform.map((key) => (key === "host" ? hostPlatformKey() : key)))
  ];
  for (const key of requestedKeys) {
    if (!PLATFORMS[key]) usageError(`Unknown --platform ${key}`);
  }

  const version = (values["node-version"] ?? PINNED_NODE_VERSION).replace(/^v/, "");
  const cacheDir = path.resolve(values.cache ?? "output/portable-cache");
  const outDir = path.resolve(values.out);
  await mkdir(cacheDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  let hostKey;
  try {
    hostKey = hostPlatformKey();
  } catch {
    hostKey = undefined;
  }
  if (values.smoke && !requestedKeys.includes(hostKey)) {
    usageError(`--smoke requires one of the requested --platform values to match this host (${hostKey})`);
  }

  const workRoot = await mkdtemp(path.join(os.tmpdir(), "apl-portable-"));
  const produced = [];
  try {
    const packageBase = path.join(workRoot, "package-base");
    await stagePackage(path.resolve(values.package), packageBase);
    const manifest = JSON.parse(await readFile(path.join(packageBase, "package.json"), "utf8"));
    const folderName = `AgentPickLink-${manifest.version}`;

    for (const platformKey of requestedKeys) {
      const { nodePlatform, isWindows, outputExt } = PLATFORMS[platformKey];
      process.stdout.write(`\n=== ${platformKey} ===\n`);
      const stageParent = await mkdtemp(path.join(workRoot, `stage-${platformKey}-`));
      const stageDir = path.join(stageParent, folderName);
      await cp(packageBase, stageDir, { recursive: true });

      const nodeArchive = await ensureNodeArchive(nodePlatform, version, cacheDir);
      await extractNodeRuntime({
        archivePath: nodeArchive,
        nodePlatform,
        version,
        destDir: path.join(stageDir, "runtime"),
        isWindows
      });
      await writeLaunchers(stageDir);
      await writeReadmeInstall(stageDir);
      await addNodeThirdPartyNotice(stageDir, version);

      const archivePath = await createArchive({
        stageParent,
        folderName,
        outDir,
        version: manifest.version,
        platformKey,
        outputExt,
        isWindows
      });
      produced.push(archivePath);
      process.stdout.write(`Wrote ${archivePath}\n`);

      if (values.smoke && platformKey === hostKey) await runSmoke(archivePath, isWindows);

      await rm(stageParent, { recursive: true, force: true });
    }

    await writeShaSums(outDir, produced);
    process.stdout.write(`\nWrote ${path.join(outDir, "SHA256SUMS")}\n`);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

await main();
