import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultClientDetectionIo,
  detectClients,
  pathModuleFor,
  vscodeUserDir,
  type ClientDetectionIo
} from "../../src/services/client-detection.js";

type IoOverrides = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  /** Paths that exist. */
  existing?: string[];
  /** Subset of `existing` that is also executable (POSIX only); defaults to all of `existing`. */
  executable?: string[];
};

function io(overrides: IoOverrides = {}): ClientDetectionIo {
  const existing = new Set(overrides.existing ?? []);
  const executable = new Set(overrides.executable ?? overrides.existing ?? []);
  return {
    env: overrides.env ?? {},
    platform: overrides.platform ?? "darwin",
    homedir: overrides.homedir ?? "/Users/tester",
    pathExists: async (target) => existing.has(target),
    isExecutable: async (target) => executable.has(target)
  };
}

function byId(results: Awaited<ReturnType<typeof detectClients>>, id: "vscode" | "claude" | "codex") {
  const found = results.find((result) => result.id === id);
  if (!found) throw new Error(`detectClients did not return an entry for ${id}`);
  return found;
}

describe("pathModuleFor", () => {
  it("selects win32 or posix based on the injected platform, not the host OS", () => {
    expect(pathModuleFor("win32")).toBe(path.win32);
    expect(pathModuleFor("darwin")).toBe(path.posix);
    expect(pathModuleFor("linux")).toBe(path.posix);
  });
});

describe("vscodeUserDir", () => {
  it("resolves the Windows, macOS and Linux user data directories", () => {
    expect(
      vscodeUserDir({
        env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
        platform: "win32",
        homedir: "C:\\Users\\tester"
      })
    ).toBe("C:\\Users\\tester\\AppData\\Roaming\\Code\\User");
    expect(vscodeUserDir({ env: {}, platform: "darwin", homedir: "/Users/tester" })).toBe(
      "/Users/tester/Library/Application Support/Code/User"
    );
    expect(vscodeUserDir({ env: {}, platform: "linux", homedir: "/home/tester" })).toBe(
      "/home/tester/.config/Code/User"
    );
  });

  it("falls back to homedir/AppData/Roaming on win32 when APPDATA is unset", () => {
    expect(vscodeUserDir({ env: {}, platform: "win32", homedir: "C:\\Users\\tester" })).toBe(
      "C:\\Users\\tester\\AppData\\Roaming\\Code\\User"
    );
  });
});

describe("defaultClientDetectionIo", () => {
  it("reflects the real host and never throws", async () => {
    const real = defaultClientDetectionIo();
    expect(real.platform).toBe(process.platform);
    await expect(real.pathExists("/definitely/not/a/real/path/apl-test")).resolves.toBe(false);
    await expect(real.isExecutable("/definitely/not/a/real/path/apl-test")).resolves.toBe(false);
  });
});

