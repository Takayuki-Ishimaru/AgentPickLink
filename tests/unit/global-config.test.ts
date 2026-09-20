import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { DEFAULT_DOWNLOAD_HOSTS } from "../../src/config/defaults.js";
import { appPaths } from "../../src/config/paths.js";
import { migrateGlobalConfig } from "../../src/config/migrations.js";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/global-config.js";
import { GlobalConfigSchema } from "../../src/config/schema.js";

describe("global config download defaults migration", () => {
  it("enables standard downloads once for an old empty configuration", () => {
    const migrated = migrateGlobalConfig({
      version: 1,
      browser: { profilePath: "C:\\profile", acceptDownloads: false },
      navigation: { appHosts: [], authHosts: [], downloadHosts: [] }
    }) as {
      downloadDefaultsVersion: number;
      browser: { acceptDownloads: boolean };
      navigation: { downloadHosts: string[] };
    };

    expect(migrated.downloadDefaultsVersion).toBe(1);
    expect((migrated as { headlessDefaultsVersion: number }).headlessDefaultsVersion).toBe(1);
    expect(migrated.browser.acceptDownloads).toBe(true);
    expect(migrated.navigation.downloadHosts).toEqual([...DEFAULT_DOWNLOAD_HOSTS]);
  });

  it("hides a legacy visible automation browser exactly once", () => {
    const migrated = migrateGlobalConfig({
      version: 1,
      downloadDefaultsVersion: 1,
      browser: { profilePath: "C:\\profile", headless: false }
    }) as { headlessDefaultsVersion: number; browser: { headless: boolean } };

    expect(migrated.headlessDefaultsVersion).toBe(1);
    expect(migrated.browser.headless).toBe(true);

    const explicitDebug = {
      ...migrated,
      browser: { ...migrated.browser, headless: false }
    };
    expect(migrateGlobalConfig(explicitDebug)).toEqual(explicitDebug);
  });

  it("preserves custom hosts during migration and never re-enables an explicit post-migration disable", () => {
    const custom = {
      version: 1,
      browser: { profilePath: "C:\\profile", acceptDownloads: false },
      navigation: { appHosts: [], authHosts: [], downloadHosts: ["files.example.com"] }
    };
    const migrated = migrateGlobalConfig(custom) as {
      browser: { acceptDownloads: boolean };
      navigation: { downloadHosts: string[] };
    };
    expect(migrated.browser.acceptDownloads).toBe(false);
    expect(migrated.navigation.downloadHosts).toEqual(["files.example.com"]);

    const explicitlyDisabled = {
      ...migrated,
      browser: { ...migrated.browser, acceptDownloads: false },
      navigation: { ...migrated.navigation, downloadHosts: [] }
    };
    expect(migrateGlobalConfig(explicitlyDisabled)).toEqual(explicitlyDisabled);
  });

  it("leaves unknown markers and invalid browser/navigation shapes for strict schema rejection", () => {
    expect(migrateGlobalConfig({ version: 1, downloadDefaultsVersion: 2 })).toEqual({
      version: 1,
      downloadDefaultsVersion: 2
    });
    expect(
      GlobalConfigSchema.safeParse({
        version: 1,
        downloadDefaultsVersion: 2,
        browser: { profilePath: "C:\\profile" }
      }).success
    ).toBe(false);
    expect(
      migrateGlobalConfig({
        version: 1,
        browser: null,
        navigation: "invalid"
      })
    ).toEqual({
      version: 1,
      downloadDefaultsVersion: 1,
      headlessDefaultsVersion: 1,
      browser: null,
      navigation: "invalid"
    });
    const invalidAccept = migrateGlobalConfig({
      version: 1,
      browser: { profilePath: "C:\\profile", acceptDownloads: "false" },
      navigation: { downloadHosts: [] }
    });
    expect(GlobalConfigSchema.safeParse(invalidAccept).success).toBe(false);
  });

  it("persists the marker so a later explicit empty/disabled setting remains unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "apl-global-config-"));
    const paths = appPaths(path.join(root, "appdata"));
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(
      paths.config,
      YAML.stringify({
        version: 1,
        browser: { profilePath: paths.profile, acceptDownloads: false },
        navigation: { appHosts: [], authHosts: [], downloadHosts: [] }
      }),
      { encoding: "utf8" }
    );

    const migrated = await loadGlobalConfig(paths);
    expect(migrated.browser.acceptDownloads).toBe(true);
    expect(migrated.browser.headless).toBe(true);
    expect(migrated.navigation.downloadHosts).toEqual([...DEFAULT_DOWNLOAD_HOSTS]);
    const persisted = YAML.parse(await readFile(paths.config, "utf8"));
    expect(persisted.downloadDefaultsVersion).toBe(1);
    expect(persisted.headlessDefaultsVersion).toBe(1);

    await saveGlobalConfig(paths, {
      ...migrated,
      browser: { ...migrated.browser, acceptDownloads: false },
      navigation: { ...migrated.navigation, downloadHosts: [] }
    });
    const reloaded = await loadGlobalConfig(paths);
    expect(reloaded.browser.acceptDownloads).toBe(false);
    expect(reloaded.navigation.downloadHosts).toEqual([]);
  });
});

