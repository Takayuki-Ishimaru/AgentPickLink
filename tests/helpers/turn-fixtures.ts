import type { TurnSnapshot } from "../../src/transports/browser/turn-correlation.js";

/** Explicit DOM-anchor fixture for driver-only tests. Real-DOM tests exercise anchor discovery. */
export function turnFixture(userCount: number, replyStarted = true): TurnSnapshot {
  return {
    documentId: "fixture-document",
    conversationId: "fixture-conversation",
    ...(userCount === 0 ? { emptyVerified: true } : {}),
    messages: Array.from({ length: userCount }, (_, index) => [
      { key: `user-${index}`, role: "user" as const, stable: true },
      ...(index < userCount - 1 || replyStarted
        ? [{ key: `assistant-${index}`, role: "assistant" as const, stable: true }]
        : [])
    ]).flat()
  };
}
