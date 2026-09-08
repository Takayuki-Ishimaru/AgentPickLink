import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // `src/extension/**` imports the `vscode` module, which only exists inside the extension host.
  // Alias it to the hand-written mock so the extension can be unit tested in plain Node. Only
  // tests under tests/extension/** import anything that reaches `vscode`, so a single global alias
  // is enough (and `vscode` is not a real dependency, so nothing else can shadow it).
  resolve: { alias: { vscode: path.join(root, "tests", "extension", "vscode-mock.ts") } },
  // Several files launch real Chromium processes. Bound workers so their render budgets are
  // not consumed by competing browser startups on machines with many reported CPU cores.
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    maxWorkers: 2,
    // Windows tests exercise real PowerShell ACL operations; five seconds does not cover setup.
    testTimeout: process.platform === "win32" ? 60_000 : 5_000,
    hookTimeout: process.platform === "win32" ? 120_000 : 10_000
  }
});
