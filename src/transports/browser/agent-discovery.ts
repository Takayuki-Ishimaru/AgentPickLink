import { randomBytes } from "node:crypto";
import type { ProgressSink } from "../../domain/progress.js";
import type { DiscoveredAgent, DiscoveryResult } from "../transport.js";
import { AgentNavigator, signInRequired } from "./agent-navigator.js";
import { BrowserManager } from "./browser-manager.js";
import { neutralLandingUrl } from "./landing.js";
import { NavigationPolicy } from "./navigation-policy.js";
import { COMPOSER_SELECTORS, MAIN_REGION_SELECTOR } from "./selectors/common.js";
import { BrowserTransportError, type LocatorLike, type PageLike, type Surface } from "./types.js";

export interface AgentDiscoveryOptions {
  manager: BrowserManager;
  policy: NavigationPolicy;
  navigator: AgentNavigator;
  appHosts: string[];
  authHosts?: string[];
  /** Overrides the derived `https://<appHosts[0]>/chat` landing target (development/mock app). */
  neutralAppUrl?: string;
  navigationTimeoutMs?: number;
  /** How long discovery keeps judging the landing page until it has rendered as signed in. The
   * application host answers with its shell first; defaults to the navigation timeout. */
  renderTimeoutMs?: number;
  /** How long discovery waits, after the application has rendered, for the first agent-looking
   * row to arrive before reading the rail. */
  rowsSettleMs?: number;
  /** How long strategy C waits for the agent store/list to render after its single click. */
  storeWaitMs?: number;
  /** Strategy D: how long one store card is given to react (navigate, or open its details dialog)
   * after being clicked. */
  storeItemWaitMs?: number;
  /** Agent metadata hydrates separately from the route and store-card navigation. */
  descriptionWaitMs?: number;
  /** Strategy D: at most this many store cards are resolved in one run. */
  storeMaxItems?: number;
}

/** Prefix only: every discovery run uses its own suffixed page key, so two concurrent runs can
 * never share -- or close -- each other's page. */
export const DISCOVERY_PAGE_KEY = "agent-discovery";

/** Accessible names of the one control strategy C is allowed to click. Exact match only. */
export const AGENT_STORE_CONTROL_NAMES = [
  "すべてのエージェント",
  "All agents",
  "エージェントを表示",
  "See all agents",
  "Get agents",
  "エージェントを取得"
] as const;

/**
 * Same-origin routes Microsoft 365 links to from the landing page for the full agent list ("all
 * agents") and the agent store, in the order strategy C tries them when no exactly named control
 * exists. Only a link the landing page itself offers is followed, by plain navigation.
 */
export const AGENT_LIST_ROUTES = ["/chat/all", "/chat/agentstore"] as const;

/**
 * Accessible names of the collapsed agent section's own "show all" control, matched exactly and
 * only when the control sits in the same section as the `[data-agent-id]` rows (a "show all"
 * elsewhere on the page -- the chat history, say -- is never the one). Microsoft 365 renders the
 * rail's agent list collapsed behind such a control.
 */
export const SECTION_DISCLOSURE_NAMES = [
  "すべて表示",
  "すべてを表示",
  "さらに表示",
  "もっと見る",
  "Show all",
  "See all",
  "View all",
  "Show more"
] as const;
/** Temporary marker discovery puts on the one section control it is about to click, so the click
 * goes through the same locator path as every other guarded click. Removed afterwards. */
const DISCLOSURE_MARKER = "data-agentpicklink-disclosure";

/** The agent store route (strategy D). Only reached through a link the landing page offers. */
export const AGENT_STORE_ROUTE = "/chat/agentstore";
/** Exact accessible names of the store's own "load more" control, clicked (bounded) before the
 * cards are read so a paged catalogue is complete. */
export const STORE_MORE_NAMES = [
  "表示を増やす",
  "さらに表示",
  "もっと見る",
  "Show more",
  "Load more",
  "See more"
] as const;
/** Exact accessible names (case-insensitive) of a details-dialog control that merely opens the
 * agent's chat. Nothing else inside a dialog is ever clicked. */
export const STORE_OPEN_NAMES = [
  "開く",
  "チャットを開始",
  "会話を開始",
  "チャットで開く",
  "チャット",
  "open",
  "open in chat",
  "start chat",
  "chat"
] as const;
/**
 * What a store card's own accessible description says when clicking the card opens the agent's
 * chat. Microsoft 365 puts such a hint ("…開く", "…open…") on the cards of agents the account has
 * added or created -- exactly the cards whose click leads to `/chat/agent/<id>` -- and none on the
 * catalogue's cards, whose click opens a details dialog offering nothing but "追加". Strategy D
 * therefore clicks only the hinted cards once a store shows at least one (`StoreClickMode`).
 */
export const STORE_OPENS_HINT_PATTERN = /開く|開きます|\bopens?\b/i;
/** Exact accessible names of a dialog's dismiss control, the fallback when Escape does not close it. */
export const STORE_CLOSE_NAMES = ["閉じる", "キャンセル", "close", "cancel", "dismiss"] as const;
/**
 * Anything that adds, installs, buys, consents to, approves, or enables something. A control whose
 * accessible name matches is never clicked by strategy D, whatever else it looks like -- a store
 * card can be opened, an agent is never added to the account on the user's behalf.
 */
export const STORE_FORBIDDEN_NAME_PATTERN =
  /追加|インストール|購入|同意|許可|承認|有効|続行|取得|サインイン|ライセンス|支払|add|install|buy|purchase|consent|accept|allow|approve|enable|continue|\bget\b|sign in|subscribe|upgrade|license|pay/i;
/** Names of per-card overflow menus and the like: never a card, never clicked. */
const STORE_SKIP_NAME_PATTERN = /その他のオプション|オプション|more options|options|menu|メニュー/i;
/** Microsoft 365's stable agent id, as it appears in `/chat/agent/<id>` and `data-agent-id`. */
const AGENT_ID_PATTERN = /T_[0-9a-f-]{36}\.[0-9a-f-]{36}\.[a-z]+\.[0-9a-f-]{36}/i;
const MAX_STORE_MORE_CLICKS = 10;
const CARD_MARKER = "data-agentpicklink-card";
const OPEN_MARKER = "data-agentpicklink-open";

/** Roles the one "all agents" disclosure control may carry. Microsoft 365 has shipped it as a
 * button, as a link, and as a menu item; the accessible name still has to match exactly, and
 * exactly one control may match across all three roles. */
export const AGENT_STORE_CONTROL_ROLES = ["button", "link", "menuitem"] as const;

/** Hostnames that look like the tenant's own file storage. Matched against the *hostname* of links
 * seen on the landing page and offered as `navigation.downloadHosts` candidates -- never
 * allowlisted automatically, and never carrying a path or a query. */
const FILE_HOST_PATTERN =
  /\.sharepoint\.com$|\.sharepoint\.cn$|\.sharepoint-df\.com$|(^|\.)onedrive\.live\.com$|-my\.sharepoint\.com$/i;
const MAX_SUGGESTED_DOWNLOAD_HOSTS = 10;
/** Sidebar rails are frequently virtualized: rows below the fold exist only once the rail has been
 * scrolled. Discovery nudges it to the bottom in bounded steps and then puts it back. */
const MAX_SIDEBAR_SCROLL_STEPS = 10;
const SIDEBAR_SCROLL_STEP_MS = 150;
/** Poll interval while waiting for the shell to render and for the rail's rows to arrive. */
const SETTLE_POLL_MS = 250;
/** How many consecutive polls a revealed page's raw row/link count has to hold steady, once it is
 * positive, before that page counts as rendered with nothing new (see `revealedAgents`). */
const REVEAL_STABLE_POLLS = 3;
/** Poll interval while a clicked store card is given time to react (navigate, or open its details
 * dialog), while a dismissed dialog is given time to go away, and while a return to the store is
 * awaited. Short on purpose: on a catalogue of hundreds of cards every poll is on the critical path. */
const STORE_REACT_POLL_MS = 50;
/** How long a dismissed details dialog is given to disappear before its exactly named close
 * control is tried instead. */
const DIALOG_CLOSE_WAIT_MS = 500;
/** Poll interval while the store renders (or re-renders) its cards. */
const STORE_CARDS_POLL_MS = 100;
/** Direct agent route, as strategy B recognizes it; used only to notice that rows have arrived. */
const AGENT_LINK_PATTERN = "/chat/agent/[^/?#]+";
/** Bounds of the metadata-only landing summary reported when discovery found nothing. */
const MAX_SUMMARY_LANDMARKS = 12;
const MAX_SUMMARY_LINK_SHAPES = 15;
const MAX_SUMMARY_NAMES = 20;
const MAX_SUMMARY_LENGTH = 2_600;
/** Attributes whose value *shapes* the page description reports (never the values). */
const ID_ATTRIBUTES = [
  "data-agent-id",
  "data-tid",
  "data-app-id",
  "data-title-id",
  "data-item-id",
  "data-id"
] as const;
const SIDEBAR_RAIL_SELECTORS = ["nav[aria-label]", '[role="navigation"]'];
const AGENT_ROW_SELECTOR = "[data-agent-id]";
/** Decoration whose text a sighted user never reads as part of a name: avatars (Fluent renders
 * initials inside a `role="img"` span), icons, and images. Matched inside rows and links. */
const DECORATION_SELECTOR =
  'img, svg, [role="img"], [class*="avatar" i], [data-testid*="avatar" i], [data-testid*="icon" i]';
const FILE_LINK_SELECTOR = "a[href], [data-url], [data-href]";
const FILE_LINK_ATTRIBUTES = ["href", "data-url", "data-href"];
const MAX_SCANNED_LINKS = 500;

const MAX_NAME_LENGTH = 160;
const GENERIC_NAMES = new Set([
  "copilot",
  "microsoft copilot",
  "microsoft 365 copilot",
  "m365 copilot",
  "chat",
  "チャット"
]);

type RawSidebarCandidate = { id?: string; name?: string; description?: string };
/** One store card as `storeCards` reads it (see there). `opens`: the card's own accessible
 * description says that clicking it opens the agent (`STORE_OPENS_HINT_PATTERN`). */
type StoreCard = { key: string; name: string; description?: string; list: string; opens: boolean };
/**
 * Which cards strategy D clicks. `opens`: only the cards whose accessible description says the
 * click opens the agent -- the store marks the account's added/created agents that way, and the
 * catalogue's cards (a details dialog with nothing but add-like controls) can never yield an
 * agent, so clicking them is pure cost. `all`: this store marks no card at all (another locale,
 * an older layout), so every card is clicked, as before, rather than risk missing an agent.
 */
type StoreClickMode = "opens" | "all";
/** How one store card resolved (see `resolveStoreCard`). */
type StoreOutcome = "attribute" | "navigation" | "dialog" | "open" | "forbiddenOnly" | "unresolved";
/** The `store-catalog:` / `store-shapes:` field names of each outcome. */
const STORE_OUTCOME_LABELS: Record<StoreOutcome, string> = {
  attribute: "attr",
  navigation: "nav",
  dialog: "dialog",
  open: "open",
  forbiddenOnly: "forbidden",
  unresolved: "none"
};
type RawLinkCandidate = { href?: string; name?: string };
/** What strategies A and B read from the page in one browser-context pass (`readRail`). */
type RawRail = { rows?: unknown; links?: unknown };
/** One `readRail` pass, shared by strategies A and B so a page is read once, not twice: the raw
 * rail (absent when the page cannot evaluate), or the fact that reading it failed. */
type RailScan = { rail?: RawRail; failed?: true };
/** Selector arguments of `readRail`, passed in because a serialized body cannot see module scope. */
export type RailArgs = { rows: string; main: string; composer: string; decor: string; maxName: number };
/** What discovery passes to `readRail`. Exported, with the body, for the real-browser tests. */
export const RAIL_ARGS: RailArgs = {
  rows: AGENT_ROW_SELECTOR,
  main: MAIN_REGION_SELECTOR,
  composer: COMPOSER_SELECTORS.join(", "),
  decor: DECORATION_SELECTOR,
  maxName: MAX_NAME_LENGTH
};
type LandingStructure = {
  landmarks?: unknown;
  shapes?: unknown;
  dataAttrs?: unknown;
  testIds?: unknown;
  controls?: unknown;
  ids?: unknown;
  disclosures?: unknown;
  main?: unknown;
};

/**
 * Enumerates the agents the signed-in account can reach, in the hidden automation context.
 *
 * Everything here is a *candidate list only*: registration still verifies each URL through
 * `inspectAgentUrl` (identity + composer) before it can be approved. Discovery therefore never
 * clicks anything except, at most once, one exactly named "all agents" disclosure control.
 */
const discoverySignals = new WeakMap<PageLike, AbortSignal>();
const partialDiscoveries = new WeakMap<PageLike, DiscoveredAgent[]>();
const DESCRIPTION_CACHE_MS = 30 * 60_000;

export class AgentDiscovery {
  private readonly manager: BrowserManager;
  private readonly policy: NavigationPolicy;
  private readonly navigator: AgentNavigator;
  private readonly appHosts: string[];
  private readonly neutralAppUrl?: string;
  private readonly navigationTimeoutMs: number;
  private readonly renderTimeoutMs: number;
  private readonly rowsSettleMs: number;
  private readonly storeWaitMs: number;
  private readonly storeItemWaitMs: number;
  private readonly descriptionWaitMs: number;
  private readonly storeMaxItems: number;

