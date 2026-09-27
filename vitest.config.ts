import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

/** Test files that drive a real browser; every one of them imports playwright-core directly. */
function realBrowserTests(): string[] {
  return readdirSync(path.join(root, "tests"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => `tests/${file.split(path.sep).join("/")}`)
    .filter((file) => /from "playwright-core"/.test(readFileSync(path.join(root, file), "utf8")))
    .sort();
}
const browserTests = realBrowserTests();

export default defineConfig({
  // `src/extension/**` imports the `vscode` module, which only exists inside the extension host.
  // Alias it to the hand-written mock so the extension can be unit tested in plain Node. Only
  // tests under tests/extension/** import anything that reaches `vscode`, so a single global alias
  // is enough (and `vscode` is not a real dependency, so nothing else can shadow it).
  resolve: { alias: { vscode: path.join(root, "tests", "extension", "vscode-mock.ts") } },
  test: {
    // Every worker gets a throw-away HOME before any test module loads, and each file's temp
    // directories are removed after it, with a run-wide sweep as the backstop (see both headers).
    setupFiles: ["tests/setup/isolate-home.ts"],
    globalSetup: ["tests/setup/temp-sweep.ts"],
    environment: "node",
    maxWorkers: 2,
    // Windows tests exercise real PowerShell ACL operations; five seconds does not cover setup.
    testTimeout: process.platform === "win32" ? 60_000 : 5_000,
    hookTimeout: process.platform === "win32" ? 120_000 : 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...browserTests]
        }
      },
      // Real-browser files run after all the others, one file at a time in a single worker: each
      // can hold a full Chrome, two at once doubled the peak memory, and their timing-sensitive
      // checks competed with the unit tests for CPU. `npm run test:unit` skips them entirely.
      {
        extends: true,
        test: {
          name: "browser",
          include: browserTests,
          sequence: { groupOrder: 1 },
          poolOptions: { forks: { singleFork: true } }
        }
      }
    ]
  }
});
