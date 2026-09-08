import {
  deriveBindingFingerprint,
  SUPPORTED_BROWSER_ADAPTER_IDS,
  type BrowserAgentDefinition
} from "../../domain/agent.js";
import { asDomainError, DomainError } from "../../domain/errors.js";
import type { AgentView, ToolError } from "../../frontend/schemas.js";

/** Maps any thrown value into the stable `ToolError` shape every CLI command result uses. */
export function toToolError(value: unknown): ToolError {
  const domain = value instanceof DomainError ? value : asDomainError(value);
  if (
    !(value instanceof Error) &&
    value &&
    typeof value === "object" &&
    "code" in value &&
    "message" in value &&
    "retryable" in value
  ) {
    const item = value as ToolError;
    return {
      code: item.code,
      message: item.message,
      retryable: item.retryable,
      remediation: item.remediation,
      retryAfterMs: item.retryAfterMs,
      submissionState: item.submissionState,
      partialResponse: item.partialResponse
    };
  }
  return domain.toResult("unused").error;
}

/** Shapes a registry entry into the public `agent list` view, including the derived readiness
 * status (§30.4's assignment-status vocabulary, minus the workspace-only "approval-required"/
 * "unresolved" states that don't apply to a bare registry entry). */
export function publicAgent(
  agent: BrowserAgentDefinition,
  allowedCapabilityClasses: readonly string[] = ["knowledge-only"]
): AgentView {
  return {
    alias: agent.alias,
    name: agent.displayName,
    kind: agent.kind,
    description: agent.description,
    usageHint: agent.usageHint,
    capabilityClass: agent.capabilityClass,
    status: !agent.enabled
      ? "disabled"
      : agent.verification.status !== "verified"
        ? "unverified"
        : deriveBindingFingerprint(agent) !== agent.verification.bindingFingerprint
          ? "binding-mismatch"
          : !SUPPORTED_BROWSER_ADAPTER_IDS.has(agent.verification.adapterId)
            ? "unsupported-entrypoint"
            : !allowedCapabilityClasses.includes(agent.capabilityClass)
              ? "policy-blocked"
              : "ready",
    lastValidatedAt: agent.verification.validatedAt
  };
}

export type ApprovalDetail = {
  alias: string;
  displayName?: string;
  capabilityClass?: string;
  verificationStatus: string;
  bindingMatches: boolean;
};

/** §10.3: the exact lines `workspace approve` must display before asking for confirmation --
 * normalized workspace location, every requested alias with its local display name and
 * capability class, verification state, binding-fingerprint match, and the GitHub Copilot
 * context warning. */
export function approvalSummaryLines(workspaceRoot: string, details: ApprovalDetail[]): string[] {
  return [
    `Workspace: ${workspaceRoot}`,
    ...details.map(
      (item) =>
        `${item.alias}: ${item.displayName ?? "unresolved"}, ${item.capabilityClass ?? "unknown"}, verification=${item.verificationStatus}, binding=${item.bindingMatches ? "match" : "mismatch"}`
    ),
    "Warning: Microsoft 365 responses will enter GitHub Copilot context."
  ];
}