  constructor(options: AgentDiscoveryOptions) {
    this.manager = options.manager;
    this.policy = options.policy;
    this.navigator = options.navigator;
    this.appHosts = options.appHosts;
    this.neutralAppUrl = options.neutralAppUrl;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 45_000;
    this.renderTimeoutMs = options.renderTimeoutMs ?? this.navigationTimeoutMs;
    this.rowsSettleMs = options.rowsSettleMs ?? 8_000;
    this.storeWaitMs = options.storeWaitMs ?? 5_000;
    this.storeItemWaitMs = options.storeItemWaitMs ?? 3_000;
    this.descriptionWaitMs = options.descriptionWaitMs ?? this.navigationTimeoutMs;
    this.storeMaxItems = options.storeMaxItems ?? 500;
  }

  /** The same neutral landing target the session probes open (see `neutralLandingUrl`). */
  landingUrl(): string {
    return neutralLandingUrl(this.appHosts, this.neutralAppUrl);
  }

  private readonly descriptionCache = new Map<string, { text: string; at: number }>();

  clearDescriptionCache(): void {
    this.descriptionCache.clear();
  }

  private descriptionKey(url: string, name: string): string {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}\0${name}`;
  }

  private cachedDescription(url: string, name: string): string | undefined {
    const key = this.descriptionKey(url, name);
    const entry = this.descriptionCache.get(key);
    if (entry && Date.now() >= entry.at && Date.now() - entry.at < DESCRIPTION_CACHE_MS) return entry.text;
    this.descriptionCache.delete(key);
    return undefined;
  }

  private rememberDescription(url: string, name: string, text: string): string {
    const key = this.descriptionKey(url, name);
    this.descriptionCache.delete(key);
    this.descriptionCache.set(key, { text, at: Date.now() });
    if (this.descriptionCache.size > 500)
      this.descriptionCache.delete(this.descriptionCache.keys().next().value!);
    return text;
  }

  async discover(
    timeoutMs = 60_000,
    onProgress?: ProgressSink,
    signal?: AbortSignal
  ): Promise<DiscoveryResult> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    const landingUrl = this.landingUrl();
    this.policy.validate(landingUrl, "app");
    const warnings: string[] = [];
    const progress = (message: string, extra: { current?: number; total?: number } = {}) => {
      signal?.throwIfAborted();
      onProgress?.({ phase: "discovering", message, elapsedMs: Date.now() - started, ...extra });
    };

    progress("Opening the Microsoft 365 landing page");
    const pageKey = `${DISCOVERY_PAGE_KEY}-${randomBytes(6).toString("hex")}`;
    const handle = await this.manager.createConversationPage(pageKey);
    const page = handle.page;
    const partial: DiscoveredAgent[] = [];
    partialDiscoveries.set(page, partial);
    if (signal) discoverySignals.set(page, signal);
    const onAbort = () => {
      void this.manager.closePage(pageKey).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const stopWatching = this.navigator.watch(page, "app-or-auth");
    try {
      signal?.throwIfAborted();
      await page.goto?.(landingUrl, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
      this.navigator.assertNavigationSafe(page, "app-or-auth");
      // The application host answers with its shell first and renders the chat (and, later still,
      // the agent rail) client-side. Reading on arrival reads an empty shell, so keep judging until
      // the page is signed in, bounded by the render budget, and then wait for the rail's rows.
      progress("Waiting for the Microsoft 365 landing page to render");
      const renderDeadline = Math.min(deadline, Date.now() + this.renderTimeoutMs);
      const state = await this.navigator.settleAuthState(page, renderDeadline, { pollMs: SETTLE_POLL_MS });
      if (state === "sign-in-required" || state === "interactive-auth") throw signInRequired();
      if (state === "access-denied")
        throw new BrowserTransportError("AUTH_FAILED", "Microsoft 365 access was denied.");
      if (state !== "authenticated") warnings.push(`landing-not-rendered:${state}`);

      const origin = new URL(page.url()).origin;
      const surface = surfaceForHost(new URL(page.url()).hostname);
      if (surface === "teams-web")
        return { agents: [], warnings: ["teams-discovery-unsupported"], landingUrl };

      const suggestedDownloadHosts = await this.suggestedDownloadHosts(page, warnings);

      progress("Reading the agent sidebar");
      const rowsWait = await this.awaitAgentRows(page, Math.min(deadline, Date.now() + this.rowsSettleMs));
      // Virtualized rails only render what has been scrolled into view, so hydrate before reading.
      const scrollSteps = await this.hydrateSidebarRail(page, warnings);
      // One browser-context pass serves both strategies (see `readRail`).
      const rail = await this.scanRail(page);
      const sidebarRaw = { count: 0 };
      const sidebar = await this.sidebarAgents(page, origin, surface, warnings, sidebarRaw, rail);
      if (!sidebar.length) warnings.push("no-sidebar");
      progress("Reading direct agent links");
      const linkRaw = { count: 0 };
      const links = await this.linkAgents(page, surface, warnings, linkRaw, rail);
      const found = merge([...sidebar, ...links]);
      partial.push(...found);

      progress("Looking for the full agent list", { total: found.length });
      const known = new Set(found.map((agent) => agent.stableAgentId ?? agent.url));
      const storeRole: { value: string; section?: string } = { value: "unavailable" };
      const stored = await this.storeAgents(page, origin, surface, landingUrl, known, warnings, storeRole, {
        deadlineMs: deadline,
        progress,
        baselineRaw: sidebarRaw.count + linkRaw.count
      });
      signal?.throwIfAborted();
      const agents = merge([...found, ...stored]).map((agent) => ({
        ...agent,
        description: agent.description ?? this.cachedDescription(agent.url, agent.displayName)
      }));
      // Rail links and cards with an explicit id have not necessarily had their details read.
      // Inspect every missing description once, within the original discovery budget. An
      // unrelated successful card must not determine whether the other agents can be inspected.
      {
        let attempted = 0;
        let recovered = 0;
        const details = new Map<string, number>();
        for (const agent of agents.filter((candidate) => !candidate.description)) {
          signal?.throwIfAborted();
          if (Date.now() >= deadline) break;
          attempted++;
          progress("Retrying an agent description after the page has loaded");
          try {
            this.policy.validate(agent.url, "app");
            await page.goto?.(agent.url, {
              waitUntil: "domcontentloaded",
              timeout: Math.max(1, Math.min(this.navigationTimeoutMs, deadline - Date.now()))
            });
            this.navigator.assertNavigationSafe(page, "app");
            const description = await this.agentPageDescription(
              page,
              agent.displayName,
              deadline,
              (shape) => {
                if (details.has(shape) || details.size < 10)
                  details.set(shape, (details.get(shape) ?? 0) + 1);
              }
            );
            if (description) {
              agent.description = description;
              partial.push(agent);
              recovered++;
            }
          } catch {
            // The original discovery result remains usable when the optional retry fails.
          }
        }
        if (attempted) warnings.push(`description-retry:attempted=${attempted} recovered=${recovered}`);
        if (details.size)
          warnings.push(
            `description-details:retry ${[...details].map(([shape, count]) => `${shape} count=${count}`).join(" | ")}`
          );
      }
      // Metadata-only per-strategy counts (raw candidates seen / usable ones kept), how far the
      // rail was hydrated, and which role the store control carried -- so a tenant whose sidebar
      // renders 40 rows and yields nothing is distinguishable from an empty one.
      warnings.push(
        `sidebar:${sidebarRaw.count}/${sidebar.length} link:${linkRaw.count}/${links.length}` +
          ` scroll:${scrollSteps} store:${storeRole.value}`
      );
      // Nothing at all, or a rail without a recognizable all-agents control: describe the page's
      // structure (metadata only) so a tenant whose rail or disclosure control is shaped
      // differently from the fixtures can be diagnosed from the panel's warning list.
      if (!agents.length || storeRole.value === "unavailable" || /(^|>)route-empty:/.test(storeRole.value)) {
        const summary = await this.describePage(page, "landing", {
          before: `rendered=${state === "authenticated" ? "yes" : state}`,
          after: `rows-wait=${rowsWait.waitedMs}ms rows=${rowsWait.rows} section=${storeRole.section ?? "-"}`
        });
        if (summary) warnings.push(summary);
      }

      signal?.throwIfAborted();
      onProgress?.({
        phase: "done",
        elapsedMs: Date.now() - started,
        total: agents.length,
        message: `Found ${agents.length} agent candidate(s)`
      });
      return {
        agents,
        warnings,
        landingUrl,
        ...(suggestedDownloadHosts.length ? { suggestedDownloadHosts } : {})
      };
    } catch (error) {
      if (!signal?.aborted) throw error;
      return { agents: merge(partial), warnings: ["discovery-cancelled"], landingUrl };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      discoverySignals.delete(page);
      partialDiscoveries.delete(page);
      stopWatching();
      await this.manager.closePage(pageKey).catch(() => undefined);
    }
  }

  /**
   * Hostnames of SharePoint/OneDrive-looking links on the landing page, offered to the user as
   * `navigation.downloadHosts` candidates. Hostnames only: a path or a query would carry tenant
   * content, and nothing here allowlists anything -- the user still confirms each host.
   */
  private async suggestedDownloadHosts(page: PageLike, warnings: string[]): Promise<string[]> {
    if (!page.evaluate) return [];
    let raw: unknown;
    try {
      raw = await page.evaluate(
        (args: { selector: string; attributes: string[]; max: number }) => {
          const values: string[] = [];
          for (const element of [...document.querySelectorAll(args.selector)]) {
            for (const attribute of args.attributes) {
              const value = element.getAttribute(attribute);
              if (value) values.push(value);
            }
            if (values.length >= args.max) break;
          }
          return values.slice(0, args.max);
        },
        { selector: FILE_LINK_SELECTOR, attributes: FILE_LINK_ATTRIBUTES, max: MAX_SCANNED_LINKS }
      );
    } catch {
      warnings.push("download-host-scan-failed");
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const base = page.url();
    const hosts = new Set<string>();
    for (const value of raw) {
      if (typeof value !== "string") continue;
      let url: URL;
      try {
        url = new URL(value, base);
      } catch {
        continue;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const hostname = url.hostname.toLocaleLowerCase().replace(/\.$/, "");
      if (FILE_HOST_PATTERN.test(hostname)) hosts.add(hostname);
    }
    return [...hosts].sort().slice(0, MAX_SUGGESTED_DOWNLOAD_HOSTS);
  }

  /**
   * The rail's rows arrive from the network after the shell has rendered. Polls until at least one
   * agent-looking row (a `[data-agent-id]` element or a direct agent link) is present and the count
   * has held steady across two polls, or the deadline passes. Read-only. Returns what the landing
   * summary reports: how long it waited and what it last counted.
   */
  private async awaitAgentRows(
    page: PageLike,
    deadlineMs: number
  ): Promise<{ waitedMs: number; rows: number }> {
    const started = Date.now();
    let previous = -1;
    for (;;) {
      const rows = await this.countAgentRows(page);
      if ((rows > 0 && rows === previous) || Date.now() >= deadlineMs)
        return { waitedMs: Date.now() - started, rows };
      previous = rows;
      await wait(SETTLE_POLL_MS, page);
    }
  }

  private async countAgentRows(page: PageLike): Promise<number> {
    if (!page.evaluate) return 0;
    try {
      const raw = await page.evaluate<unknown>(
        (args: { rowSelector: string; linkPattern: string }) => {
          const pattern = new RegExp(args.linkPattern, "i");
          let links = 0;
          for (const anchor of Array.from(document.getElementsByTagName("a"))) {
            const href = anchor.getAttribute("href");
            if (href && pattern.test(href)) links++;
          }
          return document.querySelectorAll(args.rowSelector).length + links;
        },
        { rowSelector: AGENT_ROW_SELECTOR, linkPattern: AGENT_LINK_PATTERN }
      );
      if (typeof raw === "number") return raw;
      // A fixture may answer the row query with the rows themselves.
      return Array.isArray(raw) ? raw.length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Metadata-only description of a page's structure (the landing page when discovery found nothing
   * or no all-agents control; an agent-list route that showed nothing recognizable), reported as a
   * warning: the caller's fields (rendered / rows wait), landmark tags / roles / labels with item counts, same-origin link pathname shapes
   * (id-looking segments masked, query *keys* only), data-* attribute names, data-testid values
   * that look like agent or navigation chrome, and the role and accessible name of controls whose
   * name looks like an agent-list disclosure ("all agents", "show more", "get agents", ...) -- the
   * exact names strategy C would need. Never a URL, a query value, a heading, or message text.
   */
  private async describePage(
    page: PageLike,
    label: string,
    fields: { before?: string; after?: string } = {}
  ): Promise<string | undefined> {
    if (!page.evaluate) return undefined;
    let raw: unknown;
    try {
      raw = await page.evaluate<unknown>(
        (args: {
          maxLandmarks: number;
          maxShapes: number;
          maxNames: number;
          idAttributes: string[];
          rowSelector: string;
          disclosureNames: string[];
        }) => {
          const shorten = (value: string | null, max: number) =>
            (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
          const landmarkSelector =
            'nav, aside, [role="navigation"], [role="complementary"], [role="tree"], [role="tablist"], [role="menu"], [role="list"]';
          const itemSelector =
            'a, button, [role="link"], [role="button"], [role="treeitem"], [role="menuitem"], [role="tab"], [role="listitem"], li';
          const landmarks: string[] = [];
          for (const element of Array.from(document.querySelectorAll(landmarkSelector)).slice(
            0,
            args.maxLandmarks
          )) {
            const role = element.getAttribute("role");
            const label = shorten(element.getAttribute("aria-label"), 24);
            landmarks.push(
              `${element.tagName.toLowerCase()}${role ? `[${role}]` : ""}${label ? `(${label})` : ""}:${element.querySelectorAll(itemSelector).length}`
            );
          }
          // Guids, numeric ids, and long dotted/underscored identifiers (Microsoft 365 agent ids look
          // like "T_<guid>.<guid>.gpt.<guid>") are masked; short route words are kept.
          const idLike = /^\d+$|^(?=.*\d)[A-Za-z0-9_.-]{16,}$/;
          const shapes = new Map<string, number>();
          for (const anchor of Array.from(document.getElementsByTagName("a")).slice(0, 500)) {
            const href = anchor.getAttribute("href");
            if (!href) continue;
            let url: URL;
            try {
              url = new URL(href, location.href);
            } catch {
              continue;
            }
            if (url.origin !== location.origin) continue;
            const path = url.pathname
              .split("/")
              .map((segment) => (idLike.test(segment) ? "{id}" : segment))
              .join("/");
            const keys = Array.from(url.searchParams.keys()).sort().join(",");
            const shape = `${path}${keys ? `?${keys}` : ""}`;
            shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
          }
          const dataAttrs = new Set<string>();
          for (const element of Array.from(document.querySelectorAll("*")).slice(0, 5000)) {
            for (const attribute of Array.from(element.attributes)) {
              if (
                attribute.name.startsWith("data-") &&
                /agent|app|copilot|nav|side|rail|list|item|title|id/i.test(attribute.name)
              )
                dataAttrs.add(attribute.name);
            }
          }
          const testIds = new Set<string>();
          for (const element of Array.from(document.querySelectorAll("[data-testid]")).slice(0, 2000)) {
            const value = element.getAttribute("data-testid") ?? "";
            if (/agent|copilot|app|nav|side|rail|list/i.test(value)) testIds.add(shorten(value, 40));
          }
          const controlSelector =
            'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="treeitem"]';
          const disclosureLike =
            /agent|エージェント|すべて|\ball\b|more|さらに|表示|取得|\bget\b|store|ストア/i;
          const controls = new Set<string>();
          for (const element of Array.from(document.querySelectorAll(controlSelector)).slice(0, 2000)) {
            const name = shorten(
              element.getAttribute("aria-label") || element.textContent || element.getAttribute("title"),
              30
            );
            if (!name || !disclosureLike.test(name)) continue;
            controls.add(`${element.getAttribute("role") || element.tagName.toLowerCase()}:${name}`);
          }
          // Value *shapes* of id-carrying attributes (guids, hex runs, digit runs and long tokens
          // masked), so a store item's id attribute can be recognized without recording any id.
          const maskValue = (value: string) =>
            value
              .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{guid}")
              .replace(/[0-9a-f]{16,}/gi, "{hex}")
              .replace(/\d{4,}/g, "{n}")
              .replace(/[A-Za-z0-9_-]{24,}/g, "{id}")
              .slice(0, 40);
          const ids: string[] = [];
          for (const idAttribute of args.idAttributes) {
            const shapes = new Map<string, number>();
            for (const element of Array.from(document.querySelectorAll(`[${idAttribute}]`)).slice(0, 500)) {
              const shape = maskValue(element.getAttribute(idAttribute) ?? "");
              shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
            }
            for (const [shape, count] of Array.from(shapes.entries())
              .sort((left, right) => right[1] - left[1])
              .slice(0, 3))
              ids.push(`${idAttribute}:${shape}\u00d7${count}`);
          }
          // Where each "show all"-named control sits relative to the agent rows: its depth, the
          // depth of its deepest common ancestor with a row, and whether it follows the last row.
          const rows = Array.from(document.querySelectorAll(args.rowSelector)).slice(0, 200);
          const depthOf = (element: Element) => {
            let depth = 0;
            for (let node: Element | null = element; node; node = node.parentElement) depth++;
            return depth;
          };
          const commonDepth = (left: Element, right: Element) => {
            const ancestors = new Set<Element>();
            for (let node: Element | null = left; node; node = node.parentElement) ancestors.add(node);
            for (let node: Element | null = right; node; node = node.parentElement)
              if (ancestors.has(node)) return depthOf(node);
            return 0;
          };
          const disclosures: string[] = [];
          for (const element of Array.from(
            document.querySelectorAll('button, a, [role="button"], [role="link"]')
          )) {
            const name = (element.getAttribute("aria-label") || element.textContent || "")
              .replace(/\s+/g, " ")
              .trim();
            if (!args.disclosureNames.includes(name)) continue;
            const lastRow = rows[rows.length - 1];
            const follows = lastRow
              ? !!(lastRow.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
              : false;
            const inRow = !!element.closest(args.rowSelector);
            const common = rows.length ? Math.max(...rows.map((row) => commonDepth(element, row))) : 0;
            disclosures.push(
              `${name}@depth=${depthOf(element)},common=${common},after-rows=${follows ? "y" : "n"},in-row=${inRow ? "y" : "n"}`
            );
            if (disclosures.length >= 6) break;
          }
          return {
            landmarks,
            shapes: Array.from(shapes.entries())
              .sort((left, right) => right[1] - left[1])
              .slice(0, args.maxShapes)
              .map(([shape, count]) => `${shape}\u00d7${count}`),
            dataAttrs: Array.from(dataAttrs).slice(0, args.maxNames),
            testIds: Array.from(testIds).slice(0, args.maxNames),
            controls: Array.from(controls).slice(0, args.maxNames),
            ids,
            disclosures,
            main: !!document.querySelector('main, [role="main"]')
          };
        },
        {
          maxLandmarks: MAX_SUMMARY_LANDMARKS,
          maxShapes: MAX_SUMMARY_LINK_SHAPES,
          maxNames: MAX_SUMMARY_NAMES,
          idAttributes: [...ID_ATTRIBUTES],
          rowSelector: AGENT_ROW_SELECTOR,
          disclosureNames: [...SECTION_DISCLOSURE_NAMES]
        }
      );
    } catch {
      return undefined;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const structure = raw as LandingStructure;
    const list = (value: unknown) =>
      Array.isArray(value)
        ? value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .join("|") || "-"
        : "-";
    const summary =
      `${label}:${fields.before ? ` ${fields.before}` : ""} main=${structure.main === true ? "yes" : "no"}` +
      `${fields.after ? ` ${fields.after}` : ""}` +
      ` landmarks=${list(structure.landmarks)} controls=${list(structure.controls)} disclosures=${list(structure.disclosures)} ids=${list(structure.ids)}` +
      ` data=${list(structure.dataAttrs)} testid=${list(structure.testIds)}` +
      ` links=${list(structure.shapes)}`;
    return summary.length > MAX_SUMMARY_LENGTH
      ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}\u2026`
      : summary;
  }

  /**
   * Scrolls the sidebar rail to the bottom in bounded steps and puts it back, so a virtualized or
   * lazily hydrated agent list has rendered its rows before strategies A and B read the DOM. Read
   * -only: scrolling a rail is not a UI action on the agent's behalf, and nothing is clicked.
   * Returns how many steps actually moved the rail (0 when there is nothing scrollable).
   */
  private async hydrateSidebarRail(page: PageLike, warnings: string[]): Promise<number> {
    if (!page.evaluate) return 0;
    const scroll = (restore: boolean) =>
      page.evaluate!<unknown>(
        (args: { selectors: string[]; rowSelector: string; restore: boolean }) => {
          let rail: HTMLElement | null = null;
          for (const selector of args.selectors) {
            rail = document.querySelector(selector);
            if (rail) break;
          }
          if (!rail) rail = document.querySelector(args.rowSelector)?.parentElement ?? null;
          if (!rail) return { moved: false, atEnd: true };
          if (args.restore) {
            rail.scrollTop = 0;
            return { moved: false, atEnd: true };
          }
          const before = rail.scrollTop;
          rail.scrollTop = Math.min(rail.scrollHeight, before + Math.max(rail.clientHeight, 200));
          return {
            moved: rail.scrollTop !== before,
            atEnd: rail.scrollTop + rail.clientHeight >= rail.scrollHeight - 1
          };
        },
        { selectors: SIDEBAR_RAIL_SELECTORS, rowSelector: AGENT_ROW_SELECTOR, restore }
      );
    let steps = 0;
    try {
      for (let index = 0; index < MAX_SIDEBAR_SCROLL_STEPS; index++) {
        const result = scrollOutcome(await scroll(false));
        if (!result.moved) break;
        steps++;
        // Always pause after a step that moved: a scroll event is delivered asynchronously, and
        // the rows it hydrates render after it.
        await wait(SIDEBAR_SCROLL_STEP_MS, page);
        if (result.atEnd) break;
      }
      if (steps) await scroll(true);
    } catch {
      warnings.push("sidebar-scroll-failed");
    }
    return steps;
  }

  /** One `readRail` pass over the page, handed to strategies A and B together: reading the rail
   * once per poll instead of once per strategy halves the browser round trips of every rail read
   * (the landing page, and each poll on a revealed list). */
  private async scanRail(page: PageLike): Promise<RailScan> {
    if (!page.evaluate) return {};
    try {
      return { rail: await page.evaluate<RawRail>(readRail, RAIL_ARGS) };
    } catch {
      return { failed: true };
    }
  }

  /** Strategy A: sidebar rows carrying a stable `[data-agent-id]`, named from `data-agent-name`,
   * else the row's first readable text block, else its `aria-label` (see `readRail`). */
  private async sidebarAgents(
    page: PageLike,
    origin: string,
    surface: Surface,
    warnings: string[],
    seen: { count: number } = { count: 0 },
    scanned?: RailScan
  ): Promise<DiscoveredAgent[]> {
    const scan = scanned ?? (await this.scanRail(page));
    if (scan.failed) {
      warnings.push("sidebar-scan-failed");
      return [];
    }
    const rows = scan.rail?.rows;
    const raw = Array.isArray(rows) ? (rows as RawSidebarCandidate[]) : [];
    seen.count = raw.length;
    const agents: DiscoveredAgent[] = [];
    for (const candidate of raw) {
      const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
      const displayName = usableName(candidate.name);
      if (!id || !displayName) continue;
      const url = this.safeAgentUrl(origin, id);
      if (!url) continue;
      agents.push({
        url,
        surface,
        displayName,
        stableAgentId: id,
        description: usableDescription(candidate.description),
        source: "sidebar"
      });
    }
    return agents;
  }

  /** Strategy B: anchors pointing at a direct `/chat/agent/<id>` route on an application host,
   * named from the anchor's first readable text block, else its `aria-label`, else its `title`. */
  private async linkAgents(
    page: PageLike,
    surface: Surface,
    warnings: string[],
    seen: { count: number } = { count: 0 },
    scanned?: RailScan
  ): Promise<DiscoveredAgent[]> {
    const scan = scanned ?? (await this.scanRail(page));
    if (scan.failed) {
      warnings.push("link-scan-failed");
      return [];
    }
    const links = scan.rail?.links;
    const raw = Array.isArray(links) ? (links as RawLinkCandidate[]) : [];
    seen.count = raw.length;
    const agents: DiscoveredAgent[] = [];
    for (const candidate of raw) {
      const displayName = usableName(candidate.name);
      if (!candidate.href || !displayName) continue;
      let url: URL;
      try {
        url = new URL(candidate.href);
      } catch {
        continue;
      }
      const id = directAgentId(url);
      if (!id) continue;
      try {
        this.policy.validate(url.toString(), "app");
      } catch {
        continue;
      }
      agents.push({
        url: url.toString(),
        surface,
        displayName,
        stableAgentId: id,
        source: "link"
      });
    }
    return agents;
  }

  /**
   * Strategy C (best effort): one guarded click on a control whose *exact* accessible name is a
   * known "all agents" disclosure, then rerun A+B and return to the landing page. Without such a
   * control, the landing page's own links to the known agent-list routes (`AGENT_LIST_ROUTES`) are
   * followed instead, one at a time, by plain same-origin navigation -- never a click on an unknown
   * control -- until one of them reveals an agent the rail did not show. Any problem is reported as
   * a warning; discovery never retries and never clicks a second control.
   */
  private async storeAgents(
    page: PageLike,
    origin: string,
    surface: Surface,
    landingUrl: string,
    known: ReadonlySet<string>,
    warnings: string[],
    role: { value: string; section?: string } = { value: "unavailable" },
    run: {
      deadlineMs?: number;
      progress?: (message: string, extra?: { current?: number; total?: number }) => void;
      /** Raw rows + links the landing page showed before anything was clicked: after the one
       * guarded click, the count has to move away from it before the revealed list counts as
       * rendered (see `revealedAgents`). */
      baselineRaw?: number;
    } = {}
  ): Promise<DiscoveredAgent[]> {
    const scanWarnings: string[] = [];
    const collected: DiscoveredAgent[] = [];
    // Metadata-only descriptions of agent-list routes that showed nothing the selectors recognize.
    // Reported only when the whole route pass ends empty (or fails): a route that merely had nothing
    // new before a later one succeeded needs no diagnosing, and its description is noise.
    const routeDescriptions: string[] = [];
    const stages: string[] = [];
    const report = () => {
      role.value = stages.join(">");
    };
    try {
      // At most one click in total: the agent section's own "show all" control when it has one,
      // otherwise the page-wide, exactly named all-agents control.
      const section = await this.sectionDisclosure(page);
      const disclosure = "locator" in section ? section : undefined;
      role.section = disclosure ? `clicked:${disclosure.name}` : (section as { reason: string }).reason;
      const control = disclosure ? undefined : await this.storeControl(page);
      if (disclosure || control) {
        stages.push(disclosure ? `section:${disclosure.name}` : control!.role);
        report();
        await (disclosure ?? control!).locator.click?.();
        const { revealed } = await this.revealedAgents(page, origin, surface, known, scanWarnings, {
          baseline: run.baselineRaw
        });
        collected.push(...revealed);
        if (new URL(page.url()).pathname.replace(/\/+$/, "") === AGENT_STORE_ROUTE) {
          collected.push(
            ...(await this.storeCatalogue(page, origin, surface, page.url(), warnings, {
              deadlineMs: run.deadlineMs ?? Date.now() + this.storeWaitMs,
              progress: run.progress
            }))
          );
          return merge(collected);
        }
        // Also visit the catalogue: a sidebar usually has names but no descriptions.
      }
      const routes = await this.agentListRoutes(page);
      if (!routes.length) {
        if (collected.some((agent) => !known.has(agent.stableAgentId ?? agent.url))) return merge(collected);
        if (!stages.length) {
          role.value = "unavailable";
          warnings.push("store-unavailable");
        } else {
          stages.push("no-routes");
          report();
        }
        return merge(collected);
      }
      for (const route of routes) {
        stages.push(`route:${route.pathname}`);
        report();
        await page.goto?.(route.href, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
        this.navigator.assertNavigationSafe(page, "app-or-auth");
        const { revealed } = await this.revealedAgents(page, origin, surface, known, scanWarnings);
        collected.push(...revealed);
        if (route.pathname === AGENT_STORE_ROUTE) {
          // The store lists its agents as cards without links or ids: resolve them one by one.
          const catalogue = await this.storeCatalogue(page, origin, surface, route.href, warnings, {
            deadlineMs: run.deadlineMs ?? Date.now() + this.storeWaitMs,
            progress: run.progress
          });
          const merged = merge([...collected, ...catalogue]);
          // The catalogue can enrich already-known sidebar agents with their real descriptions.
          if (merged.length) return merged;
        }
        stages.pop();
        // Nothing the selectors recognize: describe this page too, so its shape can be matched
        // should no later route reveal anything either.
        const description = await this.describePage(page, `route:${route.pathname}`);
        if (description) routeDescriptions.push(description);
      }
      if (collected.some((agent) => !known.has(agent.stableAgentId ?? agent.url))) return merge(collected);
      stages.push(`route-empty:${routes.map((route) => route.pathname).join(",")}`);
      report();
      warnings.push(...routeDescriptions);
      return merge(collected);
    } catch {
      warnings.push(...routeDescriptions, "store-unavailable");
      return merge(collected);
    } finally {
      warnings.push(...scanWarnings);
      try {
        if (page.url() !== landingUrl) {
          await page.goto?.(landingUrl, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
          this.navigator.assertNavigationSafe(page, "app-or-auth");
        }
      } catch {
        warnings.push("store-return-failed");
      }
    }
  }

  /**
   * Reruns strategies A+B on the revealed list until something the rail did not show appears,
   * the list has rendered with nothing new, or `storeWaitMs` runs out. `fresh` says whether
   * anything new was seen at all.
   *
   * "Rendered with nothing new" is what keeps a route pass short: a route page (`/chat/all`, the
   * store) rebuilds its rail from the network after `domcontentloaded`, so its raw row/link count
   * starts at zero and settles once the rail is in; when it has been positive and unchanged for
   * `REVEAL_STABLE_POLLS` polls, nothing more is coming and waiting out the budget would only add
   * seconds. After a click on the landing page (`settle.baseline` set) the rail is already there,
   * so the count first has to move away from what it was before the click: a disclosure that
   * expands late must not be mistaken for one that expanded nothing.
   */
  private async revealedAgents(
    page: PageLike,
    origin: string,
    surface: Surface,
    known: ReadonlySet<string>,
    scanWarnings: string[],
    settle: { baseline?: number } = {}
  ): Promise<{ revealed: DiscoveredAgent[]; fresh: boolean }> {
    const deadline = Date.now() + this.storeWaitMs;
    let previous = -1;
    let steady = 0;
    for (;;) {
      this.navigator.assertNavigationSafe(page, "app");
      const rail = await this.scanRail(page);
      const rowsSeen = { count: 0 };
      const linksSeen = { count: 0 };
      const revealed = [
        ...(await this.sidebarAgents(page, origin, surface, scanWarnings, rowsSeen, rail)),
        ...(await this.linkAgents(page, surface, scanWarnings, linksSeen, rail))
      ].map((agent) => ({ ...agent, source: "store" as const }));
      const fresh = revealed.some((agent) => !known.has(agent.stableAgentId ?? agent.url));
      if (fresh) return { revealed, fresh };
      if (Date.now() >= deadline) return { revealed, fresh: false };
      const raw = rowsSeen.count + linksSeen.count;
      steady = raw === previous ? steady + 1 : 1;
      previous = raw;
      if (
        raw > 0 &&
        steady >= REVEAL_STABLE_POLLS &&
        (settle.baseline === undefined || raw !== settle.baseline)
      )
        return { revealed, fresh: false };
      await wait(SETTLE_POLL_MS, page);
    }
  }

  /**
   * The known agent-list routes the landing page actually links to, in `AGENT_LIST_ROUTES` order:
   * same-origin, on an allowlisted application host, and validated by the navigation policy like
   * any other target. Nothing is synthesized: a route the page does not offer is never visited.
   */
  private async agentListRoutes(page: PageLike): Promise<Array<{ pathname: string; href: string }>> {
    if (!page.evaluate) return [];
    let raw: unknown;
    try {
      raw = await page.evaluate<unknown>(() =>
        Array.from(document.querySelectorAll("a[href]")).map((element) => (element as HTMLAnchorElement).href)
      );
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const base = page.url();
    let pageOrigin: string;
    try {
      pageOrigin = new URL(base).origin;
    } catch {
      return [];
    }
    const byPath = new Map<string, string>();
    for (const item of raw) {
      const href = typeof item === "string" ? item : (item as { href?: unknown })?.href;
      if (typeof href !== "string") continue;
      let url: URL;
      try {
        url = new URL(href, base);
      } catch {
        continue;
      }
      if (url.origin !== pageOrigin) continue;
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      if (!(AGENT_LIST_ROUTES as readonly string[]).includes(pathname) || byPath.has(pathname)) continue;
      try {
        this.policy.validate(url.toString(), "app");
      } catch {
        continue;
      }
      byPath.set(pathname, url.toString());
    }
    return AGENT_LIST_ROUTES.filter((pathname) => byPath.has(pathname)).map((pathname) => ({
      pathname,
      href: byPath.get(pathname)!
    }));
  }

  /**
   * Strategy D: the agent store. Microsoft 365 lists the catalogue as cards (buttons named after
   * the agent, no link, no id attribute), so each card is resolved on its own: first by looking
   * for the agent id in the card's own attributes (no click), otherwise by clicking the card and
   * reading where it leads -- straight to `/chat/agent/<id>`, or to a details dialog whose links /
   * attributes carry the id, or whose one "open"-named control (`STORE_OPEN_NAMES`) leads there.
   * Nothing matching `STORE_FORBIDDEN_NAME_PATTERN` is ever clicked, so an agent is never added to
   * the account; per-card overflow menus are never clicked either. The store's own "load more"
   * control is clicked (bounded) first so a paged catalogue is complete. Every card gets
   * `storeItemWaitMs` to react; the whole pass stops at the discovery deadline and reports itself
   * as partial. Once the catalogue is paged in, cards are clicked according to `StoreClickMode`:
   * when the store marks the cards that open an agent (`STORE_OPENS_HINT_PATTERN`), only those are
   * clicked and the rest are counted as `skipped`. Outcome counts are reported as one
   * metadata-only `store-catalog:` warning, and --
   * whenever a card had to be clicked -- one `store-shapes:` warning describes, metadata only, how
   * each `role="list"` group resolved and what the first card of each outcome looked like, so a
   * tenant whose added agents carry a visible marker can be told apart from its catalogue without
   * clicking every card next time.
   */
  private async storeCatalogue(
    page: PageLike,
    origin: string,
    surface: Surface,
    storeUrl: string,
    warnings: string[],
    run: {
      deadlineMs: number;
      progress?: (message: string, extra?: { current?: number; total?: number }) => void;
    }
  ): Promise<DiscoveredAgent[]> {
    const stats = {
      items: 0,
      attribute: 0,
      navigation: 0,
      dialog: 0,
      open: 0,
      forbiddenOnly: 0,
      skipped: 0,
      unresolved: 0,
      errors: 0,
      offHost: 0,
      more: 0,
      partial: false
    };
    let mode: StoreClickMode = "all";
    // Per `role="list"` group: how many cards it held and how they resolved. Per outcome: the
    // shape of the first card that resolved that way (see `markStoreCard`). Both metadata only.
    const lists = new Map<
      string,
      { items: number; navigation: number; forbiddenOnly: number; skipped: number; other: number }
    >();
    const shapes = new Map<StoreOutcome, string>();
    const descriptionDiagnostics = new Map<string, number>();
    const recordDescription = (summary: string) => {
      if (descriptionDiagnostics.has(summary) || descriptionDiagnostics.size < 10)
        descriptionDiagnostics.set(summary, (descriptionDiagnostics.get(summary) ?? 0) + 1);
    };
    const recordExpansionFailure = (error: unknown) => {
      stats.partial = true;
      // One bounded diagnostic per run; a paging failure must not discard readable cards.
      if (!warnings.some((line) => line.startsWith("store-expansion-failed:")))
        warnings.push(`store-expansion-failed:${describeFailure(error)}`);
    };
    const found: DiscoveredAgent[] = [];
    const processed = new Set<string>();
    const readCards = async () => {
      const cards = await this.storeCards(page);
      const perList = new Map<string, number>();
      for (const card of cards) perList.set(card.list, (perList.get(card.list) ?? 0) + 1);
      for (const [list, count] of perList) {
        const entry = lists.get(list) ?? {
          items: 0,
          navigation: 0,
          forbiddenOnly: 0,
          skipped: 0,
          other: 0
        };
        entry.items = Math.max(entry.items, count);
        lists.set(list, entry);
      }
      stats.items = Math.max(stats.items, cards.length);
      return cards;
    };
    try {
      await this.awaitStoreSettled(page, Math.min(run.deadlineMs, Date.now() + this.storeWaitMs));
      stats.more = await this.expandStore(page, run.deadlineMs, recordExpansionFailure);
      let cards = await readCards();
      // Decided once, on the fully paged-in catalogue, and kept for the run.
      mode = storeClickMode(cards);
      const unprocessed = (card: StoreCard) => !processed.has(card.key);
      for (;;) {
        let next = cards.find(unprocessed);
        if (!next && cards.length < stats.items) {
          // Everything showing has been dealt with, but the store showed more before (a re-render
          // still in progress after a return, a lost expansion): let it catch up before concluding.
          cards = await this.restoreStoreCards(
            page,
            stats.items,
            run.deadlineMs,
            readCards,
            () => false,
            recordExpansionFailure
          );
          next = cards.find(unprocessed);
        }
        if (!next) break;
        if (Date.now() >= run.deadlineMs || processed.size >= this.storeMaxItems) {
          stats.partial = true;
          break;
        }
        processed.add(next.key);
        if (mode === "opens" && !next.opens) {
          // A catalogue card: its click would only open a details dialog. Never clicked.
          stats.skipped++;
          const entry = lists.get(next.list);
          if (entry) entry.skipped++;
          continue;
        }
        run.progress?.("Reading the agent store", { current: processed.size, total: cards.length });
        const storeBefore = page.url();
        let outcome: Awaited<ReturnType<AgentDiscovery["resolveStoreCard"]>>;
        try {
          outcome = await this.resolveStoreCard(
            page,
            next,
            origin,
            surface,
            run.deadlineMs,
            recordDescription
          );
        } catch {
          // One card's click or dialog misbehaving is that card's problem, not the run's.
          stats.errors++;
          outcome = { via: "unresolved", navigated: page.url() !== storeBefore };
          stats.unresolved--;
        }
        stats[outcome.via]++;
        const entry = lists.get(next.list);
        if (entry) {
          if (outcome.via === "navigation") entry.navigation++;
          else if (outcome.via === "forbiddenOnly") entry.forbiddenOnly++;
          else entry.other++;
        }
        if (outcome.shape && !shapes.has(outcome.via)) shapes.set(outcome.via, outcome.shape);
        if (outcome.agent) {
          found.push(outcome.agent);
          partialDiscoveries.get(page)?.push(outcome.agent);
        }
        if (outcome.navigated) {
          // The click left the store: come back (history first -- a router push keeps the store's
          // state -- else a fresh load), let it render, and re-read the cards. Paging in again is
          // only needed once every card still showing has been dealt with: a router-style return
          // keeps the expanded catalogue, and each "load more" click is a round trip to the tenant.
          const returned = await this.returnToStore(page, storeUrl, run.deadlineMs);
          if (returned === "off-host") stats.offHost++;
          // The baseline is the most the store has shown so far, not the last read: the lists
          // come back in their own order (the account's own agents after the catalogue), and a
          // partial re-render must never pass for the whole store.
          cards = await this.restoreStoreCards(
            page,
            stats.items,
            run.deadlineMs,
            readCards,
            (card) => unprocessed(card) && (mode === "all" || card.opens),
            recordExpansionFailure
          );
        }
      }
    } catch (error) {
      warnings.push(`store-catalog-failed:${describeFailure(error)}`);
    }
    warnings.push(
      `store-catalog:items=${stats.items} attr=${stats.attribute} nav=${stats.navigation}` +
        ` dialog=${stats.dialog} open=${stats.open} forbidden-only=${stats.forbiddenOnly}` +
        ` skipped=${stats.skipped} none=${stats.unresolved} errors=${stats.errors}` +
        ` off-host=${stats.offHost} more=${stats.more}${stats.partial ? " partial" : ""}`
    );
    if (shapes.size) {
      const listSummary = [...lists.entries()]
        .map(
          ([list, entry]) =>
            `${list}:${entry.items}(nav=${entry.navigation} forbidden=${entry.forbiddenOnly}` +
            ` skipped=${entry.skipped} other=${entry.other})`
        )
        .join("|");
      const shapeSummary = [...shapes.entries()]
        .map(([via, shape]) => `${STORE_OUTCOME_LABELS[via]}={${shape}}`)
        .join("|");
      const line = `store-shapes:filter=${mode} lists=${listSummary} cards=${shapeSummary}`;
      warnings.push(
        line.length > MAX_SUMMARY_LENGTH ? `${line.slice(0, MAX_SUMMARY_LENGTH - 1)}\u2026` : line
      );
    }
    if (descriptionDiagnostics.size)
      warnings.push(
        `description-details:${[...descriptionDiagnostics].map(([shape, count]) => `${shape} count=${count}`).join(" | ")}`
      );
    return found;
  }

  /**
   * Brings the page back to the store after a card navigated away. A single-page router push is
   * undone with `history.back()`, which keeps the store's expanded state; when the URL does not
   * come back within a moment (a full navigation, or a different origin), the store URL is loaded
   * again. A navigation the policy refused (the card led off the approved hosts) is reported as
   * `off-host` rather than aborting the pass: the watcher's recorded refusal is consumed here.
   */
  private async returnToStore(
    page: PageLike,
    storeUrl: string,
    deadlineMs: number
  ): Promise<"history" | "load" | "off-host"> {
    let offHost = false;
    try {
      this.navigator.assertNavigationSafe(page, "app-or-auth");
    } catch {
      offHost = true;
    }
    const target = storePath(storeUrl);
    if (page.evaluate && !offHost) {
      try {
        await page.evaluate(() => history.back());
        const backDeadline = Math.min(deadlineMs, Date.now() + 1_500);
        for (;;) {
          if (storePath(page.url()) === target) {
            this.navigator.assertNavigationSafe(page, "app-or-auth");
            return "history";
          }
          if (Date.now() >= backDeadline) break;
          await wait(STORE_REACT_POLL_MS, page);
        }
      } catch {
        /* fall through to a fresh load */
      }
    }
    await page.goto?.(storeUrl, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
    this.navigator.assertNavigationSafe(page, "app-or-auth");
    return offHost ? "off-host" : "load";
  }

  /** Waits until the store has rendered its cards and the count has held steady for a few polls
   * (the store paints skeleton cards first and fills them in from the network), or the deadline
   * passes. */
  private async awaitStoreSettled(page: PageLike, deadlineMs: number): Promise<void> {
    let previous = -1;
    let steady = 0;
    for (;;) {
      const count = (await this.storeCards(page)).length;
      steady = count === previous ? steady + 1 : 1;
      previous = count;
      if ((count > 0 && steady >= REVEAL_STABLE_POLLS) || Date.now() >= deadlineMs) return;
      await wait(STORE_CARDS_POLL_MS, page);
    }
  }

  /**
   * After a return to the store, waits until it either shows a card that still has to be clicked
   * (`pending`) or at least as many cards as before the click -- a router-style return restores
   * the expanded catalogue in place, a fresh load paints skeleton cards and its first page first
   * -- clicking the store's "load more" control whenever it is offered, bounded by
   * `storeWaitMs`. Reading the cards before the store has caught up would end the pass early:
   * every card still showing would already have been dealt with. Going on as soon as the next
   * card to click is back keeps the wait to the lists above it rather than the whole catalogue.
   * Returns the cards it last read.
   */
  private async restoreStoreCards(
    page: PageLike,
    before: number,
    deadlineMs: number,
    read: () => Promise<StoreCard[]>,
    pending: (card: StoreCard) => boolean,
    onExpansionFailure: (error: unknown) => void
  ): Promise<StoreCard[]> {
    const deadline = Math.min(deadlineMs, Date.now() + this.storeWaitMs);
    for (;;) {
      const cards = await read();
      if (cards.length >= before || cards.some(pending) || Date.now() >= deadline) return cards;
      if (!(await this.expandStore(page, deadline, onExpansionFailure)))
        await wait(STORE_CARDS_POLL_MS, page);
    }
  }

  /** Clicks the store's exactly named "load more" control while one is visible, at most
   * `MAX_STORE_MORE_CLICKS` times, and after each click waits for the catalogue to actually grow
   * (bounded by `storeItemWaitMs`) rather than a fixed moment. Returns how many times it was
   * clicked. */
  private async expandStore(
    page: PageLike,
    deadlineMs: number,
    onFailure: (error: unknown) => void
  ): Promise<number> {
    if (!page.getByRole) return 0;
    let clicks = 0;
    let count = -1;
    for (; clicks < MAX_STORE_MORE_CLICKS && Date.now() < deadlineMs;) {
      let clicked = false;
      for (const name of STORE_MORE_NAMES) {
        const locator = page.getByRole("button", { name, exact: true });
        if (!locator?.click) continue;
        const matches = (await locator.count?.()) ?? 0;
        if (matches < 1) continue;
        const first = locator.first?.() ?? locator;
        if (!((await first.isVisible?.()) ?? false) || !((await first.isEnabled?.()) ?? false)) continue;
        if (count < 0) count = (await this.storeCards(page)).length;
        try {
          await first.click?.({
            timeout: Math.max(1, Math.min(this.storeItemWaitMs, deadlineMs - Date.now()))
          });
        } catch (error) {
          // The returning store can replace its skeleton/first page between the visibility
          // check and the click. A removed disclosure means there is nothing left to expand;
          // keep the cards that have rendered instead of aborting the whole catalogue.
          if ((await locator.count?.()) === 0 || !((await first.isVisible?.()) ?? false)) return clicks;
          // The control can remain present while its click is obstructed or its list is
          // being replaced. Re-read the available cards and continue within the same budget.
          onFailure(error);
          return clicks;
        }
        clicked = true;
        clicks++;
        count = await this.awaitStoreGrowth(
          page,
          count,
          Math.min(deadlineMs, Date.now() + this.storeItemWaitMs)
        );
        break;
      }
      if (!clicked) break;
    }
    return clicks;
  }

  /** Waits until the store shows more cards than `before`, or the deadline passes; returns the
   * count it last saw. */
  private async awaitStoreGrowth(page: PageLike, before: number, deadlineMs: number): Promise<number> {
    for (;;) {
      const count = (await this.storeCards(page)).length;
      if (count > before || Date.now() >= deadlineMs) return count;
      await wait(STORE_CARDS_POLL_MS, page);
    }
  }

  /**
   * The store's cards: visible buttons inside a `[role="list"]` that are neither an overflow menu,
   * a "load more" control, nor anything add-like. `key` is the card's whole accessible text (the
   * handle it is re-found by after a navigation); `name` is its first text block, `description`
   * the rest -- Microsoft 365 names a card after its agent and then its description. `list` is
   * the enclosing `role="list"` group (its index and, when it has one, its `aria-label` clipped to
   * 24 characters), for the per-list tally in `store-shapes:`.
   */
  private async storeCards(page: PageLike): Promise<StoreCard[]> {
    if (!page.evaluate) return [];
    let raw: unknown;
    try {
      raw = await page.evaluate<unknown>(readStoreCards, {
        skip: STORE_SKIP_NAME_PATTERN.source,
        forbidden: STORE_FORBIDDEN_NAME_PATTERN.source,
        more: [...STORE_MORE_NAMES],
        max: this.storeMaxItems,
        opens: STORE_OPENS_HINT_PATTERN.source
      });
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (
          card
        ): card is { key: string; name: string; description?: string; list?: unknown; opens?: unknown } =>
          !!card &&
          typeof card === "object" &&
          typeof (card as { key?: unknown }).key === "string" &&
          typeof (card as { name?: unknown }).name === "string"
      )
      .map((card) => ({
        ...card,
        list: typeof card.list === "string" ? card.list : "#?",
        opens: card.opens === true
      }));
  }

  /**
   * Resolves one card to an agent URL (see `storeCatalogue`). `navigated` tells the caller the
   * page left the store and has to be brought back.
   */
  private async resolveStoreCard(
    page: PageLike,
    card: StoreCard,
    origin: string,
    surface: Surface,
    deadlineMs: number,
    onDescriptionDiagnostic?: (summary: string) => void
  ): Promise<{
    agent?: DiscoveredAgent;
    via: StoreOutcome;
    navigated: boolean;
    /** The card's metadata-only shape (see `markStoreCard`), for `store-shapes:`. */
    shape?: string;
  }> {
    const toAgent = (id: string, pageDescription?: string): DiscoveredAgent | undefined => {
      const url = this.safeAgentUrl(origin, id);
      if (!url) return undefined;
      const displayName = usableName(card.name) ?? usableName(card.key);
      if (!displayName) return undefined;
      return {
        url,
        surface,
        displayName,
        stableAgentId: id,
        description: usableDescription(card.description) ?? usableDescription(pageDescription),
        source: "store"
      };
    };
    const token = randomBytes(4).toString("hex");
    const marked = await this.markStoreCard(page, card.key, token);
    if (!marked.found) return { via: "unresolved", navigated: false };
    const shape = marked.shape;
    if (marked.id) {
      const agent = toAgent(marked.id);
      return agent
        ? { agent, via: "attribute", navigated: false, shape }
        : { via: "unresolved", navigated: false, shape };
    }
    if (!page.locator) return { via: "unresolved", navigated: false, shape };
    const before = page.url();
    await page.locator(`[${CARD_MARKER}="${token}"]`).click?.({ timeout: this.storeItemWaitMs });
    const itemDeadline = Math.min(deadlineMs, Date.now() + this.storeItemWaitMs);
    for (;;) {
      const current = page.url();
      if (current !== before) {
        const id = agentIdFromPath(current);
        if (id) {
          // The tenant's added-agent cards can expose only an operational aria-description (for
          // example, "Press Enter to open") and no visible metadata. We are already on the
          // agent's direct page after this permitted navigation, so read only explicitly marked
          // description metadata there; never infer a description from the surrounding chat UI.
          const agent = toAgent(
            id,
            card.description
              ? undefined
              : await this.agentPageDescription(page, card.name, deadlineMs, onDescriptionDiagnostic)
          );
          return agent
            ? { agent, via: "navigation", navigated: true, shape }
            : { via: "unresolved", navigated: true, shape };
        }
      }
      const dialog = await this.storeDialog(page, token);
      if (dialog) {
        if (dialog.id) {
          const agent = toAgent(dialog.id);
          await this.closeStoreDialog(page);
          return agent
            ? { agent, via: "dialog", navigated: false, shape }
            : { via: "unresolved", navigated: false, shape };
        }
        if (dialog.openMarked && page.locator) {
          await page.locator(`[${OPEN_MARKER}="${token}"]`).click?.({ timeout: this.storeItemWaitMs });
          const openDeadline = Math.min(deadlineMs, Date.now() + this.storeItemWaitMs);
          for (;;) {
            const id = agentIdFromPath(page.url());
            if (id) {
              const agent = toAgent(
                id,
                card.description
                  ? undefined
                  : await this.agentPageDescription(page, card.name, deadlineMs, onDescriptionDiagnostic)
              );
              return agent
                ? { agent, via: "open", navigated: true, shape }
                : { via: "unresolved", navigated: true, shape };
            }
            if (Date.now() >= openDeadline) break;
            await wait(STORE_REACT_POLL_MS, page);
          }
          await this.closeStoreDialog(page);
          return { via: "unresolved", navigated: page.url() !== before, shape };
        }
        await this.closeStoreDialog(page);
        return { via: dialog.forbiddenOnly ? "forbiddenOnly" : "unresolved", navigated: false, shape };
      }
      if (Date.now() >= itemDeadline) break;
      await wait(STORE_REACT_POLL_MS, page);
    }
    return { via: "unresolved", navigated: page.url() !== before, shape };
  }

  /** Reads an agent description only from explicit metadata on a direct-agent page. This is used
   * after Strategy D has already followed a safe agent-card navigation, for tenants whose cards
   * contain no description text at all. It deliberately does not scrape headings, chat messages,
   * or arbitrary nearby text. */
  private async agentPageDescription(
    page: PageLike,
    agentName: string,
    deadlineMs: number,
    onDiagnostic?: (summary: string) => void
  ): Promise<string | undefined> {
    const cached = this.cachedDescription(page.url(), agentName);
    if (cached) {
      onDiagnostic?.("stage=cached-description");
      return cached;
    }
    if (!page.evaluate) return undefined;
    // A route change can precede the agent header and its modal data by several seconds.
    // Keep both phases within one bounded inspection budget and the overall discovery deadline.
    const deadline = Math.min(deadlineMs, Date.now() + this.descriptionWaitMs);
    if (Date.now() >= deadline) return undefined;
    let opened = false;
    let stage = "explicit";
    try {
      const explicit = usableDescription(await page.evaluate(readAgentPageDescription));
      if (explicit) {
        stage = "found-explicit";
        return this.rememberDescription(page.url(), agentName, explicit);
      }
      stage = "title";
      // The current M365 Agent Builder surface exposes the real description only in the details
      // overlay reached from the exact agent-title button. This is an inspect-only UI action: it
      // neither opens the agent nor changes account state, and the overlay is closed immediately.
      let title = page.getByRole?.("button", { name: agentName, exact: true });
      while (
        (!title || (await title.count?.()) !== 1 || !((await title.isVisible?.()) ?? false)) &&
        Date.now() < deadline
      ) {
        await wait(STORE_REACT_POLL_MS, page);
        title = page.getByRole?.("button", { name: agentName, exact: true });
      }
      if (
        Date.now() >= deadline ||
        !title ||
        (await title.count?.()) !== 1 ||
        !((await title.isVisible?.()) ?? false)
      )
        return undefined;
      await title.click?.({ timeout: Math.max(1, deadline - Date.now()) });
      opened = true;
      stage = "dialog";
      for (;;) {
        const description = usableDescription(await page.evaluate(readAgentDetailsDescription, agentName));
        if (description) {
          stage = "found-dialog";
          return this.rememberDescription(page.url(), agentName, description);
        }
        if (Date.now() >= deadline) return undefined;
        await wait(STORE_REACT_POLL_MS, page);
      }
    } catch {
      return undefined;
    } finally {
      if (onDiagnostic) {
        const shape = stage.startsWith("found-")
          ? ""
          : await page.evaluate(describeAgentDetails, agentName).catch(() => "unreadable");
        const titleMatches =
          stage === "title"
            ? await page
                .getByRole?.("button", { name: agentName, exact: true })
                .count?.()
                .catch(() => -1)
            : undefined;
        onDiagnostic(
          `stage=${stage} opened=${Number(opened)}${titleMatches !== undefined ? ` titleMatches=${titleMatches}` : ""}${shape ? ` ${shape}` : ""}`
        );
      }
      if (opened && (await this.storeDialogVisible(page)))
        await this.closeStoreDialog(page).catch(() => undefined);
    }
  }

  /**
   * Marks the card whose accessible text is `key`, scans its subtree for an agent id, and
   * describes the subtree's shape. The shape is metadata only -- the attribute *names* of the
   * card and its list item, descendant `data-testid` values, tag/role tallies, `aria-*` state
   * attributes, and which chrome-word class (added / add / open / check) any descendant control's
   * accessible name falls into, never the name itself, an id, or a URL -- so that an "added"
   * marker, if the store renders one, can be recognized from the `store-shapes:` line.
   */
  private async markStoreCard(
    page: PageLike,
    key: string,
    token: string
  ): Promise<{ found: boolean; id?: string; shape?: string }> {
    if (!page.evaluate) return { found: false };
    let raw: unknown;
    try {
      raw = await page.evaluate<unknown>(
        (args: { key: string; marker: string; token: string; idPattern: string; rowSelector: string }) => {
          const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
          const idPattern = new RegExp(args.idPattern, "i");
          const card = Array.from(
            document.querySelectorAll('[role="list"] button, [role="list"] [role="button"]')
          ).find(
            (element) => normalize(element.getAttribute("aria-label") || element.textContent) === args.key
          );
          if (!card) return { found: false };
          card.setAttribute(args.marker, args.token);
          const scope = card.closest('[role="listitem"]') ?? card;
          const shapeOf = (): string => {
            const attrs = new Set<string>();
            const states: string[] = [];
            for (const element of scope === card ? [card] : [scope, card])
              for (const attribute of Array.from(element.attributes)) {
                if (attribute.name === args.marker) continue;
                attrs.add(attribute.name);
                if (
                  /^aria-(pressed|selected|checked|current|disabled|expanded|haspopup)$/.test(attribute.name)
                )
                  states.push(`${attribute.name}=${attribute.value.slice(0, 8)}`);
              }
            const testIds = new Set<string>();
            for (const element of Array.from(scope.querySelectorAll("[data-testid]")).slice(0, 50))
              testIds.add(normalize(element.getAttribute("data-testid")).slice(0, 24));
            const tags = new Map<string, number>();
            for (const element of Array.from(scope.querySelectorAll("*")).slice(0, 200)) {
              const tag = element.getAttribute("role") || element.tagName.toLowerCase();
              tags.set(tag, (tags.get(tag) ?? 0) + 1);
            }
            const classes: Array<[string, RegExp]> = [
              ["added", /追加済み|added|installed|インストール済み/i],
              ["add", /追加|\badd\b|install|取得|\bget\b/i],
              ["open", /開く|\bopen\b/i],
              ["check", /check|チェック|選択|selected/i],
              ["pin", /ピン|\bpin/i],
              ["remove", /削除|remove|uninstall/i]
            ];
            // The card's (and its list item's) own labelling attributes: which chrome-word classes
            // their values fall into, and the value length -- a state marker ("追加済み") is short,
            // an agent description is not. Never the value itself.
            const self: string[] = [];
            for (const [owner, element] of scope === card
              ? ([["card", card]] as Array<[string, Element]>)
              : ([
                  ["item", scope],
                  ["card", card]
                ] as Array<[string, Element]>))
              for (const attribute of ["aria-label", "aria-description", "title"]) {
                const value = normalize(element.getAttribute(attribute));
                if (!value) continue;
                const matched = classes.filter(([, pattern]) => pattern.test(value)).map(([label]) => label);
                self.push(`${owner}.${attribute}:${matched.join("+") || "-"}(${value.length})`);
              }
            // Short own-text blocks (a badge, a status word) classified the same way.
            const texts = new Set<string>();
            for (const element of Array.from(scope.querySelectorAll("*")).slice(0, 200)) {
              const own = Array.from(element.childNodes)
                .filter((child) => child.nodeType === Node.TEXT_NODE)
                .map((child) => normalize(child.textContent))
                .filter(Boolean)
                .join(" ");
              if (!own || own.length > 24) continue;
              for (const [label, pattern] of classes) if (pattern.test(own)) texts.add(label);
            }
            // Descendant data-* attribute *names* (never values): an "installed" flag, an icon name.
            const dataNames = new Set<string>();
            for (const element of Array.from(scope.querySelectorAll("*")).slice(0, 200))
              for (const attribute of Array.from(element.attributes))
                if (attribute.name.startsWith("data-") && attribute.name !== "data-testid")
                  dataNames.add(attribute.name);
            const chrome = new Set<string>();
            for (const element of Array.from(
              scope.querySelectorAll(
                'button, a, [role="button"], [role="img"], img, svg, [aria-label], [title]'
              )
            ).slice(0, 50)) {
              if (element === card) continue;
              const name = normalize(
                element.getAttribute("aria-label") ||
                  element.getAttribute("title") ||
                  element.getAttribute("alt") ||
                  (element.tagName === "BUTTON" ? element.textContent : "")
              ).slice(0, 40);
              if (!name) continue;
              for (const [label, pattern] of classes) if (pattern.test(name)) chrome.add(label);
            }
            return (
              `attrs=${Array.from(attrs).sort().join(",")} testid=${Array.from(testIds).join(",") || "-"}` +
              ` tags=${Array.from(tags.entries())
                .map(([tag, count]) => `${tag}:${count}`)
                .join(",")}` +
              ` states=${states.join(",") || "-"} chrome=${Array.from(chrome).join(",") || "-"}` +
              ` data=${Array.from(dataNames).sort().slice(0, 12).join(",") || "-"}` +
              ` self=${self.join(",") || "-"} text=${Array.from(texts).join(",") || "-"}`
            ).slice(0, 520);
          };
          const shape = shapeOf();
          const row = scope.matches(args.rowSelector) ? scope : scope.querySelector(args.rowSelector);
          const direct = row?.getAttribute("data-agent-id")?.trim();
          if (direct) return { found: true, id: direct, shape };
          for (const element of [scope, ...Array.from(scope.querySelectorAll("*"))].slice(0, 300)) {
            for (const attribute of Array.from(element.attributes)) {
              const match = idPattern.exec(attribute.value);
              if (match) return { found: true, id: match[0], shape };
            }
          }
          return { found: true, shape };
        },
        {
          key,
          marker: CARD_MARKER,
          token,
          idPattern: AGENT_ID_PATTERN.source,
          rowSelector: AGENT_ROW_SELECTOR
        }
      );
    } catch {
      return { found: false };
    }
    const outcome = (raw && typeof raw === "object" ? raw : {}) as {
      found?: unknown;
      id?: unknown;
      shape?: unknown;
    };
    return {
      found: outcome.found === true,
      ...(typeof outcome.id === "string" && outcome.id ? { id: outcome.id } : {}),
      ...(typeof outcome.shape === "string" && outcome.shape ? { shape: outcome.shape } : {})
    };
  }

  /**
   * The visible details dialog, if one is open: any agent id in its links or attributes, and --
   * when there is none -- whether it offers exactly one "open"-named control (marked for the click)
   * or only add-like controls.
   */
  private async storeDialog(
    page: PageLike,
    token: string
  ): Promise<{ id?: string; openMarked: boolean; forbiddenOnly: boolean } | undefined> {
    if (!page.evaluate) return undefined;
    let raw: unknown;
    try {
      raw = await page.evaluate<unknown>(
        (args: {
          idPattern: string;
          open: string[];
          forbidden: string;
          marker: string;
          token: string;
          rowSelector: string;
        }) => {
          const visible = (element: Element): boolean => {
            const style = getComputedStyle(element as HTMLElement);
            const rect = (element as HTMLElement).getBoundingClientRect();
            return (
              style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
            );
          };
          const dialog = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).find(
            visible
          );
          if (!dialog) return undefined;
          const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
          const idPattern = new RegExp(args.idPattern, "i");
          const forbidden = new RegExp(args.forbidden, "i");
          const row = dialog.querySelector(args.rowSelector);
          const direct = row?.getAttribute("data-agent-id")?.trim();
          if (direct) return { id: direct, openMarked: false, forbiddenOnly: false };
          for (const anchor of Array.from(dialog.querySelectorAll("a"))) {
            const href = anchor.getAttribute("href") ?? "";
            const match = /\/chat\/agent\/([^/?#]+)/i.exec(href);
            if (match?.[1]) {
              try {
                return { id: decodeURIComponent(match[1]), openMarked: false, forbiddenOnly: false };
              } catch {
                /* keep looking */
              }
            }
          }
          for (const element of [dialog, ...Array.from(dialog.querySelectorAll("*"))].slice(0, 500)) {
            for (const attribute of Array.from(element.attributes)) {
              const match = idPattern.exec(attribute.value);
              if (match) return { id: match[0], openMarked: false, forbiddenOnly: false };
            }
          }
          const controls = Array.from(
            dialog.querySelectorAll('button, a, [role="button"], [role="link"]')
          ).filter(visible);
          const openers = controls.filter((element) => {
            const name = normalize(element.getAttribute("aria-label") || element.textContent).toLowerCase();
            return args.open.includes(name) && !forbidden.test(name);
          });
          if (openers.length === 1) {
            openers[0]!.setAttribute(args.marker, args.token);
            return { openMarked: true, forbiddenOnly: false };
          }
          const forbiddenOnly =
            controls.length > 0 &&
            controls.every((element) => {
              const name = normalize(element.getAttribute("aria-label") || element.textContent);
              return forbidden.test(name) || /閉じる|キャンセル|close|cancel|dismiss/i.test(name);
            });
          return { openMarked: false, forbiddenOnly };
        },
        {
          idPattern: AGENT_ID_PATTERN.source,
          open: STORE_OPEN_NAMES.map((name) => name.toLowerCase()),
          forbidden: STORE_FORBIDDEN_NAME_PATTERN.source,
          marker: OPEN_MARKER,
          token,
          rowSelector: AGENT_ROW_SELECTOR
        }
      );
    } catch {
      return undefined;
    }
    if (!raw || typeof raw !== "object") return undefined;
    const outcome = raw as { id?: unknown; openMarked?: unknown; forbiddenOnly?: unknown };
    return {
      ...(typeof outcome.id === "string" && outcome.id ? { id: outcome.id } : {}),
      openMarked: outcome.openMarked === true,
      forbiddenOnly: outcome.forbiddenOnly === true
    };
  }

  /** Escape first; then, if a dialog is still open, its exactly named dismiss control. Polls for
   * the dialog to disappear instead of pausing a fixed moment: on a catalogue of hundreds of
   * cards, every dismissal is on the critical path. */
  private async closeStoreDialog(page: PageLike): Promise<void> {
    const dialog = page.locator?.('[role="dialog"], [role="alertdialog"]');
    try {
      await dialog?.first?.()?.press?.("Escape", { timeout: 1_000 });
    } catch {
      /* fall through to the dismiss control */
    }
    if (await this.awaitDialogClosed(page, Date.now() + DIALOG_CLOSE_WAIT_MS)) return;
    if (!page.getByRole) return;
    try {
      for (const name of STORE_CLOSE_NAMES) {
        const locator = page.getByRole("button", { name, exact: true });
        const matches = (await locator?.count?.()) ?? 0;
        if (matches !== 1 || !locator?.click) continue;
        await locator.click({ timeout: 1_000 });
        await this.awaitDialogClosed(page, Date.now() + DIALOG_CLOSE_WAIT_MS);
        return;
      }
    } catch {
      /* best effort */
    }
  }

  /** Polls until no details dialog is visible any more; false when one still is at the deadline. */
  private async awaitDialogClosed(page: PageLike, deadlineMs: number): Promise<boolean> {
    for (;;) {
      if (!(await this.storeDialogVisible(page))) return true;
      if (Date.now() >= deadlineMs) return false;
      await wait(STORE_REACT_POLL_MS, page);
    }
  }

  /** Whether a visible dialog is on the page. Unknown (no evaluate, or it failed) counts as
   * closed: this only decides how long a dismissal waits, never what gets clicked. */
  private async storeDialogVisible(page: PageLike): Promise<boolean> {
    if (!page.evaluate) return false;
    try {
      const raw = await page.evaluate<unknown>(() =>
        Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some((element) => {
          const style = getComputedStyle(element as HTMLElement);
          const rect = (element as HTMLElement).getBoundingClientRect();
          return (
            style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
          );
        })
      );
      return raw === true;
    } catch {
      return false;
    }
  }

  /**
   * The collapsed agent section's own "show all" control: among the visible controls whose exact
   * accessible name is in `SECTION_DISCLOSURE_NAMES` (and that are not inside a row), the one
   * closest to the visible `[data-agent-id]` rows -- deepest common ancestor first, then the first
   * control that follows the last row in document order, then the last one preceding the first row.
   * A "show all" that belongs to another section (the chat history's) therefore loses to the agent
   * section's own, and clicking the wrong one on a flat rail is harmless: it only expands a list.
   * The chosen control is marked with a temporary attribute so the click goes through the ordinary
   * locator path. Returns the reason when nothing is clickable, for the landing summary.
   */
  private async sectionDisclosure(
    page: PageLike
  ): Promise<{ locator: LocatorLike; name: string } | { reason: string }> {
    if (!page.evaluate || !page.locator) return { reason: "no-locator" };
    const token = randomBytes(4).toString("hex");
    let raw: unknown;
    try {
      raw = await page.evaluate<unknown>(
        (args: {
          names: string[];
          marker: string;
          token: string;
          rowSelector: string;
          chromeSelector: string;
        }) => {
          const visible = (element: Element): boolean => {
            const style = getComputedStyle(element as HTMLElement);
            const rect = (element as HTMLElement).getBoundingClientRect();
            return (
              style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
            );
          };
          const rows = Array.from(document.querySelectorAll(args.rowSelector))
            .slice(0, 200)
            .filter((element) => visible(element) && !element.querySelector(args.chromeSelector));
          if (!rows.length) return { reason: "no-rows" };
          const accessibleName = (element: Element) =>
            (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim();
          const controlSelector = 'button, a, [role="button"], [role="link"]';
          const controls = Array.from(document.querySelectorAll(controlSelector)).filter(
            (element) =>
              args.names.includes(accessibleName(element)) &&
              !element.closest(args.rowSelector) &&
              visible(element)
          );
          if (!controls.length) return { reason: "no-control" };
          const depthOf = (element: Element) => {
            let depth = 0;
            for (let node: Element | null = element; node; node = node.parentElement) depth++;
            return depth;
          };
          const commonDepth = (left: Element, right: Element) => {
            const ancestors = new Set<Element>();
            for (let node: Element | null = left; node; node = node.parentElement) ancestors.add(node);
            for (let node: Element | null = right; node; node = node.parentElement)
              if (ancestors.has(node)) return depthOf(node);
            return 0;
          };
          const scored = controls.map((element) => ({
            element,
            score: Math.max(...rows.map((row) => commonDepth(element, row)))
          }));
          const best = Math.max(...scored.map((entry) => entry.score));
          let candidates = scored.filter((entry) => entry.score === best).map((entry) => entry.element);
          if (candidates.length > 1) {
            const lastRow = rows[rows.length - 1]!;
            const firstRow = rows[0]!;
            const following = candidates.filter(
              (element) => !!(lastRow.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
            );
            const preceding = candidates.filter(
              (element) => !!(firstRow.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING)
            );
            candidates = following.length
              ? [following[0]!]
              : preceding.length
                ? [preceding[preceding.length - 1]!]
                : [candidates[0]!];
          }
          const chosen = candidates[0]!;
          chosen.setAttribute(args.marker, args.token);
          return { name: accessibleName(chosen), candidates: controls.length };
        },
        {
          names: [...SECTION_DISCLOSURE_NAMES],
          marker: DISCLOSURE_MARKER,
          token,
          rowSelector: AGENT_ROW_SELECTOR,
          chromeSelector: `${MAIN_REGION_SELECTOR}, ${COMPOSER_SELECTORS.join(", ")}`
        }
      );
    } catch {
      return { reason: "scan-failed" };
    }
    const outcome = (raw && typeof raw === "object" ? raw : {}) as { name?: unknown; reason?: unknown };
    if (typeof outcome.name !== "string" || !outcome.name)
      return { reason: typeof outcome.reason === "string" ? outcome.reason : "no-control" };
    const locator = page.locator(`[${DISCLOSURE_MARKER}="${token}"]`);
    if (!locator?.click) return { reason: "no-click" };
    if (!((await locator.isVisible?.()) ?? true) || !((await locator.isEnabled?.()) ?? true))
      return { reason: "hidden" };
    return { locator, name: outcome.name };
  }

  /**
   * The single control strategy C may click, looked up by exact accessible name across the roles
   * Microsoft 365 has shipped it in. Exactly one match across *all* roles is required: two
   * candidates (in the same role or not) are ambiguous, and discovery never guesses.
   */
  private async storeControl(page: PageLike): Promise<{ locator: LocatorLike; role: string } | undefined> {
    if (!page.getByRole) return undefined;
    for (const name of AGENT_STORE_CONTROL_NAMES) {
      let matched: { locator: LocatorLike; role: string } | undefined;
      let total = 0;
      for (const role of AGENT_STORE_CONTROL_ROLES) {
        const locator = page.getByRole(role, { name, exact: true });
        if (!locator) continue;
        const count = (await locator.count?.()) ?? 1;
        total += count;
        if (count === 1) matched = { locator, role };
      }
      if (total !== 1 || !matched) continue;
      const { locator } = matched;
      if (!((await locator.isVisible?.()) ?? true) || !((await locator.isEnabled?.()) ?? true)) continue;
      if (!locator.click) continue;
      return matched;
    }
    return undefined;
  }

  private safeAgentUrl(origin: string, id: string): string | undefined {
    try {
      const url = new URL(`/chat/agent/${encodeURIComponent(id)}`, origin).toString();
      this.policy.validate(url, "app");
      return url;
    } catch {
      return undefined;
    }
  }
}

/**
 * Browser-context body shared by strategies A (rows) and B (links). It is serialized into the page,
 * so it must stay self-contained: nothing from module scope, every selector passed in through
 * `RailArgs`. Everything it returns is a raw candidate; the policy, generic-name and length filters
 * run in Node.
 *
 * A candidate's name is what a sighted user reads, not what the DOM concatenates. Microsoft 365
 * follows the agent's name in a rail row with a screen-reader-only keyboard hint ("Tab キーを押して
 * [ピン留め]、[その他のオプション] ボタンにアクセスします。"), clipped to one pixel and rendered with no
 * separator after the name, so `textContent` reads "<name>Tab キーを押して…". The name is therefore
 * the element's *first readable text block*: its text nodes in document order, skipping anything
 * hidden, transparent, clipped to a pixel, `aria-hidden`, or inside an avatar/icon, and stopping at
 * the first block-level boundary once text has been found (a description or a conversation list
 * rendered below the name never joins it). Only an element that shows no readable text at all is
 * named from its `aria-label` (links: then `title`).
 */
export function readRail(args: RailArgs): { rows: RawSidebarCandidate[]; links: RawLinkCandidate[] } {
  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  /** Whether nothing inside `element` reaches a sighted user as text. */
  const unreadable = (element: Element): boolean => {
    if (element.getAttribute("aria-hidden") === "true" || element.matches(args.decor)) return true;
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0"
    )
      return true;
    if (style.display === "contents") return false;
    const rect = element.getBoundingClientRect();
    return rect.width <= 1 || rect.height <= 1;
  };
  const inline = (element: Element): boolean => {
    const display = getComputedStyle(element).display;
    return display === "inline" || display === "contents";
  };
  const firstReadableBlock = (root: Element): string => {
    const readable = new Map<Element, boolean>();
    const isReadable = (element: Element): boolean => {
      if (element === root) return true;
      let known = readable.get(element);
      if (known === undefined) {
        known = !unreadable(element) && (!element.parentElement || isReadable(element.parentElement));
        readable.set(element, known);
      }
      return known;
    };
    // The nearest non-inline ancestor: text under two different ones sits on different lines.
    const blockOf = (element: Element): Element => {
      let node = element;
      while (node !== root && inline(node) && node.parentElement) node = node.parentElement;
      return node;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let block: Element | undefined;
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !isReadable(parent)) continue;
      const raw = node.textContent ?? "";
      if (!raw.trim()) {
        // Whitespace between two words of the same line is kept; leading whitespace is not.
        if (block) text += raw;
        continue;
      }
      const owner = blockOf(parent);
      if (block && owner !== block) break;
      block = owner;
      text += raw;
    }
    return normalize(text);
  };
  const within = (text: string) => (text.length <= args.maxName ? text : "");
  const readDescription = (element: Element): string | undefined => {
    const explicit = element.querySelector('[data-agent-description], [data-testid*="description" i]');
    const referenced = (element.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => !!node && !unreadable(node))
      .map((node) => normalize(node.innerText))
      // Accessible instructions for operating the rail are not agent descriptions.
      .filter((text) => !/キーを押|press\s+.*\b(?:key|tab)\b/i.test(text))
      .join(" ");
    return (
      normalize(element.getAttribute("data-agent-description")) ||
      normalize(
        explicit?.getAttribute("data-agent-description") || (explicit as HTMLElement | null)?.innerText
      ) ||
      referenced ||
      undefined
    );
  };

  const rows: RawSidebarCandidate[] = [];
  for (const element of Array.from(document.querySelectorAll(args.rows))) {
    if (!visible(element)) continue;
    const id = element.getAttribute("data-agent-id")?.trim();
    if (!id) continue;
    // An application shell can carry data-agent-id too; its text is the whole page, so visible
    // text is only a name source when the element wraps no chat chrome.
    const wrapsChrome = !!element.querySelector(args.main) || !!element.querySelector(args.composer);
    const name =
      normalize(element.getAttribute("data-agent-name")) ||
      within(wrapsChrome ? "" : firstReadableBlock(element)) ||
      normalize(element.getAttribute("aria-label"));
    if (!name) continue;
    rows.push({
      id,
      name,
      description: readDescription(element)
    });
  }
  const links: RawLinkCandidate[] = [];
  for (const element of Array.from(document.querySelectorAll("a[href]"))) {
    if (!visible(element)) continue;
    links.push({
      href: (element as HTMLAnchorElement).href,
      name:
        within(firstReadableBlock(element)) ||
        normalize(element.getAttribute("aria-label")) ||
        normalize(element.getAttribute("title"))
    });
  }
  return { rows, links };
}

/** Read visible catalogue names and descriptions separately from their accessible click targets. */
export function readStoreCards(args: {
  skip: string;
  forbidden: string;
  more: string[];
  max: number;
  opens: string;
}): StoreCard[] {
  const skip = new RegExp(args.skip, "i");
  const forbidden = new RegExp(args.forbidden, "i");
  const opens = new RegExp(args.opens, "i");
  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element as HTMLElement);
    const rect = (element as HTMLElement).getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const readable = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"], [role="img"], svg')) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const readableText = (root: Element): string => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement && readable(node.parentElement)) parts.push(node.textContent ?? "");
    }
    return normalize(parts.join(" "));
  };
  const firstTextBlock = (root: Element): string => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode as Element | null; node; node = walker.nextNode() as Element | null) {
      const own = Array.from(node.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => normalize(child.textContent))
        .filter(Boolean)
        .join(" ");
      if (own && readable(node)) return own;
    }
    return "";
  };
  const lists = Array.from(document.querySelectorAll('[role="list"]'));
  const listOf = (element: Element): string => {
    const list = element.closest('[role="list"]');
    if (!list) return "#?";
    return `#${lists.indexOf(list)}:${normalize(list.getAttribute("aria-label")).slice(0, 24) || "-"}`;
  };
  const cards: Array<{
    key: string;
    name: string;
    description?: string;
    list: string;
    opens: boolean;
  }> = [];
  const seen = new Set<string>();
  for (const element of Array.from(
    document.querySelectorAll('[role="list"] button, [role="list"] [role="button"]')
  ).slice(0, 2000)) {
    if (!visible(element)) continue;
    // Menus and toggles (pin, favourite) live inside the lists too; neither is a card.
    if (element.getAttribute("aria-haspopup") || element.hasAttribute("aria-pressed")) continue;
    if (/more-options|overflow|menu/i.test(element.getAttribute("data-testid") ?? "")) continue;
    const key = normalize(element.getAttribute("aria-label") || element.textContent);
    if (!key || key.length > 8000) continue;
    if (args.more.includes(key) || skip.test(key) || forbidden.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = firstTextBlock(element) || normalize(element.getAttribute("aria-label")) || key;
    // An aria-label often contains only the name, while the description is rendered
    // underneath it. Read the visible card, not the accessible name's empty suffix.
    const text = readableText(element);
    const explicit = element.querySelector('[data-agent-description], [data-testid*="description" i]');
    const rest =
      normalize(element.getAttribute("data-agent-description")) ||
      normalize(
        explicit?.getAttribute("data-agent-description") || (explicit as HTMLElement | null)?.innerText
      ) ||
      normalize(text.startsWith(name) ? text.slice(name.length) : "");
    const hint =
      normalize(element.getAttribute("aria-description")) ||
      normalize(element.closest('[role="listitem"]')?.getAttribute("aria-description"));
    cards.push({
      key,
      name,
      list: listOf(element),
      opens: opens.test(hint),
      ...(rest ? { description: rest } : {})
    });
    if (cards.length >= args.max) break;
  }
  return cards;
}

