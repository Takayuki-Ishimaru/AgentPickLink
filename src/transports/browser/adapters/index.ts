import type { AgentKind } from "../../../domain/agent.js";
import type { ChatUiAdapter } from "../ui-adapter.js";
import type { Surface } from "../types.js";
import { AgentBuilderChatAdapter } from "./agent-builder-adapter.js";
import type { SurfaceChatAdapterOptions } from "./base-chat-adapter.js";
import { CopilotStudioM365Adapter } from "./copilot-studio-m365-adapter.js";
import { M365CopilotChatAdapter } from "./m365-copilot-adapter.js";
import { TeamsWebAdapter } from "./teams-web-adapter.js";

export * from "./m365-copilot-adapter.js";
export * from "./agent-builder-adapter.js";
export * from "./copilot-studio-m365-adapter.js";
export * from "./teams-web-adapter.js";
export * from "./generic-diagnostic-adapter.js";

/** Exactly what a surface adapter's constructor accepts (see SurfaceChatAdapterOptions), so a new
 * adapter knob is threaded from the transport without a second, drifting declaration here. */
export type BrowserAdapterCreateOptions = SurfaceChatAdapterOptions;

/** One entry per surface-serving (submitting) chat UI adapter. This is the
 * single registry: BrowserTransport's default adapter list and
 * SUPPORTED_BROWSER_ADAPTER_IDS in src/domain/agent.ts are both meant to
 * match this list's ids exactly (see tests/browser/adapter-registry.test.ts).
 * The diagnostic-only GenericDiagnosticAdapter is intentionally not part of
 * this registry: it is not a "supported" surface adapter, it never appears
 * in SUPPORTED_BROWSER_ADAPTER_IDS, and BrowserTransport appends it
 * separately as an always-present last-resort fallback. */
export interface BrowserAdapterRegistryEntry {
  readonly id: string;
  readonly surface: Surface;
  /** Which agent kinds select this adapter for its surface. "any" is a
   * surface-wide fallback, tried only after every specific-kind entry for
   * that surface has been ruled out (see adapterIdFor below). */
  readonly kinds: readonly AgentKind[] | "any";
  create(options?: BrowserAdapterCreateOptions): ChatUiAdapter;
}

export const BROWSER_ADAPTER_REGISTRY: readonly BrowserAdapterRegistryEntry[] = [
  {
    id: "m365-copilot-chat@1",
    surface: "m365-copilot",
    kinds: "any",
    create: (options) => new M365CopilotChatAdapter(options)
  },
  {
    id: "agent-builder-chat@1",
    surface: "m365-copilot",
    kinds: ["m365-agent-builder"],
    create: (options) => new AgentBuilderChatAdapter(options)
  },
  {
    id: "copilot-studio-m365-chat@1",
    surface: "m365-copilot",
    kinds: ["copilot-studio"],
    create: (options) => new CopilotStudioM365Adapter(options)
  },
  {
    id: "teams-web-agent-chat@1",
    surface: "teams-web",
    kinds: "any",
    create: (options) => new TeamsWebAdapter(options)
  }
];

/** Derives the adapter id for a (surface, kind) pair the same way the CLI's
 * capture flow does, without depending on registry array order: a
 * specific-kind match for the surface always wins over that surface's "any"
 * fallback entry. Surface always takes precedence over kind (a teams-web
 * surface always resolves to the teams-web adapter, regardless of kind). */
export function adapterIdFor(surface: Surface, kind: AgentKind): string {
  const candidates = BROWSER_ADAPTER_REGISTRY.filter((entry) => entry.surface === surface);
  const exact = candidates.find((entry) => entry.kinds !== "any" && entry.kinds.includes(kind));
  if (exact) return exact.id;
  const fallback = candidates.find((entry) => entry.kinds === "any") ?? candidates[0];
  return fallback?.id ?? "generic-diagnostic@1";
}
