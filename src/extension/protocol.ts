/**
 * The message contract between the extension host and the `agentpicklink.setup` webview
 * (docs/ux-redesign.md §2.6). Everything the webview sends is untrusted data: the host resolves
 * agent URLs and descriptions from its own candidate list by `key`.
 */
import type { AgentCandidate, SetupStatus } from "../services/setup-service.js";
import type { Incident } from "../observability/incidents.js";
import type { ProgressPhase } from "../domain/progress.js";

export type Locale = "ja" | "en";

/** `"connected"` is the resting state auto-connect (`SetupViewProvider.autoConnect`) and a
 * notification-prompted sign-in leave a previously set-up workspace in: signed in, all available
 * agents loaded with the saved selection retained. Distinct from `"done"` (the view right after a Save)
 * and `"selecting"` (a discovery result waiting to be saved). */
export type PanelPhase =
  | "idle"
  | "checking"
  | "signing-in"
  | "discovering"
  | "selecting"
  | "saving"
  | "done"
  | "connected"
  | "error";

/** `"restarting-broker"` is a host-only, panel-facing phase (P0-3's automatic post-Save broker
 * restart): it never crosses IPC as a `ProgressEvent` and is therefore not part of
 * `domain/progress.ts`'s `ProgressPhase` union, only of what the panel can display. */
export type PanelProgress = {
  phase: ProgressPhase | "restarting-broker";
  message?: string;
  elapsedMs?: number;
  /** Position within a counted pass (discovery's store cards: `current` of `total`), when the
   * broker reported one. */
  current?: number;
  total?: number;
};

/**
 * What the panel's error banner renders. `message`/`remediation` are the original English text the
 * domain layer produced and are shown verbatim (in smaller type) so what the user copies into a
 * report matches what the developer greps for; `summary`/`localizedRemediation` are the localized
 * one-liners shown above them (see `describeErrorCode` in src/extension/localize.ts). Both localized
 * fields are absent for a code the dictionary does not know, in which case the panel falls back to
 * the English text as the headline.
 */
export type PanelError = {
  code: string;
  message: string;
  remediation?: string;
  summary?: string;
  localizedRemediation?: string;
};

export type IntegrationFlags = { codex: boolean; claudeCode: boolean; vscodeMcpJson: boolean };

/** A one-shot, non-error notice the panel shows and then clears on the next state change (see G1's
 * "sign-in cancelled" message). An extensible string union rather than a boolean so a future notice
 * kind does not need a new `PanelState` field. */
export type NoticeKind = "sign-in-cancelled" | "discovery-cancelled" | "saved-needs-sign-in";

/** G5/G6: the live-poll subset of `BrokerHealthSnapshot` (src/extension/broker.ts) the panel
 * renders -- refreshed by every health poll regardless of whether the user has pressed any button,
 * unlike `PanelState.status` (which only updates when an action runs). */
export type LiveBrowserInfo = {
  channel: string;
  headless: boolean;
  viewport?: { width: number; height: number };
  executable?: string;
};
export type DevModeInfo = { insecureLoopback: boolean; devAppUrl: boolean };

export type PanelState = {
  phase: PanelPhase;
  status?: SetupStatus;
  candidates: AgentCandidate[];
  discoverySummary?: { total: number; descriptions: number; partial: boolean };
  selectedKeys: string[];
  progress?: PanelProgress;
  error?: PanelError;
  /** Set alongside `phase` reverting to a non-error phase; see `NoticeKind`. */
  notice?: NoticeKind;
  /** Failure tags: discovery's short problem markers (`no-sidebar`, ...) and per-agent save
   * failures. Shown under "警告 / Warnings". */
  warnings: string[];
  /** Discovery's metadata-only summaries and page descriptions (`sidebar:…`, `store-catalog:…`,
   * `landing:…`, `route:…`; see src/domain/discovery-warnings.ts). Shown under "診断情報 /
   * Diagnostics", never as a warning: a successful run always produces them. */
  diagnostics: string[];
  incidents: Incident[];
  integrations: IntegrationFlags;
  locale: Locale;
  version: string;
  /** G4: hostnames the broker suggested from the last `discover()` that are not already in
   * `status.config.downloadHosts` -- a pre-fill hint only, never saved on its own. */
  suggestedDownloadHosts?: string[];
  /** G5/G6, poller-driven -- see `LiveBrowserInfo`/`DevModeInfo` above. */
  liveBrowser?: LiveBrowserInfo;
  devMode?: DevModeInfo;
};

/** Host -> webview. */
export type HostMessage = { type: "state"; state: PanelState };

