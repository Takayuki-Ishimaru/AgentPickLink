/**
 * Presence-only detection of the three MCP clients AgentPickLink supports (docs/extension-less-
 * onboarding.md §4.3): VS Code, Claude Code and Codex. Shared by the future `install` command,
 * `integrations status` and `doctor`.
 *
 * Detection never reads configuration content -- only whether an executable or a well-known
 * directory exists -- and every filesystem/PATH/OS lookup is injectable so the Windows and macOS
 * branches can both be exercised from a single-OS test run (`tests/services/client-detection.test.ts`).
 * `evidence` entries name which probe matched (e.g. "code on PATH"); they are metadata only and
 * never include file contents.
 */
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClientId = "vscode" | "claude" | "codex";

export type ClientDetectionResult = {
  id: ClientId;
  installed: boolean;
  /** Which probe(s) matched, e.g. "code on PATH". Metadata only -- never file contents. */
  evidence: string[];
};

/** Everything `detectClients` needs from the host; overridden wholesale in tests so the Windows
 * and macOS/Linux branches can both run from one OS. */
export type ClientDetectionIo = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  /** Resolves true when a file or directory exists at `target`. */
  pathExists: (target: string) => Promise<boolean>;
  /** Resolves true when `target` is directly executable by the current user (POSIX X_OK check;
   * meaningless on win32, where PATH lookup is existence-only and PATHEXT-driven instead). */
  isExecutable: (target: string) => Promise<boolean>;
};

