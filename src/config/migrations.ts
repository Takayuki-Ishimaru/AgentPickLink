import { DomainError, type ErrorCode } from "../domain/errors.js";
import { DEFAULT_DOWNLOAD_HOSTS } from "./defaults.js";

/** Every on-disk store kind AgentPickLink reads, keyed the same way across CLI, broker, and frontend. */
export type StoreKind = "global-config" | "registry" | "approvals" | "workspace-config";

const LABEL: Record<StoreKind, string> = {
  "global-config": "global configuration (config.yaml)",
  registry: "local agent registry (agents.yaml)",
  approvals: "local approval store (approvals.json)",
  "workspace-config": "workspace configuration (.m365-agents.json)"
};

const CODE: Record<StoreKind, ErrorCode> = {
  // Workspace config is repository-authored and travels with the repo, so its own stable
  // error code applies. The local, user-owned stores reuse POLICY_BLOCKED -- the same code
  // storage.ts already uses when sensitive local state fails a safety check (wrong ACL,
  // symlink, etc); an unreadable version is exactly that kind of failure.
  "global-config": "POLICY_BLOCKED",
  registry: "POLICY_BLOCKED",
  approvals: "POLICY_BLOCKED",
  "workspace-config": "WORKSPACE_CONFIG_INVALID"
};

const REMEDIATION: Record<StoreKind, string> = {
  "global-config": "Restore config.yaml from a version-1 backup, or delete it and run: m365-agent init",
  registry:
    "Restore agents.yaml from a version-1 backup, or delete it and re-register agents with: m365-agent agent add",
  approvals:
    "Restore approvals.json from a version-1 backup, or delete it and re-run: m365-agent workspace approve",
  "workspace-config":
    "Restore .m365-agents.json from a version-1 backup, or re-run: m365-agent workspace configure"
};

/**
 * §41.1: every store kind carries an explicit `version`. This inspects `raw.version` BEFORE
 * the store's zod schema is applied and fails closed (throws) on anything but version 1 --
 * missing, older, or newer -- instead of letting zod's own defaults/coercion silently
 * reinterpret a security-relevant field written by a different, incompatible version of
 * AgentPickLink. There is exactly one schema version today, so this is a seam for a future
 * migration (a version-2 branch would go here), not a working migrator yet: today it only
 * ever passes version-1 data through unchanged or throws.
 */
export function migrateStore(kind: StoreKind, raw: unknown): unknown {
  const version =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).version
      : undefined;
  if (version === 1) return raw;
  const described =
    version === undefined ? "has no version field" : `declares version ${JSON.stringify(version)}`;
  throw new DomainError(
    CODE[kind],
    `The ${LABEL[kind]} ${described}. It was written by a different version of AgentPickLink and cannot be safely reinterpreted.`,
    false,
    { remediation: REMEDIATION[kind] }
  );
}

/**
 * Applies one-time v0.1 global defaults migrations before the strict global schema runs. Older
 * configs have no marker. Existing custom download hosts remain untouched, while a legacy visible
 * automation browser (`browser.headless: false`) is moved to the safer hidden default once. Once
 * either marker is written, later explicit edits are user choices and are never silently restored.
 */
export function migrateGlobalConfig(raw: unknown): unknown {
  const value = migrateStore("global-config", raw);
  if (!isRecord(value)) return value;
  if (
    (value.downloadDefaultsVersion !== undefined && value.downloadDefaultsVersion !== 1) ||
    (value.headlessDefaultsVersion !== undefined && value.headlessDefaultsVersion !== 1)
  )
    return value;

  let migrated: Record<string, unknown> = value;
  if (value.downloadDefaultsVersion === undefined) {
    const browser = isRecord(value.browser) ? value.browser : undefined;
    const navigation = isRecord(value.navigation) ? value.navigation : undefined;
    const hosts = navigation?.downloadHosts;
    const hasEmptyHosts =
      navigation === undefined || hosts === undefined || (Array.isArray(hosts) && hosts.length === 0);
    const migratedBrowser = browser ? { ...browser } : undefined;
    const migratedNavigation = navigation ? { ...navigation } : undefined;
    if (hasEmptyHosts) {
      if (migratedNavigation) migratedNavigation.downloadHosts = [...DEFAULT_DOWNLOAD_HOSTS];
      if (migratedBrowser && (browser?.acceptDownloads === undefined || browser.acceptDownloads === false))
        migratedBrowser.acceptDownloads = true;
    }
    migrated = {
      ...migrated,
      downloadDefaultsVersion: 1,
      ...(migratedBrowser ? { browser: migratedBrowser } : {}),
      ...(migratedNavigation ? { navigation: migratedNavigation } : {})
    };
  }
  if (migrated.headlessDefaultsVersion === undefined) {
    const browser = isRecord(migrated.browser) ? migrated.browser : undefined;
    migrated = {
      ...migrated,
      headlessDefaultsVersion: 1,
      ...(browser && browser.headless === false ? { browser: { ...browser, headless: true } } : {})
    };
  }
  return migrated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