/* §4.4: the pre-4.4 `clients:` keys (`vscode`/`claude`, meaning the workspace/project-scope file
 * of that era) are renamed to their explicit new spellings on load. */
describe("global config clients: key migration (§4.4)", () => {
  it("renames the old vscode/claude keys to vscodeWorkspace/claudeProject, keeping vscodeUser/codex", () => {
    const migrated = migrateGlobalConfig({
      version: 1,
      downloadDefaultsVersion: 1,
      headlessDefaultsVersion: 1,
      browser: { profilePath: "/profile" },
      clients: { vscode: true, vscodeUser: false, claude: true, codex: true }
    }) as { clients: Record<string, unknown> };

    expect(migrated.clients).toEqual({
      vscodeWorkspace: true,
      vscodeUser: false,
      claudeProject: true,
      codex: true
    });
    expect(GlobalConfigSchema.safeParse(migrated).success).toBe(true);
  });

  it("is a no-op when the clients block already uses the new keys", () => {
    const value = {
      version: 1,
      downloadDefaultsVersion: 1,
      headlessDefaultsVersion: 1,
      browser: { profilePath: "/profile" },
      clients: {
        vscodeUser: true,
        vscodeWorkspace: false,
        claudeUser: true,
        claudeProject: false,
        codex: false
      }
    };
    expect(migrateGlobalConfig(value)).toEqual(value);
  });

  it("never overwrites an already-present new key with the old one's value", () => {
    const migrated = migrateGlobalConfig({
      version: 1,
      downloadDefaultsVersion: 1,
      headlessDefaultsVersion: 1,
      browser: { profilePath: "/profile" },
      clients: { vscode: true, vscodeWorkspace: false, claude: true, claudeProject: false, codex: false }
    }) as { clients: Record<string, unknown> };

    expect(migrated.clients.vscodeWorkspace).toBe(false);
    expect(migrated.clients.claudeProject).toBe(false);
    expect(migrated.clients).not.toHaveProperty("vscode");
    expect(migrated.clients).not.toHaveProperty("claude");
  });

  it("leaves a config with no clients block at all untouched", () => {
    const value = {
      version: 1,
      downloadDefaultsVersion: 1,
      headlessDefaultsVersion: 1,
      browser: { profilePath: "/profile" }
    };
    expect(migrateGlobalConfig(value)).toEqual(value);
  });

  it("round-trips through loadGlobalConfig/saveGlobalConfig, persisting the renamed keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "apl-global-config-clients-"));
    const paths = appPaths(path.join(root, "appdata"));
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(
      paths.config,
      YAML.stringify({
        version: 1,
        downloadDefaultsVersion: 1,
        headlessDefaultsVersion: 1,
        browser: { profilePath: paths.profile },
        clients: { vscode: true, claude: false, codex: true }
      }),
      { encoding: "utf8" }
    );

    const loaded = await loadGlobalConfig(paths);
    expect(loaded.clients).toEqual({
      vscodeUser: false,
      vscodeWorkspace: true,
      claudeUser: false,
      claudeProject: false,
      codex: true
    });
    const persisted = YAML.parse(await readFile(paths.config, "utf8"));
    expect(persisted.clients).not.toHaveProperty("vscode");
    expect(persisted.clients.vscodeWorkspace).toBe(true);
  });
});
