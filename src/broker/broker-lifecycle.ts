import type { AppPaths } from "../config/paths.js";
import { readDescriptor, isPidAlive, removeDescriptorIfOwned } from "./broker-descriptor.js";
import { IpcClient } from "../ipc/client.js";
import { DomainError } from "../domain/errors.js";
import { withFileLock } from "../config/storage.js";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
/** Graceful browser/page operations may run up to the configured 5-minute response budget. */
export const BROKER_STOP_TIMEOUT_MS = 5 * 60_000;
export async function connectExistingBroker(paths: AppPaths): Promise<IpcClient | undefined> {
  const descriptor = await readDescriptor(paths);
  if (!descriptor) return undefined;
  if (!isPidAlive(descriptor.pid)) {
    await removeDescriptorIfOwned(paths, descriptor.instanceId);
    return undefined;
  }
  if (descriptor.state === "stopping")
    throw new DomainError("BROKER_UNAVAILABLE", "The broker is shutting down.", true);
  const client = new IpcClient(descriptor);
  try {
    await client.connect();
    // The owner can publish `state: stopping` (or a replacement can publish a new instance) after
    // the initial descriptor read but before the handshake completes. Do not hand a new caller a
    // socket that is about to reject requests; it will re-enter election and wait for the owner.
    const current = await readDescriptor(paths);
    if (!current || current.instanceId !== descriptor.instanceId || current.state === "stopping") {
      client.close();
      throw new DomainError("BROKER_UNAVAILABLE", "The broker is shutting down.", true);
    }
    return client;
  } catch (error) {
    client.close();
    if (
      error instanceof DomainError &&
      (error.code === "BROKER_VERSION_MISMATCH" || error.code === "BROKER_AUTH_FAILED")
    )
      throw error;
    throw new DomainError(
      "BROKER_UNAVAILABLE",
      "The broker descriptor exists but the broker is unavailable.",
      true
    );
  }
}
export type SpawnBroker = () => Promise<void>;
/** Implements the descriptor → handshake → startup-lock → recheck sequence from the broker contract. */
export async function connectOrStartBroker(
  paths: AppPaths,
  spawn: SpawnBroker,
  timeoutMs = 10_000
): Promise<IpcClient> {
  let existing: IpcClient | undefined;
  try {
    existing = await connectExistingBroker(paths);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "BROKER_UNAVAILABLE") throw error;
  }
  if (existing) return existing;
  return withFileLock(
    paths.startupLock,
    async () => {
      while (true) {
        try {
          const winner = await connectExistingBroker(paths);
          if (winner) return winner;
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== "BROKER_UNAVAILABLE") throw error;
          // A graceful shutdown removes the IPC endpoint before its descriptor. During that small
          // interval another client must wait for the owner to finish instead of concluding that the
          // profile is free (or reporting an unnecessary BROKER_UNAVAILABLE error).
          const stale = await readDescriptor(paths);
          if (stale && isPidAlive(stale.pid) && (await isExpectedBrokerProcess(stale.pid))) {
            // A wedged owner should not make every new client wait for the full browser startup
            // budget (which is 60s on Windows). A normal graceful stop releases this quickly; after
            // this short election window the caller can report an actionable unavailable error.
            const gone = await waitForDescriptorGone(
              paths,
              stale.instanceId,
              stale.state === "stopping" ? BROKER_STOP_TIMEOUT_MS : Math.min(timeoutMs, 2_000)
            );
            if (!gone)
              throw new DomainError(
                "BROKER_UNAVAILABLE",
                "The existing AgentPickLink broker process is alive but its IPC endpoint is not accepting connections.",
                true,
                { remediation: "Wait briefly and retry, or run: m365-agent broker restart" }
              );
            // The descriptor may have been replaced by another election winner. Re-read and
            // handshake before spawning anything, preserving the single-broker invariant.
            continue;
          }
          if (stale) await removeDescriptorIfOwned(paths, stale.instanceId);
        }
        break;
      }
      await spawn();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const client = await connectExistingBroker(paths).catch(() => undefined);
        if (client) return client;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      throw new DomainError(
        "BROKER_START_FAILED",
        "The broker did not publish an authenticated descriptor in time.",
        true
      );
    },
    // A broker can drain an in-flight browser request for the full response budget. Keep the
    // election lock wait bounded to that same budget so concurrent clients do not fail merely
    // because another client is coordinating a graceful restart.
    { timeoutMs: BROKER_STOP_TIMEOUT_MS }
  );
}