/** Extracts a description from explicit, agent-scoped metadata on a direct-agent page. Kept as a
 * serializable function because Playwright evaluates it in the page's document. */
export function readAgentPageDescription(): string | undefined {
  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const visible = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"]')) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const descriptionSelector = [
    "[data-agent-description]",
    '[data-testid*="agent-description" i]',
    '[data-automation-id*="agent-description" i]'
  ].join(", ");
  for (const element of Array.from(document.querySelectorAll(descriptionSelector))) {
    if (!visible(element)) continue;
    const value =
      normalize(element.getAttribute("data-agent-description")) ||
      normalize(element.getAttribute("content")) ||
      normalize((element as HTMLElement).innerText);
    if (value) return value;
  }
  // Some Fluent surfaces put the description outside the title node and point to it with
  // aria-describedby. Follow only agent/header-labelled references, never arbitrary page nodes.
  for (const owner of Array.from(
    document.querySelectorAll(
      '[data-agent-id][aria-describedby], [data-agent-name][aria-describedby], [data-testid*="agent-header" i][aria-describedby], [data-testid*="agent-title" i][aria-describedby]'
    )
  )) {
    for (const id of (owner.getAttribute("aria-describedby") ?? "").split(/\s+/)) {
      const described = id ? document.getElementById(id) : undefined;
      if (described && visible(described)) {
        const value = normalize(described.innerText);
        if (value) return value;
      }
    }
  }
  return undefined;
}