export function defaultClientDetectionIo(): ClientDetectionIo {
  return {
    env: process.env,
    platform: process.platform,
    homedir: os.homedir(),
    pathExists: async (target) => {
      try {
        await fs.access(target);
        return true;
      } catch {
        return false;
      }
    },
    isExecutable: async (target) => {
      try {
        await fs.access(target, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
  };
}

/** The path module (`win32` or `posix`) matching `platform`, independent of the host OS actually
 * running this process -- tests inject `platform: "win32"` from macOS/Linux. */
export function pathModuleFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** VS Code's per-user data directory: `%APPDATA%\Code\User`, `~/Library/Application Support/Code/User`,
 * or `~/.config/Code/User`. Exported for reuse by `client-policy.ts` (VS Code's `settings.json`
 * lives directly under it) and by the future `install`/`doctor` commands. */
export function vscodeUserDir(opts: Pick<ClientDetectionIo, "env" | "platform" | "homedir">): string {
  const { env, platform, homedir } = opts;
  const join = pathModuleFor(platform).join;
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(homedir, "AppData", "Roaming");
    return join(appData, "Code", "User");
  }
  if (platform === "darwin") return join(homedir, "Library", "Application Support", "Code", "User");
  return join(homedir, ".config", "Code", "User");
}

/** Splits a PATH-style environment variable for `platform`, dropping empty segments. */
function pathEntries(opts: Pick<ClientDetectionIo, "env" | "platform">): string[] {
  const raw = opts.platform === "win32" ? (opts.env.Path ?? opts.env.PATH) : opts.env.PATH;
  const delimiter = opts.platform === "win32" ? ";" : ":";
  return (raw ?? "").split(delimiter).filter((entry) => entry.length > 0);
}

/** True when `name` resolves to an executable on PATH: PATHEXT-aware existence check on win32,
 * an executable-bit check on POSIX. */
async function commandOnPath(name: string, io: ClientDetectionIo): Promise<boolean> {
  const join = pathModuleFor(io.platform).join;
  const dirs = pathEntries(io);
  if (io.platform === "win32") {
    const extensions = (io.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0);
    for (const dir of dirs) {
      for (const extension of extensions) {
        if (await io.pathExists(join(dir, `${name}${extension}`))) return true;
      }
    }
    return false;
  }
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if ((await io.pathExists(candidate)) && (await io.isExecutable(candidate))) return true;
  }
  return false;
}

async function detectVscode(io: ClientDetectionIo): Promise<ClientDetectionResult> {
  const evidence: string[] = [];
  if (await commandOnPath("code", io)) evidence.push("code on PATH");
  if (io.platform === "win32") {
    const join = pathModuleFor(io.platform).join;
    const localAppData = io.env.LOCALAPPDATA;
    if (localAppData) {
      const exe = join(localAppData, "Programs", "Microsoft VS Code", "Code.exe");
      if (await io.pathExists(exe)) evidence.push("Code.exe under %LOCALAPPDATA%");
      const insidersExe = join(localAppData, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe");
      if (await io.pathExists(insidersExe)) evidence.push("Code - Insiders.exe under %LOCALAPPDATA%");
    }
    // System-wide (per-machine) installs, as opposed to the per-user installer above.
    const programFiles = io.env.ProgramFiles;
    if (programFiles) {
      const exe = join(programFiles, "Microsoft VS Code", "Code.exe");
      if (await io.pathExists(exe)) evidence.push("Code.exe under %ProgramFiles%");
      const insidersExe = join(programFiles, "Microsoft VS Code Insiders", "Code - Insiders.exe");
      if (await io.pathExists(insidersExe)) evidence.push("Code - Insiders.exe under %ProgramFiles%");
    }
    const programFilesX86 = io.env["ProgramFiles(x86)"];
    if (programFilesX86) {
      const exe = join(programFilesX86, "Microsoft VS Code", "Code.exe");
      if (await io.pathExists(exe)) evidence.push("Code.exe under %ProgramFiles(x86)%");
      const insidersExe = join(programFilesX86, "Microsoft VS Code Insiders", "Code - Insiders.exe");
      if (await io.pathExists(insidersExe)) evidence.push("Code - Insiders.exe under %ProgramFiles(x86)%");
    }
  } else if (io.platform === "darwin") {
    if (await io.pathExists("/Applications/Visual Studio Code.app"))
      evidence.push("Visual Studio Code.app in /Applications");
    if (await io.pathExists("/Applications/Visual Studio Code - Insiders.app"))
      evidence.push("Visual Studio Code - Insiders.app in /Applications");
  }
  if (await io.pathExists(vscodeUserDir(io))) evidence.push("VS Code user data dir present");
  return { id: "vscode", installed: evidence.length > 0, evidence };
}

async function detectClaude(io: ClientDetectionIo): Promise<ClientDetectionResult> {
  const evidence: string[] = [];
  if (await commandOnPath("claude", io)) evidence.push("claude on PATH");
  const join = pathModuleFor(io.platform).join;
  if (await io.pathExists(join(io.homedir, ".claude.json"))) evidence.push("~/.claude.json present");
  if (await io.pathExists(join(io.homedir, ".claude"))) evidence.push("~/.claude/ present");
  return { id: "claude", installed: evidence.length > 0, evidence };
}

async function detectCodex(io: ClientDetectionIo): Promise<ClientDetectionResult> {
  const evidence: string[] = [];
  if (await commandOnPath("codex", io)) evidence.push("codex on PATH");
  const join = pathModuleFor(io.platform).join;
  if (await io.pathExists(join(io.homedir, ".codex"))) evidence.push("~/.codex/ present");
  return { id: "codex", installed: evidence.length > 0, evidence };
}

/**
 * Detects the three supported clients by presence only (§4.3): an executable on PATH, a
 * well-known install location, or a configuration home directory. Policy checks (whether a
 * detected client actually allows AgentPickLink to register) are a separate step -- see
 * `client-policy.ts` -- so a client that is installed but policy-blocked is still reported here as
 * installed.
 */
export async function detectClients(
  io: ClientDetectionIo = defaultClientDetectionIo()
): Promise<ClientDetectionResult[]> {
  return Promise.all([detectVscode(io), detectClaude(io), detectCodex(io)]);
}

/** True when the `claude` binary itself resolves on PATH (as opposed to `detectClaude`'s broader
 * "installed" check, which also matches `~/.claude.json`/`~/.claude/` alone) -- the §4.4/CLI
 * `claudeUser` writer's own signal for whether to prefer `claude mcp add-json ... --scope user`
 * over editing `~/.claude.json` directly (docs/extension-less-onboarding.md §4.3/§4.4). */
export async function isClaudeCliOnPath(
  io: ClientDetectionIo = defaultClientDetectionIo()
): Promise<boolean> {
  return commandOnPath("claude", io);
}
