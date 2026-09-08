import YAML from "yaml";
import type { GlobalConfig } from "./schema.js";
import { GlobalConfigSchema } from "./schema.js";
import { atomicWrite, readText, withFileLock } from "./storage.js";
import type { AppPaths } from "./paths.js";
import { migrateGlobalConfig } from "./migrations.js";
export const defaultGlobalConfig = (profilePath: string): GlobalConfig =>
  GlobalConfigSchema.parse({
    version: 1,
    downloadDefaultsVersion: 1,
    headlessDefaultsVersion: 1,
    browser: { profilePath }
  });
export async function loadGlobalConfig(paths: AppPaths): Promise<GlobalConfig> {
  const text = await readText(paths.config);
  if (text === undefined) return defaultGlobalConfig(paths.profile);
  const raw = YAML.parse(text);
  let migrated = migrateGlobalConfig(raw);
  if (JSON.stringify(migrated) !== JSON.stringify(raw)) migrated = await persistMigration(paths, migrated);
  const value = GlobalConfigSchema.parse(migrated);
  return {
    ...value,
    browser: { ...value.browser, profilePath: expandEnvironment(value.browser.profilePath) }
  };
}

/** Persist a config migration under the same lock used by ordinary saves. Re-read while holding
 * the lock so a concurrent settings write wins over a stale pre-lock read. */
async function persistMigration(paths: AppPaths, initial: unknown): Promise<unknown> {
  return withFileLock(`${paths.config}.lock`, async () => {
    const currentText = await readText(paths.config);
    if (currentText === undefined) return initial;
    const current = YAML.parse(currentText);
    const migrated = migrateGlobalConfig(current);
    if (JSON.stringify(migrated) !== JSON.stringify(current))
      await atomicWrite(paths.config, YAML.stringify(GlobalConfigSchema.parse(migrated)));
    return migrated;
  });
}
export async function saveGlobalConfig(paths: AppPaths, config: GlobalConfig): Promise<void> {
  await withFileLock(`${paths.config}.lock`, () =>
    atomicWrite(paths.config, YAML.stringify(GlobalConfigSchema.parse(config)))
  );
}
function expandEnvironment(value: string): string {
  return value.replace(/%([^%]+)%/g, (token, key: string) => process.env[key] ?? token);
}
