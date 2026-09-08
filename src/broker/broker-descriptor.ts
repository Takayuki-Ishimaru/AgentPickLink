import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import type { AppPaths } from "../config/paths.js";
import { atomicWrite, readText } from "../config/storage.js";
import type { BrokerDescriptor } from "../ipc/protocol.js";
export async function writeDescriptor(paths: AppPaths, descriptor: BrokerDescriptor): Promise<void> {
  await atomicWrite(paths.descriptor, `${JSON.stringify(descriptor)}\n`);
}
export async function readDescriptor(paths: AppPaths): Promise<BrokerDescriptor | undefined> {
  const text = await readText(paths.descriptor);
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as BrokerDescriptor;
    if (!Number.isInteger(value.pid) || !value.pipeName || !value.authSecret || !value.instanceId)
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
export async function removeDescriptor(paths: AppPaths): Promise<void> {
  await fs.unlink(paths.descriptor).catch(() => undefined);
}
export async function removeDescriptorIfOwned(paths: AppPaths, instanceId: string): Promise<void> {
  const current = await readDescriptor(paths);
  if (current?.instanceId === instanceId) await removeDescriptor(paths);
}
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** Windows uses a per-user named-pipe namespace; non-Windows is only a local development fallback. */
export function userScopedPipeName(profileId = "default"): string {
  const safeProfile = profileId.replace(/[^A-Za-z0-9_-]/g, "_");
  const userHash = createHash("sha256")
    .update(`${os.userInfo().username}:${process.env.USERDOMAIN ?? "local"}`)
    .digest("hex")
    .slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\m365-agent-workspace-${userHash}-${safeProfile}`
    : `/tmp/m365-agent-workspace-${userHash}-${safeProfile}.sock`;
}
