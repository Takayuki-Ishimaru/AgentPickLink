import type { CapabilityClass } from "./agent.js";
export const DEFAULT_LIMITS = {
  maxPerWorkspace: 6,
  maxTotal: 10,
  idleExpirationMinutes: 30,
  perConversationQueueLimit: 3,
  maxConcurrentTotal: 4,
  maxPerMinutePerWorkspace: 30
} as const;
export const isCapabilityAllowed = (value: CapabilityClass, allowed: readonly CapabilityClass[]): boolean =>
  allowed.includes(value);
