/**
 * Default navigation hosts shared by the config schema's `.default(...)` values (src/config/schema.ts)
 * and anything else that needs the same out-of-the-box Microsoft 365 host list (see
 * docs/ux-redesign.md §2.2 item 1). Kept as a standalone module (no zod import) so it can be
 * imported by both the schema and, later, other composition roots without a cycle.
 */
export const DEFAULT_APP_HOSTS: readonly string[] = ["m365.cloud.microsoft"];

/**
 * Out-of-the-box `navigation.downloadHosts` (see src/domain/host-pattern.ts for the wildcard
 * semantics). SharePoint Online and OneDrive for Business live under `<tenant>.sharepoint.com` and
 * `<tenant>-my.sharepoint.com`, which the wildcard covers for every tenant without anyone typing
 * their tenant name; `onedrive.live.com` is consumer OneDrive (personal Microsoft accounts).
 * Sovereign clouds (`*.sharepoint.cn`, `*.sharepoint.us`, ...) are deliberately left out, matching
 * DEFAULT_APP_HOSTS, which only targets the worldwide cloud. Downloads are enabled by default for
 * these standard hosts. Agents classified as `actions-possible` still need explicit capability permission.
 */
export const DEFAULT_DOWNLOAD_HOSTS: readonly string[] = ["*.sharepoint.com", "onedrive.live.com"];

export const DEFAULT_AUTH_HOSTS: readonly string[] = [
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.live.com",
  "login.windows.net",
  "aadcdn.msftauth.net",
  "aadcdn.msauth.net",
  "autologon.microsoftazuread-sso.com",
  "device.login.microsoftonline.com",
  "msft.sts.microsoft.com"
];
