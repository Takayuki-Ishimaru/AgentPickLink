/**
 * Global safety net for the whole test run: every vitest worker gets a private, throw-away home.
 *
 * Three times on 2026-09-13 a test that forgot to inject a home directory wrote into the real
 * `~/.codex/config.toml`, `~/.claude.json` and VS Code's user `mcp.json`. Injecting paths per test
 * remains the rule; this file makes the mistake harmless by pointing `HOME` / `USERPROFILE` /
 * `APPDATA` / `LOCALAPPDATA` / `XDG_CONFIG_HOME`, `os.homedir()`, and the two AgentPickLink roots
 * at a fresh temporary directory before any test module loads. Child processes inherit the
 * environment, so brokers and CLIs spawned by tests are covered too.
 *
 * It also removes, after each test file, that home and every directory the file created with
 * `mkdtemp` directly under the system temp folder (browser profiles, fake install homes,
 * workspaces). Tests almost never clean these up themselves, and a `process.on("exit")` handler
 * alone does not run when vitest terminates a worker: by 2026-09-27 the temp folder held ~14,000
 * such directories (~16 GB, mostly copies of the official ~120 MB Node binary staged by install
 * tests).
 */
import fs, { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, inject } from "vitest";

// This file runs again before every test file, and the browser project runs all its files in one
// process: patch `mkdtemp` and register the exit fallback once per process, not once per file.
// Roots given from outside the test run still win, as before; otherwise every file gets its own.
// Each tracked directory is also listed in the run's manifest (tests/setup/temp-sweep.ts), which
// removes whatever an afterAll below never got to.
type TempTracker = {
  created: Set<string>;
  remember: (directory: string) => void;
  inherited: { appData?: string; installRoot?: string };
};
const tracker = ((globalThis as { __aplTempTracker?: TempTracker }).__aplTempTracker ??= (() => {
  const manifest = inject("aplTempManifest");
  const state: TempTracker = {
    created: new Set(),
    remember: (directory) => {
      state.created.add(directory);
      try {
        if (manifest) appendFileSync(manifest, `${directory}\n`);
      } catch {
        // The afterAll below still removes it.
      }
    },
    inherited: {
      appData: process.env.M365_AGENT_APP_DATA,
      installRoot: process.env.M365_AGENT_INSTALL_ROOT
    }
  };
  const tempRoots = new Set([os.tmpdir(), realpathSync(os.tmpdir())]);
  const track = <T>(directory: T): T => {
    if (typeof directory === "string" && tempRoots.has(path.dirname(directory))) state.remember(directory);
    return directory;
  };
  const originalMkdtemp = fsPromises.mkdtemp;
  const originalMkdtempSync = fs.mkdtempSync;
  fsPromises.mkdtemp = (async (...args: Parameters<typeof originalMkdtemp>) =>
    track(await originalMkdtemp(...args))) as typeof originalMkdtemp;
  fs.mkdtempSync = ((...args: Parameters<typeof originalMkdtempSync>) =>
    track(originalMkdtempSync(...args))) as typeof originalMkdtempSync;
  process.on("exit", () => {
    for (const directory of state.created) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // A worker that is being torn down must never fail because a temp file was busy.
      }
    }
  });
  return state;
})());

const home = mkdtempSync(path.join(os.tmpdir(), "apl-test-home-"));
tracker.remember(home);
const appData = path.join(home, "AppData", "Roaming");
const localAppData = path.join(home, "AppData", "Local");
for (const dir of [appData, localAppData]) mkdirSync(dir, { recursive: true });

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = appData;
process.env.LOCALAPPDATA = localAppData;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.M365_AGENT_APP_DATA = tracker.inherited.appData ?? path.join(home, "M365AgentWorkspace");
process.env.M365_AGENT_INSTALL_ROOT = tracker.inherited.installRoot ?? path.join(home, "AgentPickLink");

os.homedir = () => home;
syncBuiltinESMExports();

// Registered before any test file hook, so it runs after them (hooks unwind as a stack): the
// file's own afterAll has already closed its browsers and brokers by the time this deletes.
afterAll(async () => {
  const directories = [...tracker.created];
  tracker.created.clear();
  await Promise.all(
    directories.map((directory) =>
      fsPromises
        .rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        .catch(() => undefined)
    )
  );
});
