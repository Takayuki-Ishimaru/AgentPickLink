import type { AppPaths } from "./paths.js";
import path from "node:path";
import { ensurePrivateDirectories, ensurePrivateFiles, readText, withFileLock } from "./storage.js";
import { loadGlobalConfig, saveGlobalConfig } from "./global-config.js";
import { loadRegistry, saveRegistry } from "./registry.js";
import { loadApprovals, saveApprovals } from "./approvals.js";
import { assertSafeProfilePath } from "./profile-safety.js";

/**
 * Structural contract for preparing transport-owned local state (e.g. a browser profile
 * directory) during `m365-agent init`. This is intentionally a local, minimal shape rather than
 * an import of src/transports/transport.ts's (richer) LocalStatePreparer interface, so
 * src/config has no upward dependency on src/transports: any object satisfying this single
 * method -- including a transport's own LocalStatePreparer -- is structurally assignable here.
 * Composition roots (src/broker/process.ts, src/cli/runtime.ts) supply the real implementation
 * (browserLocalStatePreparer from src/transports/browser/local-state.ts).
 */
export interface LocalStatePreparer {
  prepareLocalState(profilePath: string): Promise<void>;
}

/** Creates only local protected state; it never starts a browser or touches Entra. */
export async function initializeLocalState(paths: AppPaths, preparer: LocalStatePreparer): Promise<AppPaths> {
  await assertSafeProfilePath(paths.profile);
  await ensurePrivateDirectories([
    paths.root,
    paths.broker,
    paths.logs,
    paths.diagnostics,
    paths.attachments
  ]);
  // Initialization and broker election are independent critical sections. A
  // spawned broker starts while its parent owns startup.lock, so reusing that
  // lock here would deadlock descriptor publication.
  await withFileLock(path.join(paths.root, "init.lock"), async () => {
    const existingConfig = await readText(paths.config);
    const existingRegistry = await readText(paths.registry);
    const existingApprovals = await readText(paths.approvals);
    const config = await loadGlobalConfig(paths);
    await assertSafeProfilePath(config.browser.profilePath);
    await preparer.prepareLocalState(config.browser.profilePath);
    const registry = await loadRegistry(paths);
    const approvals = await loadApprovals(paths);
    if (existingConfig === undefined) await saveGlobalConfig(paths, config);
    if (existingRegistry === undefined) await saveRegistry(paths, registry);
    if (existingApprovals === undefined) await saveApprovals(paths, approvals);
    const existingFiles = [
      existingConfig === undefined ? undefined : paths.config,
      existingRegistry === undefined ? undefined : paths.registry,
      existingApprovals === undefined ? undefined : paths.approvals
    ].filter((file): file is string => file !== undefined);
    await ensurePrivateFiles(existingFiles);
  });
  return paths;
}
