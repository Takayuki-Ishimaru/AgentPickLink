import type { ApprovalStore } from "../domain/approval.js";
import { ApprovalStoreSchema } from "./schema.js";
import { atomicWrite, readText, withFileLock } from "./storage.js";
import type { AppPaths } from "./paths.js";
import { migrateStore } from "./migrations.js";
export async function loadApprovals(paths: AppPaths): Promise<ApprovalStore> {
  const text = await readText(paths.approvals);
  return ApprovalStoreSchema.parse(
    text === undefined ? { version: 1, approvals: [] } : migrateStore("approvals", JSON.parse(text))
  );
}
export async function saveApprovals(paths: AppPaths, store: ApprovalStore): Promise<void> {
  await withFileLock(`${paths.approvals}.lock`, () =>
    atomicWrite(paths.approvals, `${JSON.stringify(ApprovalStoreSchema.parse(store), null, 2)}\n`)
  );
}
