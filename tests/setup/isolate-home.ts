/**
 * Global safety net for the whole test run: every vitest worker gets a private, throw-away home.
 *
 * Three times on 2026-09-13 a test that forgot to inject a home directory wrote into the real
 * `~/.codex/config.toml`, `~/.claude.json` and VS Code's user `mcp.json`. Injecting paths per test
 * remains the rule; this file makes the mistake harmless by pointing `HOME` / `USERPROFILE` /
 * `APPDATA` / `LOCALAPPDATA` / `XDG_CONFIG_HOME`, `os.homedir()`, and the two AgentPickLink roots
 * at a fresh temporary directory before any test module loads. Child processes inherit the
 * environment, so brokers and CLIs spawned by tests are covered too.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(os.tmpdir(), "apl-test-home-"));
const appData = path.join(home, "AppData", "Roaming");
const localAppData = path.join(home, "AppData", "Local");
for (const dir of [appData, localAppData]) mkdirSync(dir, { recursive: true });

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = appData;
process.env.LOCALAPPDATA = localAppData;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.M365_AGENT_APP_DATA ??= path.join(home, "M365AgentWorkspace");
process.env.M365_AGENT_INSTALL_ROOT ??= path.join(home, "AgentPickLink");

os.homedir = () => home;
syncBuiltinESMExports();

process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // A worker that is being torn down must never fail because a temp file was busy.
  }
});