/** Metadata-only diagnostics for a failed details read; never includes tenant text or identifiers. */
export function describeAgentDetails(agentName: string): string {
  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return !element.closest('[hidden], [aria-hidden="true"]') && rect.width > 1 && rect.height > 1;
  };
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
  const shapes = dialogs.slice(0, 3).map((dialog) => {
    const label =
      normalize(dialog.getAttribute("aria-label")) ||
      normalize(
        (dialog.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
      );
    const spans = Array.from(dialog.querySelectorAll("span"));
    const built = spans.find(
      (element) =>
        normalize(element.textContent) === "Microsoft 365 Copilot エージェント ビルダーを使用して構築します"
    );
    const region = built?.nextElementSibling;
    const paragraphs = Array.from(region?.querySelectorAll("p") ?? []);
    const relation =
      label === normalize(agentName)
        ? "exact"
        : label.includes(normalize(agentName))
          ? "contains"
          : label
            ? "other"
            : "empty";
    const names = spans.filter((el) => normalize(el.textContent) === normalize(agentName));
    return `label=${relation} labelLength=${label.length} nameNodes=${names.length} visibleNames=${names.filter(visible).length} nameBefore=${Number(names.some((el) => built && !!(el.compareDocumentPosition(built) & Node.DOCUMENT_POSITION_FOLLOWING)))} built=${Number(!!built)} next=${region?.tagName.toLowerCase() ?? "none"} regionVisible=${Number(!!region && visible(region))} p=${paragraphs.length} visibleP=${paragraphs.filter(visible).length} textLength=${paragraphs.map((el) => normalize(el.textContent)).join("").length}`;
  });
  return `dialogs=${dialogs.length}${shapes.length ? ` {${shapes.join("},{")}}` : ""}`;
}

