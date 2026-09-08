// Bundles the VS Code extension host entry point into a single CommonJS file.
//
// The extension imports the same core modules as the CLI (config stores, IPC client, broker
// lifecycle, SetupService). It must never pull in `playwright-core`: the browser only ever runs
// inside the broker process, and dragging it into the extension host would both bloat the bundle
// and blur the process boundary the security model depends on. That invariant is checked after
// every build and fails the build when violated.
/* global Buffer, process */
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(root, "dist", "extension", "extension.cjs");
const FORBIDDEN = ["playwright-core"];
// The source map is ~2.2 MB, roughly a third of the whole VSIX, and is only useful when debugging
// the extension host locally. Opt in with `APL_EXTENSION_SOURCEMAP=1 npm run build`; `package:vsix`
// deliberately leaves it off (and cleans dist/ first, so a map from an earlier build cannot leak).
const sourcemap = process.env.APL_EXTENSION_SOURCEMAP === "1";

const result = await build({
  entryPoints: [path.join(root, "src", "extension", "extension.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap,
  logLevel: "info",
  // `src/broker/broker-lifecycle.ts` reads `import.meta.url` in spawnBundledBroker(), which the
  // extension never calls (it passes its own spawn closure). CommonJS has no import.meta, so it is
  // rewritten to the equivalent file URL instead of being emitted as `undefined`.
  define: { "import.meta.url": "__agentPickLinkModuleUrl" },
  banner: {
    js: 'const __agentPickLinkModuleUrl = require("node:url").pathToFileURL(__filename).href;'
  },
  metafile: true
});

const bundle = await readFile(outfile, "utf8");
const leaked = FORBIDDEN.filter((name) => bundle.includes(name));
if (leaked.length > 0) {
  throw new Error(
    `dist/extension/extension.cjs must not reference ${leaked.join(", ")}; ` +
      "check the imports reachable from src/extension/extension.ts."
  );
}

const bytes = Buffer.byteLength(bundle);
const inputs = Object.keys(result.metafile.outputs[path.relative(root, outfile)]?.inputs ?? {}).length;
// Keep npm pack --json machine-readable when this build runs in its prepack hook.
process.stderr.write(
  `extension bundle: ${(bytes / 1024).toFixed(1)} KiB from ${inputs} modules, no forbidden imports` +
    `${sourcemap ? ", with source map" : ""}\n`
);
