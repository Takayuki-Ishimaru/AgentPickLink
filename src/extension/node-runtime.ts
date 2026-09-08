/**
 * Resolution of the Node.js runtime the extension uses to spawn the broker and the MCP stdio
 * frontend. Pure and injectable (see `NodeProbe`) so it can be unit tested without VS Code and
 * without touching the real filesystem: `tests/extension/node-runtime.test.ts`.
 *
 * Order (docs/ux-redesign.md §2.6): the `agentpicklink.nodePath` setting → `node` on PATH with
 * major >= 22 → well-known installation locations for the platform → VS Code's own Electron
 * binary run as Node (`ELECTRON_RUN_AS_NODE=1`).
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The minimum Node major version the CLI/broker support (package.json `engines.node`). */
export const MINIMUM_NODE_MAJOR = 22;

export type NodeRuntimeKind = "configured" | "path" | "known-location" | "electron";

export type NodeRuntime = {
  /** Absolute path (or bare `node`) to execute. */
  command: string;
  /** Environment additions required to make `command` behave like plain Node. */
  env: Record<string, string>;
  kind: NodeRuntimeKind;
  /** The `node --version` output without the leading `v`, when it could be probed. */
  version?: string;
};

export type NodeRuntimeResolution = NodeRuntime & {
  /** Non-fatal, metadata-only explanations of why earlier candidates were rejected. */
  warnings: string[];
};

/** The small slice of the platform `resolveNodeRuntime` needs; overridden wholesale in tests. */
export type NodeProbe = {
  /** Resolves with the process stdout, or rejects when the binary is missing/not executable. */
  run: (command: string, args: string[]) => Promise<string>;
  listDirectory: (directory: string) => Promise<string[]>;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** VS Code's Electron binary (`process.execPath` in the extension host). */
  execPath: string;
};

export function defaultNodeProbe(): NodeProbe {
  return {
    run: async (command, args) =>
      (await execFileAsync(command, args, { windowsHide: true, timeout: 5_000 })).stdout,
    listDirectory: (directory) => fs.readdir(directory),
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    execPath: process.execPath
  };
}

/** Parses `v22.14.0` / `22.14.0` into its major version, or `undefined` when unparseable. */
export function parseNodeMajor(version: string): number | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return Number(match[1]);
}

function normalizeVersion(stdout: string): string {
  return stdout.trim().replace(/^v/, "");
}

async function probeCandidate(
  probe: NodeProbe,
  command: string
): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  let stdout: string;
  try {
    stdout = await probe.run(command, ["--version"]);
  } catch {
    return { ok: false, reason: `${command} could not be executed` };
  }
  const version = normalizeVersion(stdout);
  const major = parseNodeMajor(version);
  if (major === undefined) return { ok: false, reason: `${command} reported an unreadable version` };
  if (major < MINIMUM_NODE_MAJOR)
    return { ok: false, reason: `${command} is Node ${version}; ${MINIMUM_NODE_MAJOR}+ is required` };
  return { ok: true, version };
}

/** Sorts `x.y.z` directory names newest first; unparseable names sort last. */
function compareVersionsDescending(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [-1, -1, -1];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return b[index] - a[index];
  return 0;
}

/**
 * Well-known install locations, most preferred first. `nvm` versions are expanded newest-first so
 * a user with several installed Node versions gets the newest one that satisfies the minimum.
 */
async function knownLocations(probe: NodeProbe): Promise<string[]> {
  // The probe carries its own platform (tests exercise win32 from macOS), so the path flavour has
  // to follow it rather than the host `path` module's default.
  const windows = probe.platform === "win32";
  const join = windows ? path.win32.join : path.posix.join;
  const candidates: string[] = [];
  if (windows) {
    for (const key of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
      const base = probe.env[key];
      if (base) candidates.push(join(base, "nodejs", "node.exe"));
    }
    const localAppData = probe.env.LOCALAPPDATA;
    if (localAppData) candidates.push(join(localAppData, "Programs", "nodejs", "node.exe"));
  } else {
    candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  }
  const nvmRoot = probe.env.NVM_DIR
    ? join(probe.env.NVM_DIR, "versions", "node")
    : join(probe.homedir, ".nvm", "versions", "node");
  const versions = await probe.listDirectory(nvmRoot).catch(() => [] as string[]);
  for (const version of [...versions].sort(compareVersionsDescending))
    candidates.push(join(nvmRoot, version, "bin", windows ? "node.exe" : "node"));
  return [...new Set(candidates)];
}

/**
 * Picks the Node runtime used for child processes. Never throws: the Electron fallback always
 * works because the extension host itself is running on it.
 */
export async function resolveNodeRuntime(
  configuredPath: string | undefined,
  probe: NodeProbe = defaultNodeProbe()
): Promise<NodeRuntimeResolution> {
  const warnings: string[] = [];
  const configured = configuredPath?.trim();
  if (configured) {
    const result = await probeCandidate(probe, configured);
    if (result.ok)
      return { command: configured, env: {}, kind: "configured", version: result.version, warnings };
    warnings.push(`agentpicklink.nodePath: ${result.reason}`);
  }

  const onPath = await probeCandidate(probe, "node");
  if (onPath.ok) return { command: "node", env: {}, kind: "path", version: onPath.version, warnings };
  warnings.push(onPath.reason);

  for (const candidate of await knownLocations(probe)) {
    const result = await probeCandidate(probe, candidate);
    if (result.ok)
      return { command: candidate, env: {}, kind: "known-location", version: result.version, warnings };
  }

  warnings.push("No Node.js 22+ was found; using VS Code's own Node runtime.");
  return { command: probe.execPath, env: { ELECTRON_RUN_AS_NODE: "1" }, kind: "electron", warnings };
}
