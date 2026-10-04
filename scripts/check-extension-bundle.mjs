// Load-regression guard for the packaged extension bundle: copies ONLY the bundle into an empty
// temporary directory and requires it in a clean child Node, so a runtime import the bundler left
// unbundled (e.g. jsonc-parser's UMD entry requiring './impl/format') fails here exactly as it
// would inside the extension host, even when the checkout or artifact has files or node_modules
// next to the original entry that would silently satisfy it.
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Runs in the child: stubs only require("vscode") (the one import the extension host provides)
// and delegates every other import to Node normally, so nothing else can be masked.
const CHILD_LOADER = `
"use strict";
const Module = require("node:module");
const target = process.argv[2];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const loaded = require(target);
for (const name of ["activate", "deactivate"]) {
  if (typeof loaded[name] !== "function") {
    throw new Error("Extension bundle must export " + name + " as a function");
  }
}
process.stdout.write("APL_BUNDLE_LOAD_OK\\n");
`;

// Development/runtime overrides that could change how the child resolves or instruments modules.
const REMOVED_ENV_KEYS = ["NODE_PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "VSCODE_INSPECTOR_OPTIONS"];

export async function assertExtensionBundleLoads(
  entry,
  { nodeBinary = process.execPath, timeoutMs = 10_000 } = {}
) {
  const entryPath = path.resolve(entry);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "apl-bundle-load-"));
  try {
    const copiedEntry = path.join(temporary, path.basename(entryPath));
    await copyFile(entryPath, copiedEntry);
    const loaderPath = path.join(temporary, "apl-bundle-load-child.cjs");
    await writeFile(loaderPath, CHILD_LOADER);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (REMOVED_ENV_KEYS.includes(key.toUpperCase())) delete env[key];
    }
    const { stdout } = await execFileAsync(nodeBinary, [loaderPath, copiedEntry], {
      cwd: temporary,
      env,
      timeout: timeoutMs,
      // A real bundle can write a lot before failing; keep enough of it for the message below.
      maxBuffer: 16 * 1024 * 1024
    });
    if (!stdout.includes("APL_BUNDLE_LOAD_OK")) {
      throw new Error(`Extension bundle load check produced no confirmation: ${stdout}`);
    }
  } catch (error) {
    const detail = [error.stderr, error.message, error.stdout].find(
      (part) => typeof part === "string" && part.trim()
    );
    const timeoutDetail = error.killed ? `Child exceeded its ${timeoutMs}ms time limit.\n` : "";
    throw new Error(
      `Packaged extension bundle failed to load: ${entryPath}\n${timeoutDetail}${String(detail).trim()}`,
      {
        cause: error
      }
    );
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
