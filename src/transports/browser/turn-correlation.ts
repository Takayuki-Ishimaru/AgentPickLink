export interface MessageAnchor {
  key: string;
  role: "user" | "assistant";
  /** Only a message-owned ID establishes identity; a DOM node can be recycled for history. */
  stable?: boolean;
}
export interface TurnSnapshot {
  documentId: string;
  conversationId?: string;
  /** Set only after an explicit new-conversation operation changed its known conversation ID. */
  emptyVerified?: boolean;
  messages: MessageAnchor[];
}
export type TurnCorrelation = {
  confirmed: boolean;
  reason: string;
  userKey?: string;
  responseKey?: string;
};

function validSnapshot(snapshot: TurnSnapshot): boolean {
  return !!(
    snapshot.documentId &&
    Array.isArray(snapshot.messages) &&
    snapshot.messages.every(
      (item) =>
        item &&
        typeof item.key === "string" &&
        item.key &&
        (item.role === "user" || item.role === "assistant")
    ) &&
    new Set(snapshot.messages.map((item) => item.key)).size === snapshot.messages.length
  );
}

/** Refuse a send whose baseline cannot identify any future appended question. */
export function submissionBaselineProblem(before: TurnSnapshot | undefined): string | undefined {
  if (!before) return "missing-baseline";
  if (!validSnapshot(before)) return "ambiguous-anchors";
  if (!before.messages.some((item) => item.role === "user"))
    return before.emptyVerified && before.conversationId ? undefined : "empty-baseline-unverified";
  return before.messages.at(-1)?.stable === true ? undefined : "unstable-message-identity";
}

/** A retained stable tail proves that no new question arrived, even when history virtualizes.
 * Self-contained so the same check can run inside the page's trusted press gate. */
export function submissionContinuityProblem(
  before: TurnSnapshot | undefined,
  current: TurnSnapshot | undefined
): string | undefined {
  const valid = (snapshot: TurnSnapshot): boolean =>
    !!snapshot.documentId &&
    Array.isArray(snapshot.messages) &&
    snapshot.messages.every(
      (item) =>
        item &&
        typeof item.key === "string" &&
        !!item.key &&
        (item.role === "user" || item.role === "assistant")
    ) &&
    new Set(snapshot.messages.map((item) => item.key)).size === snapshot.messages.length;
  if (!before || !current) return "missing-baseline";
  if (!valid(before) || !valid(current)) return "ambiguous-anchors";
  if (
    before.documentId !== current.documentId ||
    (before.conversationId && before.conversationId !== current.conversationId)
  )
    return "document-changed";
  if (!before.messages.some((item) => item.role === "user")) {
    if (!before.emptyVerified || !before.conversationId) return "empty-baseline-unverified";
    return current.messages.some((item) => item.role === "user") ? "new-user-before-press" : undefined;
  }
  const tail = before.messages.at(-1)!;
  if (tail.stable !== true) return "unstable-message-identity";
  const index = current.messages.findIndex(
    (item) => item.key === tail.key && item.role === tail.role && item.stable === true
  );
  if (index < 0) return "baseline-tail-missing";
  const after = current.messages.slice(index + 1);
  const previous = new Set(before.messages.map((item) => item.key));
  if (after.some((item) => previous.has(item.key))) return "baseline-reordered";
  return after.some((item) => item.role === "user") ? "new-user-before-press" : undefined;
}

/** Counts alone cannot distinguish appended questions from prepended history. Resolve a new
 * user after the pre-send tail, or retain the already-confirmed user while old nodes virtualize. */
export function correlateTurn(
  before: TurnSnapshot | undefined,
  current: TurnSnapshot | undefined,
  confirmedUserKey?: string
): TurnCorrelation {
  const unknown = (reason: string): TurnCorrelation => ({ confirmed: false, reason });
  if (!before || !current) return unknown("missing-baseline");
  if (!validSnapshot(before) || !validSnapshot(current)) return unknown("ambiguous-anchors");
  if (before.documentId !== current.documentId) return unknown("document-changed");
  if (before.conversationId && before.conversationId !== current.conversationId)
    return unknown("document-changed");
  const messages = current.messages;
  const latestUser = messages.filter((item) => item.role === "user").at(-1);
  let user: MessageAnchor | undefined;
  if (confirmedUserKey) {
    user = latestUser?.key === confirmedUserKey ? latestUser : undefined;
    if (!user) return unknown("confirmed-user-missing");
  } else if (!before.messages.some((item) => item.role === "user")) {
    if (!before.emptyVerified || !before.conversationId) return unknown("empty-baseline-unverified");
    const users = messages.filter((item) => item.role === "user");
    if (users.length !== 1 || before.messages.some((item) => item.key === users[0]?.key))
      return unknown("empty-baseline-ambiguous");
    user = users[0];
  } else {
    const tail = before.messages.at(-1)!;
    if (tail.stable !== true) return unknown("unstable-message-identity");
    const index = messages.findIndex((item) => item.key === tail.key && item.role === tail.role);
    if (index === -1) return unknown("baseline-tail-missing");
    const after = messages.slice(index + 1);
    const previous = new Set(before.messages.map((item) => item.key));
    if (after.some((item) => previous.has(item.key))) return unknown("baseline-reordered");
    const users = after.filter((item) => item.role === "user");
    if (users.length !== 1 || users[0] !== latestUser) return unknown("no-unique-appended-user");
    user = users[0];
  }
  if (!user) return unknown("no-unique-appended-user");
  if (user.stable !== true) return unknown("unstable-message-identity");
  const replies = messages.slice(messages.indexOf(user) + 1);
  const responseKey =
    replies.length === 1 && replies[0]?.role === "assistant" && replies[0].stable === true
      ? replies[0].key
      : undefined;
  return {
    confirmed: true,
    reason:
      replies.length === 1 && replies[0]?.role === "assistant" && replies[0].stable !== true
        ? "unstable-message-identity"
        : confirmedUserKey
          ? "confirmed-user-anchor"
          : "appended-after-tail",
    userKey: user.key,
    ...(responseKey ? { responseKey } : {})
  };
}