/** Reads the direct sibling region after Agent Builder's verified boilerplate node. */
export function readAgentDetailsDescription(agentName?: string): string | undefined {
  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const visible = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"], [hidden]')) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    const rect = (element as HTMLElement).getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const expected = normalize(agentName);
  const matched = Array.from(document.querySelectorAll('[role="dialog"]')).find((element) => {
    if (!visible(element)) return false;
    const label =
      normalize(element.getAttribute("aria-label")) ||
      normalize(
        (element.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
      );
    const built = Array.from(element.querySelectorAll("span")).find(
      (node) =>
        normalize(node.textContent) === "Microsoft 365 Copilot エージェント ビルダーを使用して構築します"
    );
    const separator = element.querySelector('[role="separator"]');
    const beforeSeparator = (node: Element) =>
      !separator || !!(node.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING);
    const pairs = Array.from(element.querySelectorAll("span.fui-Text"))
      .filter((node) => visible(node) && beforeSeparator(node))
      .filter((node) => {
        const next = node.nextElementSibling;
        return !!next && next.matches("span.fui-Text") && visible(next) && !!next.querySelector("p");
      });
    const summary = built ?? (pairs.length === 1 ? pairs[0] : undefined);
    if (!summary) return false;
    if (!expected) return true;
    // A resolved accessible label names the dialog authoritatively. In the real M365 DOM its
    // aria-labelledby target can be absent, so only then fall back to a visible exact title that
    // precedes the verified Agent Builder attribution.
    if (label) return label === expected;
    return Array.from(element.querySelectorAll("span, h1, h2, h3, [role='heading']")).some(
      (node) =>
        visible(node) &&
        normalize(node.textContent) === expected &&
        !!(node.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  if (!matched) return undefined;
  const dialog = matched;
  const built = Array.from(dialog.querySelectorAll("span")).find(
    (element) =>
      normalize(element.textContent) === "Microsoft 365 Copilot エージェント ビルダーを使用して構築します"
  );
  const separator = dialog.querySelector('[role="separator"]');
  const beforeSeparator = (node: Element) =>
    !separator || !!(node.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING);
  const pairs = Array.from(dialog.querySelectorAll("span.fui-Text"))
    .filter((node) => visible(node) && beforeSeparator(node))
    .filter((node) => {
      const next = node.nextElementSibling;
      return !!next && next.matches("span.fui-Text") && visible(next) && !!next.querySelector("p");
    });
  const region = built?.nextElementSibling ?? (pairs.length === 1 ? pairs[0]!.nextElementSibling : undefined);
  if (!region || !visible(region)) return undefined;
  const paragraphs = Array.from(region.querySelectorAll("p, li"))
    .filter(visible)
    .map((element) => normalize(element.textContent))
    .filter(Boolean);
  return paragraphs.length ? paragraphs.join("\n") : undefined;
}

/** See `StoreClickMode`: `opens` as soon as one card on the store carries the hint. */
export function storeClickMode(cards: ReadonlyArray<{ opens: boolean }>): StoreClickMode {
  return cards.some((card) => card.opens) ? "opens" : "all";
}

function merge(agents: DiscoveredAgent[]): DiscoveredAgent[] {
  const byKey = new Map<string, DiscoveredAgent>();
  for (const agent of agents) {
    const key = agent.stableAgentId ?? agent.url;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, agent);
      continue;
    }
    byKey.set(key, {
      ...existing,
      description: agent.description ?? existing.description,
      stableAgentId: existing.stableAgentId ?? agent.stableAgentId
    });
  }
  return [...byKey.values()];
}

/** Key names a keyboard hint starts with, chords included ("Shift + Tab"). */
const KEY_NAME =
  "(?:(?:Shift|Ctrl|Control|Alt|Option|Cmd|Command|Meta|Win)\\s*\\+\\s*)*" +
  "(?:Tab|Enter|Return|Esc|Escape|Space|Spacebar|Delete|Del|Backspace|Home|End|Page ?Up|Page ?Down|Insert" +
  "|F(?:[1-9]|1[0-2])|[←↑→↓]|矢印|方向|スペース|エンター|タブ)";
/**
 * The screen-reader-only keyboard hints Microsoft 365 renders after a rail row's name ("Tab キーを
 * 押して [ピン留め]、[その他のオプション] ボタンにアクセスします。", "Press Tab to access the Pin and More
 * options buttons"), as they reach a name through an accessible label that carries them. Matched
 * from a key name to the end of the text only: the hint follows the agent's name with no separator
 * ("APL-T08-PdfFileTab キーを押して…"), so the key name is what anchors the cut.
 */
const KEYBOARD_HINT_PATTERNS = [
  new RegExp(`\\s*[\\[「]?${KEY_NAME}[\\]」]?\\s*キーを押して.*$`),
  new RegExp(`\\s*Press\\s+(?:the\\s+)?${KEY_NAME}(?:\\s+key)?\\s+to\\s+.*$`, "i")
];

/** `text` without a trailing keyboard hint; empty when the text was nothing but one. */
export function stripKeyboardHint(text: string): string {
  for (const pattern of KEYBOARD_HINT_PATTERNS) {
    const stripped = text.replace(pattern, "");
    if (stripped !== text) return stripped.trim();
  }
  return text;
}

function usableName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = stripKeyboardHint(value.replace(/\s+/g, " ").trim());
  if (!name || name.length > MAX_NAME_LENGTH) return undefined;
  if (GENERIC_NAMES.has(name.normalize("NFKC").toLocaleLowerCase())) return undefined;
  return name;
}
function usableDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const description = stripKeyboardHint(value.replace(/\s+/g, " ").trim());
  return description ? description.slice(0, 2000) : undefined;
}
/** The agent id in any `/chat/agent/<id>[/...]` path: after a store card navigated, a landing on
 * the agent's conversation route still names the agent. */
function agentIdFromPath(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const match = /^\/chat\/agent\/([^/?#]+)/i.exec(url.pathname);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}
/** Origin + pathname (no query), for "are we back on the store" comparisons. */
function storePath(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value;
  }
}
/** A failure's code or name plus the first words of its message, with anything URL-shaped or
 * selector-shaped removed: enough to tell a timeout from a policy refusal, never page content. */
function describeFailure(error: unknown): string {
  const code =
    error instanceof BrowserTransportError
      ? error.code
      : error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : error instanceof Error
          ? error.name
          : "unknown";
  const message = error instanceof Error ? error.message : "";
  const words = message
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\[[^\]]*\]|"[^"]*"|'[^']*'/g, "<sel>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return words ? `${code}:${words}` : code;
}
function directAgentId(url: URL): string | undefined {
  const match = /^\/chat\/agent\/([^/]+)\/?$/i.exec(url.pathname);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}
function surfaceForHost(hostname: string): Surface {
  return /(^|\.)teams\./i.test(hostname) ? "teams-web" : "m365-copilot";
}
/** Defensive read of one rail-scroll step: any shape other than the expected one means the page
 * has no scrollable rail (or a fake page returned something else), which ends the hydration. */
function scrollOutcome(value: unknown): { moved: boolean; atEnd: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { moved: false, atEnd: true };
  const outcome = value as { moved?: unknown; atEnd?: unknown };
  return { moved: outcome.moved === true, atEnd: outcome.atEnd !== false };
}

async function wait(ms: number, page: PageLike): Promise<void> {
  discoverySignals.get(page)?.throwIfAborted();
  if (page.waitForTimeout) await page.waitForTimeout(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
  discoverySignals.get(page)?.throwIfAborted();
}
