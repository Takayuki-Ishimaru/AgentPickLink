import { randomBytes } from "node:crypto";
import type { SubmissionState } from "./errors.js";
export type ConversationState = "creating" | "ready" | "busy" | "expired" | "failed";
/** Opaque, transport-issued conversation handle. The transport that creates a conversation
 * returns one of these; the broker stores it on the owning Conversation and passes it back to
 * that same transport unchanged on invoke/close. Only the issuing transport may interpret
 * `opaque` -- no other layer (broker, services, frontend) may inspect it. Defined here rather
 * than in src/transports/transport.ts so the domain layer has no upward dependency on
 * transports; transports/transport.ts imports this type instead. */
export type ConversationTransportHandle = { readonly transportId: string; readonly opaque: unknown };
export type Conversation = {
  handle: string;
  brokerInstanceId: string;
  workspaceKey: string;
  agentAlias: string;
  bindingFingerprint: string;
  state: ConversationState;
  transport?: ConversationTransportHandle;
  createdAt: string;
  lastUsedAt: string;
  lastSubmissionState?: SubmissionState;
};
export const newConversationHandle = (): string => `conv_${randomBytes(24).toString("base64url")}`;
