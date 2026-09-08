import type { AgentDefinition } from "../domain/agent.js";
import type { AgentResponse } from "../domain/response.js";
import type { ConversationTransportHandle } from "../domain/conversation.js";
import type { ProgressSink } from "../domain/progress.js";
/** Development relaxations a transport is running with. Reported through `broker.health` so the
 * panel/CLI can say out loud that this broker is not in its production configuration. */
export type TransportDevMode = { insecureLoopback: boolean; devAppUrl: boolean };
/** Metadata-only description of the browser a transport launches: no profile path, no hostnames,
 * no page content. `executable` is present only when the transport resolved one explicitly. */
export type TransportBrowserDescription = {
  channel: string;
  headless: boolean;
  viewport: { width: number; height: number };
  executable?: string;
};
export type TransportHealth = {
  healthy: boolean;
  details?: string;
  /** Always reported by the browser transport; absent on transports that have no dev switches. */
  devMode?: TransportDevMode;
  /** Present when the transport can describe what it launches (see BrowserManager.describe). */
  browser?: TransportBrowserDescription;
};
export type ValidationResult = { valid: boolean; reason?: string };
export type InvocationContext = {
  workspaceKey: string;
  /** Real path of the opened workspace. Used for workspace-local agent artifacts. */
  workspaceRoot?: string;
  conversationHandle: string;
};
/** The opaque handle a transport hands back from createConversation() and receives unchanged on
 * invoke()/closeConversation(). Canonical shape lives on the domain Conversation type (see
 * src/domain/conversation.ts) so the domain layer never has to import this module. */
export type TransportConversation = ConversationTransportHandle;
export type AgentInvokeRequest = {
  message: string;
  requestId?: string;
  signal?: AbortSignal;
  /** Optional metadata-only progress sink (see src/domain/progress.ts). */
  onProgress?: ProgressSink;
};
/** Report returned by a LocalStatePreparer.verifyLocalState() implementation. */
export type LocalStateReport = { owned: boolean };
/**
 * Optional contract a transport may implement to own preparation/verification of its own local
 * on-disk state (e.g. BrowserTransport's dedicated profile directory) during
 * `m365-agent init`/`doctor`. src/config/init.ts accepts an object satisfying (a locally
 * declared, structurally-compatible) shape of this interface as a parameter rather than
 * importing this module, so config has no upward dependency on transports.
 */
export interface LocalStatePreparer {
  prepareLocalState(profilePath: string): Promise<void>;
  verifyLocalState(profilePath: string): Promise<LocalStateReport>;
}
export type CapturedAgent = {
  url: string;
  surface: "m365-copilot" | "teams-web";
  adapterId: string;
  displayName: string;
  stableAgentId?: string;
  validatedUrlPattern: string;
};
/** One agent found by discovery. It is a *candidate* only: registration still verifies it through
 * `inspectAgentUrl` (identity + composer) before it can be approved. */
export type DiscoveredAgent = {
  url: string;
  surface: "m365-copilot" | "teams-web";
  displayName: string;
  stableAgentId?: string;
  description?: string;
  source: "sidebar" | "link" | "store" | "manual";
};
export type BrowserInvalidationEvent = { reason: "crash" | "reset" };
export type DiscoveryResult = {
  agents: DiscoveredAgent[];
  warnings: string[];
  landingUrl?: string;
  /** Hostnames (never URLs) of SharePoint/OneDrive-looking file hosts observed on the landing page,
   * offered to the user as candidates for navigation.downloadHosts. They are suggestions only;
   * nothing is allowlisted without an explicit confirmation. */
  suggestedDownloadHosts?: string[];
};
export interface AgentTransport {
  readonly name: string;
  healthCheck(): Promise<TransportHealth>;
  validateAgent(agent: AgentDefinition): Promise<ValidationResult>;
  createConversation(agent: AgentDefinition, context: InvocationContext): Promise<TransportConversation>;
  invoke(conversation: TransportConversation, request: AgentInvokeRequest): Promise<AgentResponse>;
  closeConversation(conversation: TransportConversation): Promise<void>;
  dispose(): Promise<void>;
}
export interface InteractiveAgentTransport extends AgentTransport {
  /** Interactive sign-in in a dedicated visible window; the resulting session is handed to the hidden
   * automation context through the shared dedicated profile (no cookie/token extraction). */
  login?(timeoutMs?: number, onProgress?: ProgressSink): Promise<{ authenticated: boolean; state: string }>;
  /** True while a shared visible sign-in or its hidden-session verification is pending. */
  isLoginPending?(): boolean;
  /** Cancels an interactive sign-in that is currently running: the visible window is closed and
   * the pending `login()` rejects with AUTH_FAILED ("The sign-in was cancelled."). `cancelled` is
   * false when no sign-in was in progress -- cancelling nothing is not an error. */
  cancelLogin?(): Promise<{ cancelled: boolean }>;
  authenticationState?(): Promise<{ state: string }>;
  resetProfile?(): Promise<void>;
  captureAgent?(timeoutMs?: number): Promise<CapturedAgent>;
  inspectAgentUrl?(url: string): Promise<CapturedAgent>;
  /** Enumerates agents available to the signed-in account (candidates only; see DiscoveredAgent). */
  cancelDiscovery?(operationId: string): Promise<{ cancelled: boolean }>;
  discoverAgents?(
    timeoutMs?: number,
    onProgress?: ProgressSink,
    operationId?: string
  ): Promise<DiscoveryResult>;
  testAgent?(
    agent: AgentDefinition,
    sendTestMessage?: boolean
  ): Promise<ValidationResult & { responseText?: string }>;
  isBrowserRunning?(): boolean;
  /** Fires whenever every page the transport handed out became invalid: a real browser crash, or a
   * deliberate context reset for an interactive sign-in (`reason: "reset"`, not an incident). */
  onBrowserCrash?(handler: (event: BrowserInvalidationEvent) => void): () => void;
}