/** One agent as edited in the panel; the host resolves `key` against its own candidate list. */
export type PlanAgentInput = {
  key: string;
  displayName?: string;
  usageHint?: string;
  /** The "ファイル生成・アクションあり" toggle. */
  actionsPossible?: boolean;
};

export type SavePlanInput = {
  agents: PlanAgentInput[];
  downloadHosts: string[];
  acceptDownloads: boolean;
  integrations: IntegrationFlags;
};

/** G5: `updateConfig`'s patch, as edited in the panel's "Advanced" section. Every field is
 * optional; an absent one leaves the current configuration untouched. */
export type UpdateConfigPatchInput = {
  headless?: boolean;
  channel?: "msedge" | "chrome" | "chromium";
  attachmentRetentionHours?: number;
  attachmentQuotaBytes?: number;
};

/** Webview -> host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "setup" }
  | { type: "refresh" }
  | { type: "discover" }
  | { type: "signIn" }
  | { type: "signOut" }
  | { type: "cancelSignIn" }
  | { type: "cancelDiscovery" }
  | { type: "save"; plan: SavePlanInput }
  | { type: "unregisterAgent"; key: string }
  | { type: "revokeWorkspace" }
  | { type: "updateConfig"; patch: UpdateConfigPatchInput }
  | { type: "copyDiagnostics" }
  | { type: "openLogs" }
  | { type: "restartBroker" };

const WEBVIEW_MESSAGE_TYPES: ReadonlySet<WebviewMessage["type"]> = new Set([
  "ready",
  "setup",
  "refresh",
  "discover",
  "signIn",
  "signOut",
  "cancelSignIn",
  "cancelDiscovery",
  "save",
  "unregisterAgent",
  "revokeWorkspace",
  "updateConfig",
  "copyDiagnostics",
  "openLogs",
  "restartBroker"
]);

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").slice(0, max);
}

/**
 * Narrows an arbitrary `postMessage` payload to a `WebviewMessage`, dropping anything unknown and
 * bounding every list/string so a misbehaving webview cannot flood the host.
 */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !WEBVIEW_MESSAGE_TYPES.has(type as WebviewMessage["type"]))
    return undefined;
  if (type === "unregisterAgent") {
    const key = (value as { key?: unknown }).key;
    return typeof key === "string" ? { type: "unregisterAgent", key: key.slice(0, 2048) } : undefined;
  }
  if (type === "updateConfig") {
    const patch = (value as { patch?: unknown }).patch;
    if (typeof patch !== "object" || patch === null) return undefined;
    const raw = patch as Record<string, unknown>;
    const result: UpdateConfigPatchInput = {};
    if (typeof raw.headless === "boolean") result.headless = raw.headless;
    if (raw.channel === "msedge" || raw.channel === "chrome" || raw.channel === "chromium")
      result.channel = raw.channel;
    if (typeof raw.attachmentRetentionHours === "number" && Number.isFinite(raw.attachmentRetentionHours))
      result.attachmentRetentionHours = Math.max(1, Math.trunc(raw.attachmentRetentionHours));
    if (typeof raw.attachmentQuotaBytes === "number" && Number.isFinite(raw.attachmentQuotaBytes))
      result.attachmentQuotaBytes = Math.max(0, Math.trunc(raw.attachmentQuotaBytes));
    return { type: "updateConfig", patch: result };
  }
  if (type === "save") {
    const plan = (value as { plan?: unknown }).plan;
    if (typeof plan !== "object" || plan === null) return undefined;
    const raw = plan as {
      agents?: unknown;
      downloadHosts?: unknown;
      acceptDownloads?: unknown;
      integrations?: unknown;
    };
    const agents = Array.isArray(raw.agents)
      ? raw.agents
          .filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as { key?: unknown }).key === "string"
          )
          .slice(0, 200)
          .map((entry) => ({
            key: String(entry.key).slice(0, 2048),
            displayName: typeof entry.displayName === "string" ? entry.displayName.slice(0, 200) : undefined,
            usageHint: typeof entry.usageHint === "string" ? entry.usageHint.slice(0, 2000) : undefined,
            actionsPossible: entry.actionsPossible === true
          }))
      : [];
    const integrations = (raw.integrations ?? {}) as Record<string, unknown>;
    return {
      type: "save",
      plan: {
        agents,
        downloadHosts: asStringArray(raw.downloadHosts, 50).map((host) => host.slice(0, 256)),
        acceptDownloads: raw.acceptDownloads === true,
        integrations: {
          codex: integrations.codex === true,
          claudeCode: integrations.claudeCode === true,
          vscodeMcpJson: integrations.vscodeMcpJson === true
        }
      }
    };
  }
  return { type } as WebviewMessage;
}
