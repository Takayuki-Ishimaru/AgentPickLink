import YAML from "yaml";
import type { BrowserAgentDefinition } from "../domain/agent.js";
import { RegistrySchema } from "./schema.js";
import { atomicWrite, readText, withFileLock } from "./storage.js";
import type { AppPaths } from "./paths.js";
import { migrateStore } from "./migrations.js";
export type Registry = { version: 1; agents: BrowserAgentDefinition[] };
export async function loadRegistry(paths: AppPaths): Promise<Registry> {
  const text = await readText(paths.registry);
  return RegistrySchema.parse(
    text === undefined ? { version: 1, agents: [] } : migrateStore("registry", YAML.parse(text))
  );
}
export async function saveRegistry(paths: AppPaths, registry: Registry): Promise<void> {
  await withFileLock(`${paths.registry}.lock`, () =>
    atomicWrite(paths.registry, YAML.stringify(RegistrySchema.parse(registry)))
  );
}

/** Read and update under the same lock so background metadata refreshes cannot overwrite a
 * registration saved by another window while discovery was running. Return false for no change. */
export async function updateRegistry(
  paths: AppPaths,
  update: (registry: Registry) => boolean
): Promise<Registry> {
  return withFileLock(`${paths.registry}.lock`, async () => {
    const registry = await loadRegistry(paths);
    if (update(registry)) await atomicWrite(paths.registry, YAML.stringify(RegistrySchema.parse(registry)));
    return registry;
  });
}
