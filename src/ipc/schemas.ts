import { z } from "zod";
import { AliasSchema } from "../domain/agent.js";
import { DomainError } from "../domain/errors.js";
export const IpcEnvelopeSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    method: z.string().min(1).max(128),
    params: z.unknown()
  })
  .strict();
const WorkspaceSchema = z.object({ root: z.string().min(1) }).strict();
const ConversationHandleSchema = z.string().regex(/^conv_[A-Za-z0-9_-]+$/);
export const BrokerMethodSchemas = {
  "broker.health": z.object({}).strict(),
  "broker.shutdown": z.object({}).strict(),
  "browser.login": z.object({ timeoutMs: z.number().int().min(1_000).max(600_000).optional() }).strict(),
  /** Cancels the interactive sign-in currently running in the visible window, if any. */
  "browser.cancelLogin": z.object({}).strict(),
  "browser.authState": z.object({}).strict(),
  "browser.resetProfile": z.object({}).strict(),
  "agent.capture": z.object({ timeoutMs: z.number().int().min(1_000).max(300_000).optional() }).strict(),
  "agent.inspectUrl": z.object({ url: z.url() }).strict(),
  "agent.discover": z
    .object({
      timeoutMs: z.number().int().min(1_000).max(1_800_000).optional(),
      operationId: z.string().uuid().optional()
    })
    .strict(),
  "agent.cancelDiscovery": z.object({ operationId: z.string().uuid() }).strict(),
  "agent.validate": z.object({ agent: AliasSchema, sendTestMessage: z.boolean().optional() }).strict(),
  "workspace.list": WorkspaceSchema,
  "conversation.create": WorkspaceSchema.extend({ agent: AliasSchema }).strict(),
  "conversation.invoke": WorkspaceSchema.extend({
    agent: AliasSchema,
    message: z.string().min(1).max(12000),
    conversationHandle: ConversationHandleSchema.optional()
  }).strict(),
  "conversation.list": WorkspaceSchema,
  "conversation.close": WorkspaceSchema.extend({ conversationHandle: ConversationHandleSchema }).strict(),
  "conversation.closeAllForWorkspace": WorkspaceSchema
} as const;
export type BrokerMethod = keyof typeof BrokerMethodSchemas;
export function parseMethod(
  method: string,
  value: unknown
): { method: BrokerMethod; params: Record<string, unknown> } {
  if (!Object.prototype.hasOwnProperty.call(BrokerMethodSchemas, method))
    throw new DomainError("BROKER_PROTOCOL_ERROR", "Unknown broker method.");
  try {
    return {
      method: method as BrokerMethod,
      params: BrokerMethodSchemas[method as BrokerMethod].parse(value)
    };
  } catch {
    throw new DomainError("INVALID_ARGUMENT", "Broker method arguments are invalid.");
  }
}
export const HandshakeSchema = z
  .object({
    type: z.literal("hello"),
    authSecret: z.string().min(43).max(512),
    protocolMajor: z.number().int().nonnegative(),
    protocolMinor: z.number().int().nonnegative(),
    packageVersion: z.string().min(1),
    capabilities: z.array(z.string().min(1)).max(100).default([])
  })
  .strict();