describe("detectClients", () => {
  it("reports every client as not installed when nothing matches", async () => {
    const results = await detectClients(io());
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.installed).toBe(false);
      expect(result.evidence).toEqual([]);
    }
  });

  it("detects VS Code via `code` on PATH (POSIX)", async () => {
    const results = await detectClients(
      io({
        env: { PATH: "/usr/local/bin:/opt/homebrew/bin" },
        existing: ["/usr/local/bin/code"]
      })
    );
    expect(byId(results, "vscode")).toMatchObject({ installed: true, evidence: ["code on PATH"] });
  });

  it("does not count a PATH match that exists but is not executable (POSIX)", async () => {
    const results = await detectClients(
      io({
        env: { PATH: "/usr/local/bin" },
        existing: ["/usr/local/bin/code"],
        executable: []
      })
    );
    expect(byId(results, "vscode")).toMatchObject({ installed: false, evidence: [] });
  });

  it("detects VS Code via the macOS application bundle", async () => {
    const results = await detectClients(
      io({ platform: "darwin", existing: ["/Applications/Visual Studio Code.app"] })
    );
    expect(byId(results, "vscode")).toMatchObject({
      installed: true,
      evidence: ["Visual Studio Code.app in /Applications"]
    });
  });

  it("detects VS Code via the user data directory", async () => {
    const userDir = "/Users/tester/Library/Application Support/Code/User";
    const results = await detectClients(io({ platform: "darwin", existing: [userDir] }));
    expect(byId(results, "vscode")).toMatchObject({
      installed: true,
      evidence: ["VS Code user data dir present"]
    });
  });

  it("detects VS Code on win32 via PATHEXT-aware PATH lookup", async () => {
    // The fake `pathExists` below is a case-sensitive exact-string match (unlike a real Windows
    // filesystem), so the PATHEXT entry and the fixture's filename must agree on case.
    const results = await detectClients(
      io({
        platform: "win32",
        env: { Path: "C:\\tools", PATHEXT: ".EXE;.CMD" },
        existing: ["C:\\tools\\code.CMD"]
      })
    );
    expect(byId(results, "vscode")).toMatchObject({ installed: true, evidence: ["code on PATH"] });
  });

  it("detects VS Code on win32 via Code.exe under %LOCALAPPDATA%", async () => {
    const exe = "C:\\Users\\tester\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
    const results = await detectClients(
      io({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
        existing: [exe]
      })
    );
    expect(byId(results, "vscode")).toMatchObject({
      installed: true,
      evidence: ["Code.exe under %LOCALAPPDATA%"]
    });
  });

  it("detects VS Code Insiders on win32 via the per-user %LOCALAPPDATA% install", async () => {
    const exe =
      "C:\\Users\\tester\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe";
    const results = await detectClients(
      io({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
        existing: [exe]
      })
    );
    expect(byId(results, "vscode")).toMatchObject({
      installed: true,
      evidence: ["Code - Insiders.exe under %LOCALAPPDATA%"]
    });
  });

  it("detects VS Code on win32 via the system-wide %ProgramFiles% install", async () => {
    const exe = "C:\\Program Files\\Microsoft VS Code\\Code.exe";
    const results = await detectClients(
      io({ platform: "win32", env: { ProgramFiles: "C:\\Program Files" }, existing: [exe] })
    );
    expect(byId(results, "vscode")).toMatchObject({
      installed: true,
      evidence: ["Code.exe under %ProgramFiles%"]
    });
  });

  it("detects VS Code Insiders on win32 via the system-wide %ProgramFiles% install", async () => {
    const exe = "C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe";
    const results = await detectClients(
      io({ platform: "win32", env: { ProgramFiles: "C:\\Program Files" }, existing: [exe] })
    );
    expect(byId(results, "vscode")).toMatchObject({
      installed: true,
      evidence: ["Code - Insiders.exe under %ProgramFiles%"]
    });
  });

  it("detects VS Code and VS Code Insiders on win32 via the %ProgramFiles(x86)% install", async () => {
    const results = await detectClients(
      io({
        platform: "win32",
        env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
        existing: [
          "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",
          "C:\\Program Files (x86)\\Microsoft VS Code Insiders\\Code - Insiders.exe"
        ]
      })
    );
    expect(byId(results, "vscode")).toMatchObject({
      installed: true,
      evidence: ["Code.exe under %ProgramFiles(x86)%", "Code - Insiders.exe under %ProgramFiles(x86)%"]
    });
  });

  it("detects VS Code Insiders on macOS via the application bundle", async () => {
    const results = await detectClients(
      io({ platform: "darwin", existing: ["/Applications/Visual Studio Code - Insiders.app"] })
    );
    expect(byId(results, "vscode")).toMatchObject({
      installed: true,
      evidence: ["Visual Studio Code - Insiders.app in /Applications"]
    });
  });

  it("detects Claude Code via `claude` on PATH, ~/.claude.json and ~/.claude/", async () => {
    const onPath = await detectClients(
      io({ env: { PATH: "/usr/local/bin" }, existing: ["/usr/local/bin/claude"] })
    );
    expect(byId(onPath, "claude")).toMatchObject({ installed: true, evidence: ["claude on PATH"] });

    const viaJson = await detectClients(
      io({ homedir: "/Users/tester", existing: ["/Users/tester/.claude.json"] })
    );
    expect(byId(viaJson, "claude")).toMatchObject({ installed: true, evidence: ["~/.claude.json present"] });

    const viaDir = await detectClients(io({ homedir: "/Users/tester", existing: ["/Users/tester/.claude"] }));
    expect(byId(viaDir, "claude")).toMatchObject({ installed: true, evidence: ["~/.claude/ present"] });
  });

  it("detects Codex via `codex` on PATH and ~/.codex/", async () => {
    const onPath = await detectClients(
      io({ env: { PATH: "/usr/local/bin" }, existing: ["/usr/local/bin/codex"] })
    );
    expect(byId(onPath, "codex")).toMatchObject({ installed: true, evidence: ["codex on PATH"] });

    const viaDir = await detectClients(io({ homedir: "/Users/tester", existing: ["/Users/tester/.codex"] }));
    expect(byId(viaDir, "codex")).toMatchObject({ installed: true, evidence: ["~/.codex/ present"] });
  });

  it("never reports file contents as evidence", async () => {
    const results = await detectClients(
      io({
        env: { PATH: "/usr/local/bin" },
        existing: ["/usr/local/bin/code", "/usr/local/bin/claude", "/usr/local/bin/codex"]
      })
    );
    for (const result of results) for (const item of result.evidence) expect(item).not.toMatch(/[{[]/);
  });
});
