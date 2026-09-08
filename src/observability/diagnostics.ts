import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, ensurePrivateDirectory } from "../config/storage.js";
import { redactMetadata } from "./redact.js";

export type FailureDiagnostic = {
  requestId: string;
  adapterId?: string;
  uiFingerprint?: Record<string, boolean | number | string>;
  hostname?: string;
  sanitizedPathPattern?: string;
  composerCandidateCount?: number;
  messageContainerCount?: number;
  identitySignalHashes?: string[];
  stateTransitions: string[];
  errorCode: string;
};

export async function writeFailureDiagnostic(
  directory: string,
  diagnostic: FailureDiagnostic
): Promise<void> {
  await ensurePrivateDirectory(directory);
  const safe = redactMetadata(diagnostic as unknown as Record<string, unknown>);
  const requestId =
    typeof safe.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(safe.requestId)
      ? safe.requestId
      : "failure";
  await atomicWrite(path.join(directory, `${requestId}.json`), `${JSON.stringify(safe, null, 2)}\n`);
}

export async function cleanupDiagnostics(directory: string, retentionHours: number): Promise<number> {
  const entries = await readdir(directory).catch(() => []);
  const cutoff = Date.now() - retentionHours * 60 * 60_000;
  let removed = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry);
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs < cutoff) {
      await unlink(file).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}
