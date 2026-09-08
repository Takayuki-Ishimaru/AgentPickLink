import { createHash } from "node:crypto";
import { z } from "zod";
export const AliasSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const BindingFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const CapabilityClassSchema = z.enum(["knowledge-only", "actions-possible", "unknown"]);
export type AgentKind = "m365-agent-builder" | "sharepoint-agent" | "copilot-studio";
export type CapabilityClass = z.infer<typeof CapabilityClassSchema>;
export const SUPPORTED_BROWSER_ADAPTER_IDS = new Set([
  "m365-copilot-chat@1",
  "agent-builder-chat@1",
  "copilot-studio-m365-chat@1",
  "teams-web-agent-chat@1"
]);
export type BrowserAgentDefinition = {
  alias: string;
  displayName: string;
  kind: AgentKind;
  transport: "browser";
  entryPoint: { mode: "direct-chat"; url: string; surface: "m365-copilot" | "teams-web" };
  description?: string;
  usageHint?: string;
  enabled: boolean;
  capabilityClass: CapabilityClass;
  uiActionPolicy: "never-click";
  verification: {
    status: "verified" | "unverified";
    adapterId: string;
    expectedDisplayName: string;
    expectedStableAgentId?: string;
    expectedSurface: "m365-copilot" | "teams-web";
    validatedUrlPattern: string;
    bindingFingerprint: string;
    validatedAt: string;
  };
};
export type WorkIqAgentDefinition = { alias: string; transport: "work-iq"; enabled: false };
export type CopilotStudioSdkAgentDefinition = {
  alias: string;
  transport: "copilot-studio-sdk";
  enabled: false;
};
export type AgentDefinition =
  BrowserAgentDefinition | WorkIqAgentDefinition | CopilotStudioSdkAgentDefinition;
export function publicAgent(agent: BrowserAgentDefinition) {
  return {
    alias: agent.alias,
    name: agent.displayName,
    kind: agent.kind,
    description: agent.description,
    usageHint: agent.usageHint,
    capabilityClass: agent.capabilityClass,
    lastValidatedAt: agent.verification.validatedAt
  };
}

const TRANSIENT_QUERY_KEYS = new Set([
  "conversationid",
  "conversation-id",
  "threadid",
  "thread-id",
  "sessionid",
  "session-id",
  "trackingid",
  "tracking-id",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "referrer"
]);

/** Build the stable, non-secret identity that is approved by a workspace. */
export function canonicalBindingIdentity(
  agent: Pick<BrowserAgentDefinition, "transport" | "entryPoint" | "verification">
): string {
  const url = new URL(agent.entryPoint.url);
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLocaleLowerCase();
    if (TRANSIENT_QUERY_KEYS.has(normalized) || normalized.startsWith("utm_")) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const stablePath =
    url.pathname
      .replace(/\/(conversations?|threads?|sessions?)\/[^/]+/gi, "/$1/:conversation")
      .replace(/\/+$/, "") || "/";
  const locator = `${url.protocol}//${url.hostname.toLocaleLowerCase()}${url.port ? `:${url.port}` : ""}${stablePath}${url.search}`;
  return [
    agent.transport,
    agent.entryPoint.surface,
    agent.verification.expectedStableAgentId ?? "",
    locator
  ].join("\n");
}

export function deriveBindingFingerprint(
  agent: Pick<BrowserAgentDefinition, "transport" | "entryPoint" | "verification">
): string {
  return `sha256:${createHash("sha256").update(canonicalBindingIdentity(agent)).digest("hex")}`;
}