/** Waits for one broker owner to finish its shutdown. A descriptor whose PID is already dead is
 * stale and is removed safely; a live owner is never killed by this helper. */
export async function waitForDescriptorGone(
  paths: AppPaths,
  instanceId?: string,
  timeoutMs = BROKER_STOP_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const descriptor = await readDescriptor(paths);
    if (!descriptor || (instanceId !== undefined && descriptor.instanceId !== instanceId)) return true;
    if (!isPidAlive(descriptor.pid)) {
      await removeDescriptorIfOwned(paths, descriptor.instanceId);
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  const descriptor = await readDescriptor(paths);
  if (
    descriptor &&
    (instanceId === undefined || descriptor.instanceId === instanceId) &&
    !isPidAlive(descriptor.pid)
  ) {
    await removeDescriptorIfOwned(paths, descriptor.instanceId);
    return true;
  }
  return !descriptor || (instanceId !== undefined && descriptor.instanceId !== instanceId);
}

export async function spawnBundledBroker(): Promise<void> {
  const entry = fileURLToPath(new URL("./process.js", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
}

export async function connectOrStartDefaultBroker(paths: AppPaths): Promise<IpcClient> {
  // Windows can spend tens of seconds applying and verifying the private ACLs
  // before the broker is able to publish its descriptor. Keep the short Unix
  // default while allowing that expected initialization work to finish.
  return connectOrStartBroker(paths, spawnBundledBroker, process.platform === "win32" ? 60_000 : 10_000);
}

/** Explicit stop/restart fallback for an incompatible or unreachable broker. */
export async function terminateDescriptorBroker(
  paths: AppPaths,
  timeoutMs = 5_000
): Promise<{ stopped: boolean; pid?: number }> {
  const descriptor = await readDescriptor(paths);
  if (!descriptor) return { stopped: false };
  if (descriptor.pid === process.pid)
    throw new DomainError(
      "POLICY_BLOCKED",
      "Refusing to terminate the current process from a broker descriptor."
    );
  if (isPidAlive(descriptor.pid)) {
    if (!(await isExpectedBrokerProcess(descriptor.pid)))
      throw new DomainError(
        "POLICY_BLOCKED",
        "The descriptor PID does not identify an AgentPickLink broker process.",
        false,
        { remediation: "Inspect the stale descriptor and process manually; no process was terminated." }
      );
    try {
      process.kill(descriptor.pid, "SIGTERM");
    } catch {
      throw new DomainError("BROKER_UNAVAILABLE", "The broker process could not be stopped.", true);
    }
    const deadline = Date.now() + timeoutMs;
    while (isPidAlive(descriptor.pid) && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (isPidAlive(descriptor.pid))
      throw new DomainError("BROKER_UNAVAILABLE", "The broker did not stop before the timeout.", true);
  }
  // Once the process is definitely gone it can no longer own the profile or endpoint, so stale
  // descriptor cleanup is safe. A graceful broker removes it itself before exit; this fallback
  // also handles an older installed broker that exits without doing so.
  await removeDescriptorIfOwned(paths, descriptor.instanceId);
  return { stopped: true, pid: descriptor.pid };
}

async function isExpectedBrokerProcess(pid: number): Promise<boolean> {
  try {
    const command =
      process.platform === "win32"
        ? (
            await execFileAsync(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
              ],
              { windowsHide: true }
            )
          ).stdout
        : (await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { windowsHide: true })).stdout;
    return /(?:^|[\\/\s])broker[\\/]process\.js(?:[\s"']|$)/i.test(command);
  } catch {
    return false;
  }
}
