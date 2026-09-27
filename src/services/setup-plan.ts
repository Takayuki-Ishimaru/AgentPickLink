/**
 * Turns the webview's edited selection into the `ApplyPlan` that `SetupService.apply()` consumes.
 * Pure and unit tested (`tests/extension/plan.test.ts`): the panel never gets to name a URL here,
 * it names a `key` that must already exist in the host's candidate list, which is exactly the
 * property that keeps the panel inside the security model (registry + explicit approval).
 * Host-agnostic (no `vscode` import) so the CLI can share it; the VS Code extension re-exports
 * this module from `src/extension/plan.ts`.
 */
import type { AgentCandidate, ApplyPlan } from "./setup-service.js";
import type { SavePlanInput } from "./setup-protocol.js";
import { HostAllowlist, isHostPattern } from "../domain/host-pattern.js";

export type BuiltPlan = {
  plan: ApplyPlan;
  /** Keys the webview asked for that no longer exist in the candidate list. */
  unknownKeys: string[];
  /** APL-REVIEW-04: typed download-host entries that cannot be allowlisted, with the reason. They
   * are left out of `plan.downloadHosts`, so a caller must refuse to save while any remain. */
  invalidDownloadHosts: DownloadHostIssue[];
};

/** Why a typed download-host entry cannot be allowlisted. */
export type DownloadHostProblem = "whitespace" | "not-a-domain" | "invalid-wildcard" | "invalid-host";

export type DownloadHostIssue = { value: string; problem: DownloadHostProblem };

/** The verdict on the whole "download hosts" field: the normalized entries that would be saved and
 * every entry that would not. media/setup.js mirrors this function for live feedback; the host
 * re-runs it on Save and is the authority. Both are held to the same vectors by the tests. */
export type DownloadHostCheck = { hosts: string[]; invalid: DownloadHostIssue[] };

type DownloadHostResult = { host: string } | { problem: DownloadHostProblem } | undefined;

/** `undefined` for a blank entry (an empty slot between commas is not an error). */
function parseDownloadHost(value: string): DownloadHostResult {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/.*$/, "");
  const host = withoutScheme.replace(/:\d+$/, "");
  if (host.includes(".") && isHostPattern(host)) return { host };
  if (/\s/.test(host)) return { problem: "whitespace" };
  if (host.includes("*")) return { problem: "invalid-wildcard" };
  if (!host.includes(".")) return { problem: "not-a-domain" };
  return { problem: "invalid-host" };
}

/** Normalizes a host entry typed into the "download hosts" field: a bare host, a `*.` wildcard
 * (`*.sharepoint.com`, see src/domain/host-pattern.ts), or a URL whose host is wanted. */
export function normalizeDownloadHost(value: string): string | undefined {
  const result = parseDownloadHost(value);
  return result && "host" in result ? result.host : undefined;
}

/** Checks every entry of the field, keeping the typed value of each rejected one for display. */
export function checkDownloadHosts(values: readonly string[]): DownloadHostCheck {
  const hosts = new Set<string>();
  const invalid: DownloadHostIssue[] = [];
  for (const value of values) {
    const result = parseDownloadHost(value);
    if (!result) continue;
    if ("host" in result) hosts.add(result.host);
    else invalid.push({ value: value.trim(), problem: result.problem });
  }
  return { hosts: [...hosts].sort(), invalid };
}

/**
 * The alias the panel shows in the approval dialog before `SetupService.apply()` assigns the real
 * one. Display only -- apply() owns uniqueness (and the `-2` suffix on a clash).
 */
export function previewAlias(displayName: string): string {
  // Kept in step with `slug()` in src/services/setup-service.ts so the dialog shows the alias the
  // user will actually get (apply() may still append `-2` to break a collision).
  const slug = displayName
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "agent";
}

export function buildApplyPlan(input: SavePlanInput, candidates: readonly AgentCandidate[]): BuiltPlan {
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const unknownKeys: string[] = [];
  const seen = new Set<string>();
  const agents: ApplyPlan["agents"] = [];
  for (const entry of input.agents) {
    const candidate = byKey.get(entry.key);
    if (!candidate) {
      unknownKeys.push(entry.key);
      continue;
    }
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const displayName = entry.displayName?.trim() || candidate.displayName.trim() || candidate.url;
    // Descriptions belong to Microsoft 365, never to webview edits or a stale local override.
    const description = candidate.description?.trim() ?? "";
    // APL-REVIEW-03: an absent hint (the CLI never sends one) keeps the registered hint, but any
    // string from the panel is the user's value -- an empty one means "clear it", so it must reach
    // apply() as "" instead of falling back to the registered hint.
    const usageHint =
      entry.usageHint !== undefined ? entry.usageHint.trim() : candidate.registered?.usageHint?.trim();
    agents.push({
      url: candidate.url,
      ...(candidate.registered?.alias ? { alias: candidate.registered.alias } : {}),
      displayName,
      description,
      ...(usageHint !== undefined ? { usageHint } : {}),
      ...(candidate.registered?.kind ? { kind: candidate.registered.kind } : {}),
      capabilityClass: entry.actionsPossible ? "actions-possible" : "knowledge-only"
    });
  }
  const { hosts: downloadHosts, invalid: invalidDownloadHosts } = checkDownloadHosts(input.downloadHosts);
  return {
    plan: { agents, downloadHosts, acceptDownloads: input.acceptDownloads },
    unknownKeys,
    invalidDownloadHosts
  };
}

/**
 * G4: merges the download hosts the broker suggested (from the last `discover()`, see
 * `DiscoveryResult.suggestedDownloadHosts`) into the currently configured list, for pre-filling the
 * panel's download-hosts field. Keeps every configured host, in its existing order; appends any
 * suggested host not already covered by a configured entry -- exactly (case-insensitively) or by a
 * `*.` wildcard such as the default `*.sharepoint.com` -- in the order suggested, de-duplicated
 * against itself. Never reorders or drops a configured host, and never saves anything on its own --
 * the field stays a plain, editable text input and Save applies whatever text is in it.
 */
export function mergeDownloadHostSuggestions(
  configured: readonly string[],
  suggested: readonly string[]
): string[] {
  const covered = new HostAllowlist(configured);
  const seen = new Set<string>();
  const merged = [...configured];
  for (const host of suggested) {
    const normalized = host.toLowerCase();
    if (covered.allows(host) || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(host);
  }
  return merged;
}
