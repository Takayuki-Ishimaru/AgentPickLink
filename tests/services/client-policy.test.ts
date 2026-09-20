import { describe, expect, it } from "vitest";
import { vscodeUserDir } from "../../src/services/client-detection.js";
import {
  checkClientPolicies,
  type ClientPolicyIo,
  type RegistryHive
} from "../../src/services/client-policy.js";

type IoOverrides = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  /** path -> file content. */
  files?: Record<string, string>;
  /** Paths that exist but whose content is irrelevant (e.g. managed-mcp.json, never parsed). */
  existingPaths?: string[];
  /** `${hive}|${key}|${valueName}` -> value. */
  registry?: Record<string, string>;
};

function io(overrides: IoOverrides = {}): ClientPolicyIo {
  const files = overrides.files ?? {};
  const existing = new Set([...(overrides.existingPaths ?? []), ...Object.keys(files)]);
  return {
    env: overrides.env ?? {},
    platform: overrides.platform ?? "darwin",
    homedir: overrides.homedir ?? "/Users/tester",
    readFile: async (target) => files[target],
    pathExists: async (target) => existing.has(target),
    queryRegistry: async (hive: RegistryHive, key: string, valueName: string) =>
      overrides.registry?.[`${hive}|${key}|${valueName}`]
  };
}

const DARWIN_SETTINGS_PATH = `${vscodeUserDir({ env: {}, platform: "darwin", homedir: "/Users/tester" })}/settings.json`;

describe("checkClientPolicies: VS Code settings.json", () => {
  it("returns no findings when nothing is configured", async () => {
    expect(await checkClientPolicies(io())).toEqual([]);
  });

  it("flags chat.mcp.access: none as blocking", async () => {
    const findings = await checkClientPolicies(
      io({ files: { [DARWIN_SETTINGS_PATH]: JSON.stringify({ "chat.mcp.access": "none" }) } })
    );
    expect(findings).toEqual([
      {
        client: "vscode",
        policy: "chat.mcp.access",
        value: "none",
        blocks: true,
        source: DARWIN_SETTINGS_PATH
      }
    ]);
  });

  it("notes chat.mcp.access: registry without blocking", async () => {
    const findings = await checkClientPolicies(
      io({ files: { [DARWIN_SETTINGS_PATH]: JSON.stringify({ "chat.mcp.access": "registry" }) } })
    );
    expect(findings).toEqual([
      {
        client: "vscode",
        policy: "chat.mcp.access",
        value: "registry",
        blocks: false,
        source: DARWIN_SETTINGS_PATH
      }
    ]);
  });

  it("warns (non-blocking) on chat.mcp.collisionBehavior: suffix", async () => {
    const findings = await checkClientPolicies(
      io({ files: { [DARWIN_SETTINGS_PATH]: JSON.stringify({ "chat.mcp.collisionBehavior": "suffix" }) } })
    );
    expect(findings).toEqual([
      {
        client: "vscode",
        policy: "chat.mcp.collisionBehavior",
        value: "suffix",
        blocks: false,
        source: DARWIN_SETTINGS_PATH
      }
    ]);
  });

  it("records chat.mcp.autostart informationally", async () => {
    const findings = await checkClientPolicies(
      io({ files: { [DARWIN_SETTINGS_PATH]: JSON.stringify({ "chat.mcp.autostart": "newAndOutdated" }) } })
    );
    expect(findings).toEqual([
      {
        client: "vscode",
        policy: "chat.mcp.autostart",
        value: "newAndOutdated",
        blocks: false,
        source: DARWIN_SETTINGS_PATH
      }
    ]);
  });

  it("parses settings.json leniently (comments and trailing commas)", async () => {
    const jsonc = [
      "{",
      "  // disabled machine-wide",
      '  "chat.mcp.access": "none",',
      "  /* trailing comma below */",
      '  "other.setting": true,',
      "}"
    ].join("\n");
    const findings = await checkClientPolicies(io({ files: { [DARWIN_SETTINGS_PATH]: jsonc } }));
    expect(findings).toEqual([
      {
        client: "vscode",
        policy: "chat.mcp.access",
        value: "none",
        blocks: true,
        source: DARWIN_SETTINGS_PATH
      }
    ]);
  });

  it("does not corrupt a string containing ',]' while still stripping real trailing commas and comments", async () => {
    const jsonc = [
      "{",
      "  // leading comment with // inside",
      '  "chat.mcp.autostart": "a,]",',
      '  "chat.mcp.access": "none",',
      "}"
    ].join("\n");
    const findings = await checkClientPolicies(io({ files: { [DARWIN_SETTINGS_PATH]: jsonc } }));
    expect(findings).toEqual([
      {
        client: "vscode",
        policy: "chat.mcp.access",
        value: "none",
        blocks: true,
        source: DARWIN_SETTINGS_PATH
      },
      {
        client: "vscode",
        policy: "chat.mcp.autostart",
        value: "a,]",
        blocks: false,
        source: DARWIN_SETTINGS_PATH
      }
    ]);
  });

  it("caps an oversized chat.mcp.autostart value and coerces a non-string value to text", async () => {
    const longValue = "x".repeat(200);
    const findings = await checkClientPolicies(
      io({ files: { [DARWIN_SETTINGS_PATH]: JSON.stringify({ "chat.mcp.autostart": longValue }) } })
    );
    expect(findings).toEqual([
      {
        client: "vscode",
        policy: "chat.mcp.autostart",
        value: `${"x".repeat(64)}…`,
        blocks: false,
        source: DARWIN_SETTINGS_PATH
      }
    ]);

    const boolFindings = await checkClientPolicies(
      io({ files: { [DARWIN_SETTINGS_PATH]: JSON.stringify({ "chat.mcp.autostart": false }) } })
    );
    expect(boolFindings).toEqual([
      {
        client: "vscode",
        policy: "chat.mcp.autostart",
        value: "false",
        blocks: false,
        source: DARWIN_SETTINGS_PATH
      }
    ]);
  });

  it("reports an unreadable settings.json without throwing", async () => {
    const findings = await checkClientPolicies(
      io({ files: { [DARWIN_SETTINGS_PATH]: "{ not json at all" } })
    );
    expect(findings).toEqual([
      {
        client: "vscode",
        policy: "settings.json",
        value: "unreadable",
        blocks: false,
        source: DARWIN_SETTINGS_PATH
      }
    ]);
  });
});

