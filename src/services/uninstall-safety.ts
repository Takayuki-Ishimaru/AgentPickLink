import YAML from "yaml";
import { loadRegistry } from "../config/registry.js";
import { loadApprovals } from "../config/approvals.js";
import { listProfileBrowserProcesses } from "../broker/profile-processes.js";
import lockfile from "proper-lockfile";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError } from "../domain/errors.js";
import type { CommandDeps } from "../cli/command-deps.js";
import { removeDescriptorIfOwned } from "../broker/broker-descriptor.js";
import { assertInstallPath } from "./install-home.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { ProfileManager } from "../transports/browser/profile-manager.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function blocked(message: string): never {
  throw new DomainError("POLICY_BLOCKED", message, false, {
    remediation: "Close clients using AgentPickLink and retry. No installation files were removed."
  });
}

/** Called under the broker startup lock. No force-kill, and no connect-or-start. */
export async function stopOwnedInstallBroker(
  deps: CommandDeps,
  home: string,
  purge: boolean,
  timeoutMs = 10_000
): Promise<void> {
  const descriptor = await deps.readDescriptor(deps.paths);
  if (!descriptor) {
    // A malformed descriptor cannot establish either identity or absence of a live owner.
    if (
      await fs.lstat(deps.paths.descriptor).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      )
    )
      blocked("Cannot verify the broker descriptor.");
    return;
  }
  if (!alive(descriptor.pid)) {
    if (descriptor.browserPid && alive(descriptor.browserPid))
      blocked("The stopped broker still has a live browser; close it before uninstalling or purging data.");
    await removeDescriptorIfOwned(deps.paths, descriptor.instanceId);
    if (
      await fs.lstat(deps.paths.descriptor).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      )
    )
      blocked("The stopped broker descriptor could not be removed.");
    return;
  }
  const entry = descriptor.build?.entry;
  const canonicalHome = await fs.realpath(home);
  const canonicalEntry =
    entry && path.isAbsolute(entry) ? await fs.realpath(entry).catch(() => entry) : undefined;
  const candidates = canonicalEntry
    ? [path.relative(canonicalHome, canonicalEntry), path.relative(home, entry!)]
    : [];
  const relative = candidates.find((item) =>
    /^app[/\\][^/\\]+[/\\]dist[/\\]broker[/\\]process\.js$/.test(item)
  );
  const owned = relative !== undefined;
  if (owned) {
    try {
      await assertInstallPath(home, relative, "file");
    } catch {
      blocked("The broker entry belongs to this installation but its file ownership cannot be verified.");
    }
  }
  if (!owned) {
    if (purge || !entry)
      blocked("Application data is used by a broker whose installation ownership cannot be confirmed.");
    return;
  }
  const client = await deps.connectExistingBroker(deps.paths);
  if (!client) blocked("The installation's broker could not be contacted.");
  try {
    const hello = await client.connect();
    const current = await deps.readDescriptor(deps.paths);
    if (hello.instanceId !== descriptor.instanceId || current?.instanceId !== descriptor.instanceId)
      blocked("The running broker changed during uninstall.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await client.call("broker.shutdown", {}, undefined, controller.signal);
    } catch {
      /* The server can close the connection before replying; prove exit below. */
    } finally {
      clearTimeout(timer);
    }
  } finally {
    client.close();
  }
  const deadline = Date.now() + timeoutMs;
  while (alive(descriptor.pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (alive(descriptor.pid)) blocked("The installation's broker did not exit within the shutdown timeout.");
  if (descriptor.browserPid && alive(descriptor.browserPid))
    blocked("The installation's browser has not exited yet.");
  const current = await deps.readDescriptor(deps.paths);
  if (current && current.instanceId !== descriptor.instanceId)
    blocked("Another broker appeared during uninstall.");
  await removeDescriptorIfOwned(deps.paths, descriptor.instanceId);
  if (
    await fs.lstat(deps.paths.descriptor).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    )
  )
    blocked("The broker descriptor could not be removed.");
}

/** Purge only recognized local state; never recursively erase an arbitrary APP_DATA override. */
export async function validatePurgeData(
  deps: CommandDeps,
  home: string,
  heldLocks: readonly string[] = []
): Promise<void> {
  const root = path.resolve(deps.paths.root);
  if (
    !(await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }))
  )
    return;
  const canonical = await fs.realpath(root);
  for (const protectedPath of [home, deps.homedir(), deps.root()]) {
    const real = await fs.realpath(protectedPath).catch(() => path.resolve(protectedPath));
    const relative = path.relative(canonical, real);
    if (
      !relative ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    )
      blocked("The application data directory contains an installation, home, or workspace.");
  }
  if ((await fs.lstat(root)).isSymbolicLink()) blocked("Application data must not be a linked directory.");
  const allowed = new Set([
    "config.yaml",
    "agents.yaml",
    "approvals.json",
    "browser-profile",
    "broker",
    "logs",
    "diagnostics",
    "attachments",
    "init.lock",
    "config.yaml.lock",
    "agents.yaml.lock",
    "approvals.json.lock"
  ]);
  for (const name of heldLocks) allowed.add(name);
  const entries = await fs.readdir(root);
  if (entries.some((name) => !allowed.has(name)))
    blocked("Application data contains unrecognized files; purge was refused.");
  if (entries.some((name) => name !== "broker") && !entries.includes("config.yaml"))
    blocked("Application data has no valid configuration; purge was refused.");
  for (const name of entries)
    await assertInstallPath(
      root,
      name,
      ["browser-profile", "broker", "logs", "diagnostics", "attachments", ...heldLocks].includes(name)
        ? "directory"
        : "file"
    );
  if (entries.includes("config.yaml")) {
    const raw = YAML.parse(await fs.readFile(deps.paths.config, "utf8"));
    if (raw?.version !== 1 || typeof raw?.browser?.profilePath !== "string")
      blocked("Application data lacks explicit AgentPickLink configuration ownership; purge was refused.");
    await loadGlobalConfig(deps.paths, { readOnly: true });
    if (entries.includes("agents.yaml")) await loadRegistry(deps.paths);
    if (entries.includes("approvals.json")) await loadApprovals(deps.paths);
  }
  if (entries.includes("browser-profile")) await new ProfileManager(deps.paths.profile).verifyOwnership();
}

/** Keep the election lock alive so another installation cannot restart during a purge. */
export async function purgeLocalData(deps: CommandDeps, entries: readonly string[]): Promise<void> {
  for (const entry of entries) {
    if (entry === "broker") continue;
    await fs.rm(path.join(deps.paths.root, entry), { recursive: true, force: true });
  }
  await fs.rm(deps.paths.descriptor, { force: true });
}

/** Serialize purge with initialization, configuration, registry and approval writers. */
export async function lockPurgeData(
  deps: CommandDeps
): Promise<{ names: string[]; release: () => Promise<void> }> {
  const names: string[] = [];
  const releases: Array<() => Promise<void>> = [];
  const release = async () => {
    for (const unlock of releases.reverse()) await unlock();
  };
  try {
    for (const name of ["init.lock", "config.yaml.lock", "agents.yaml.lock", "approvals.json.lock"]) {
      const target = path.join(deps.paths.root, name);
      if (
        await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        })
      ) {
        releases.push(await lockfile.lock(target, { realpath: false, retries: 0 }));
        names.push(`${name}.lock`);
      }
    }
    return { names, release };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function assertPurgeProfileIdle(deps: CommandDeps): Promise<void> {
  if ((await listProfileBrowserProcesses(deps.paths.profile)).length)
    blocked("A browser still uses the application data profile. Close it before purging data.");
}
