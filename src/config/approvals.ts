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
/** Read, mutate and write under the same lock so concurrent approvals from different windows
 * merge instead of overwriting each other. Callbacks must stay read-only for other stores. */
export async function updateApprovals<T>(
  paths: AppPaths,
  update: (store: ApprovalStore) => T | Promise<T>
): Promise<T> {
  return withFileLock(`${paths.approvals}.lock`, async () => {
    const store = await loadApprovals(paths);
    const result = await update(store);
    await atomicWrite(paths.approvals, `${JSON.stringify(ApprovalStoreSchema.parse(store), null, 2)}\n`);
    return result;
  });
}
export async function saveApprovals(paths: AppPaths, store: ApprovalStore): Promise<void> {
  await withFileLock(`${paths.approvals}.lock`, () =>
    atomicWrite(paths.approvals, `${JSON.stringify(ApprovalStoreSchema.parse(store), null, 2)}\n`)
  );
}