describe("checkClientPolicies: VS Code Windows Group Policy", () => {
  it("queries HKCU and HKLM ChatMCP only on win32", async () => {
    const findings = await checkClientPolicies(
      io({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
        registry: { "HKCU|SOFTWARE\\Policies\\Microsoft\\VSCode|ChatMCP": "0" }
      })
    );
    expect(findings).toEqual([
      {
        client: "vscode",
        policy: "ChatMCP (Group Policy)",
        value: "0",
        blocks: true,
        source: "HKCU\\SOFTWARE\\Policies\\Microsoft\\VSCode\\ChatMCP"
      }
    ]);
  });

  it("does not treat a non-blocking registry value as blocking", async () => {
    const findings = await checkClientPolicies(
      io({
        platform: "win32",
        registry: { "HKLM|SOFTWARE\\Policies\\Microsoft\\VSCode|ChatMCP": "enabled" }
      })
    );
    expect(findings).toEqual([
      {
        client: "vscode",
        policy: "ChatMCP (Group Policy)",
        value: "enabled",
        blocks: false,
        source: "HKLM\\SOFTWARE\\Policies\\Microsoft\\VSCode\\ChatMCP"
      }
    ]);
  });

  it("never queries the registry on non-Windows platforms", async () => {
    let called = false;
    const base = io({ platform: "darwin" });
    const findings = await checkClientPolicies({
      ...base,
      queryRegistry: async (hive, key, valueName) => {
        called = true;
        return base.queryRegistry(hive, key, valueName);
      }
    });
    expect(called).toBe(false);
    expect(findings).toEqual([]);
  });
});

describe("checkClientPolicies: Claude Code managed-mcp.json", () => {
  it("reports presence on macOS without parsing it", async () => {
    const managedPath = "/Library/Application Support/ClaudeCode/managed-mcp.json";
    const findings = await checkClientPolicies(io({ platform: "darwin", existingPaths: [managedPath] }));
    expect(findings).toEqual([
      { client: "claude", policy: "managed-mcp.json", value: "present", blocks: false, source: managedPath }
    ]);
  });

  it("reports presence on Linux at /etc/claude-code/managed-mcp.json", async () => {
    const managedPath = "/etc/claude-code/managed-mcp.json";
    const findings = await checkClientPolicies(io({ platform: "linux", existingPaths: [managedPath] }));
    expect(findings).toEqual([
      { client: "claude", policy: "managed-mcp.json", value: "present", blocks: false, source: managedPath }
    ]);
  });

  it("reports presence on Windows under %ProgramData%", async () => {
    const managedPath = "D:\\ProgramData\\ClaudeCode\\managed-mcp.json";
    const findings = await checkClientPolicies(
      io({ platform: "win32", env: { ProgramData: "D:\\ProgramData" }, existingPaths: [managedPath] })
    );
    expect(findings).toEqual([
      { client: "claude", policy: "managed-mcp.json", value: "present", blocks: false, source: managedPath }
    ]);
  });

  it("reports nothing when managed-mcp.json is absent", async () => {
    expect(await checkClientPolicies(io({ platform: "darwin" }))).toEqual([]);
  });
});

describe("checkClientPolicies: Codex config.toml", () => {
  it("flags [mcp_servers.m365-agents] enabled = false as blocking", async () => {
    const configPath = "/Users/tester/.codex/config.toml";
    const findings = await checkClientPolicies(
      io({ files: { [configPath]: "[mcp_servers.m365-agents]\nenabled = false\n" } })
    );
    expect(findings).toEqual([
      {
        client: "codex",
        policy: "mcp_servers.m365-agents.enabled",
        value: "false",
        blocks: true,
        source: configPath
      }
    ]);
  });

  it("reports nothing when the entry is enabled or absent", async () => {
    const configPath = "/Users/tester/.codex/config.toml";
    const enabledTrue = await checkClientPolicies(
      io({ files: { [configPath]: "[mcp_servers.m365-agents]\nenabled = true\n" } })
    );
    expect(enabledTrue).toEqual([]);

    const noEntry = await checkClientPolicies(io({ files: { [configPath]: "[other]\nfoo = 1\n" } }));
    expect(noEntry).toEqual([]);

    expect(await checkClientPolicies(io())).toEqual([]);
  });

  it("reports an unreadable config.toml without throwing", async () => {
    const configPath = "/Users/tester/.codex/config.toml";
    const findings = await checkClientPolicies(io({ files: { [configPath]: "not [ valid toml" } }));
    expect(findings).toEqual([
      { client: "codex", policy: "config.toml", value: "unreadable", blocks: false, source: configPath }
    ]);
  });
});
