import type { Conversation } from "../domain/conversation.js";
import { newConversationHandle } from "../domain/conversation.js";
import { DomainError } from "../domain/errors.js";

export type ConversationLimits = {
  maxPerWorkspace: number;
  maxTotal: number;
  idleExpirationMinutes: number;
  perConversationQueueLimit: number;
};
export type ConversationOwner = Pick<Conversation, "workspaceKey" | "agentAlias" | "bindingFingerprint">;
const EXPIRED_HANDLE_LIMIT = 256;

export class ConversationService {
  private readonly items = new Map<string, Conversation>();
  private readonly queues = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  // Keep only a bounded set of recent handles for useful expiry errors, never their transport data.
  private readonly expiredHandles = new Set<string>();
  constructor(
    private readonly brokerInstanceId: string,
    private readonly limits: ConversationLimits
  ) {}

  create(owner: ConversationOwner): Conversation {
    this.expireIdle();
    this.evictIdleIfNeeded(owner.workspaceKey);
    const total = this.active().length;
    const scoped = this.active().filter((item) => item.workspaceKey === owner.workspaceKey).length;
    if (total >= this.limits.maxTotal || scoped >= this.limits.maxPerWorkspace)
      throw new DomainError("RATE_LIMITED", "The active conversation limit has been reached.", true, {
        retryAfterMs: 60_000
      });
    const now = new Date().toISOString();
    const conversation: Conversation = {
      handle: newConversationHandle(),
      brokerInstanceId: this.brokerInstanceId,
      ...owner,
      state: "creating",
      createdAt: now,
      lastUsedAt: now
    };
    this.items.set(conversation.handle, conversation);
    return conversation;
  }

  ready(handle: string): Conversation {
    const conversation = this.get(handle);
    conversation.state = "ready";
    conversation.lastUsedAt = new Date().toISOString();
    return conversation;
  }
  get(handle: string): Conversation {
    this.expireIdle();
    const conversation = this.items.get(handle);
    if (!conversation) {
      if (this.expiredHandles.has(handle))
        throw new DomainError("CONVERSATION_EXPIRED", "The conversation has expired or was invalidated.");
      throw new DomainError("CONVERSATION_NOT_FOUND", "The conversation handle is unknown.");
    }
    if (conversation.state === "expired" || conversation.state === "failed")
      throw new DomainError("CONVERSATION_EXPIRED", "The conversation has expired or was invalidated.");
    return conversation;
  }
  assertOwner(handle: string, owner: ConversationOwner): Conversation {
    const conversation = this.get(handle);
    if (
      conversation.brokerInstanceId !== this.brokerInstanceId ||
      conversation.workspaceKey !== owner.workspaceKey ||
      conversation.agentAlias !== owner.agentAlias ||
      conversation.bindingFingerprint !== owner.bindingFingerprint
    )
      throw new DomainError(
        "CONVERSATION_OWNERSHIP_MISMATCH",
        "This conversation does not belong to the requested workspace and agent."
      );
    return conversation;
  }
  list(workspaceKey: string): Conversation[] {
    this.expireIdle();
    return this.active().filter((item) => item.workspaceKey === workspaceKey);
  }
  close(handle: string, workspaceKey: string): Conversation {
    const conversation = this.get(handle);
    if (conversation.workspaceKey !== workspaceKey)
      throw new DomainError(
        "CONVERSATION_OWNERSHIP_MISMATCH",
        "This conversation belongs to another workspace."
      );
    conversation.state = "expired";
    return conversation;
  }
  /** Marks a conversation that can no longer be safely reused as failed. This is intentionally
   * separate from close(): callers may need to invalidate a handle after a transport failure,
   * before the cleanup sweep closes its opaque transport page. */
  fail(handle: string): Conversation | undefined {
    const conversation = this.items.get(handle);
    if (!conversation || conversation.state === "expired") return conversation;
    conversation.state = "failed";
    return conversation;
  }
  closeAll(workspaceKey: string): Conversation[] {
    const items = this.list(workspaceKey);
    items.forEach((item) => {
      item.state = "expired";
    });
    return items;
  }
  activeCount(): number {
    this.expireIdle();
    return this.active().length;
  }
  failAll(): void {
    for (const conversation of this.items.values())
      conversation.state = conversation.state === "busy" ? "failed" : "expired";
  }
  invalidateAll(): void {
    for (const conversation of this.items.values()) conversation.state = "expired";
  }
  takeExpiredForCleanup(): Conversation[] {
    this.expireIdle();
    const expired: Conversation[] = [];
    for (const [handle, conversation] of this.items) {
      if (conversation.state !== "expired" && conversation.state !== "failed") continue;
      // An invalidated invocation can still be unwinding; never close its page underneath it.
      if (this.queues.has(handle)) continue;
      expired.push(conversation);
      this.forget(handle);
    }
    return expired;
  }

  /** Returns expired records still waiting for their transport page to close. Unlike
   * `takeExpiredForCleanup()`, this keeps the records indexed until the transport confirms close,
   * so a later maintenance pass can retry a failed page close safely. */
  expiredForCleanup(): Conversation[] {
    this.expireIdle();
    return [...this.items.values()].filter(
      (conversation) =>
        (conversation.state === "expired" || conversation.state === "failed") &&
        !this.queues.has(conversation.handle)
    );
  }

  /** Whether a handle is still indexed and therefore still needs transport cleanup. */
  has(handle: string): boolean {
    return this.items.has(handle);
  }

  /** Removes a conversation whose transport has already been closed. The cleanup sweep normally
   * calls the transport before the caller forgets the item; one-shot asks use this after closing
   * their page inside the invocation mutex to avoid a second close attempt on the next sweep. */
  forget(handle: string): void {
    const conversation = this.items.get(handle);
    if (
      !conversation ||
      this.queues.has(handle) ||
      (conversation.state !== "expired" && conversation.state !== "failed")
    )
      return;
    this.items.delete(handle);
    this.expiredHandles.add(handle);
    if (this.expiredHandles.size > EXPIRED_HANDLE_LIMIT)
      this.expiredHandles.delete(this.expiredHandles.values().next().value!);
  }

  async runExclusive<T>(handle: string, action: () => Promise<T>): Promise<T> {
    const count = this.queues.get(handle) ?? 0;
    // One active request plus the configured number of queued requests.
    if (count >= this.limits.perConversationQueueLimit + 1)
      throw new DomainError("CONCURRENT_REQUEST", "The conversation request queue is full.", true);
    this.queues.set(handle, count + 1);
    const previous = this.tails.get(handle) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      handle,
      previous.then(() => tail)
    );
    let conversation: Conversation | undefined;
    try {
      await previous;
      conversation = this.get(handle);
      conversation.state = "busy";
      return await action();
    } finally {
      if (conversation?.state === "busy") {
        conversation.state = "ready";
        conversation.lastUsedAt = new Date().toISOString();
      }
      release();
      const remaining = Math.max(0, (this.queues.get(handle) ?? 1) - 1);
      if (remaining === 0) {
        this.queues.delete(handle);
        this.tails.delete(handle);
      } else this.queues.set(handle, remaining);
    }
  }

  private active(): Conversation[] {
    return [...this.items.values()].filter((item) => item.state !== "expired" && item.state !== "failed");
  }
  private expireIdle(): void {
    const cutoff = Date.now() - this.limits.idleExpirationMinutes * 60_000;
    for (const conversation of this.items.values())
      if (
        conversation.state === "ready" &&
        !this.queues.has(conversation.handle) &&
        new Date(conversation.lastUsedAt).getTime() < cutoff
      ) {
        conversation.state = "expired";
      }
  }
  private evictIdleIfNeeded(workspaceKey: string): void {
    const active = this.active();
    const overTotal = active.length >= this.limits.maxTotal;
    const scoped = active.filter((item) => item.workspaceKey === workspaceKey);
    const overScoped = scoped.length >= this.limits.maxPerWorkspace;
    if (!overTotal && !overScoped) return;
    const candidate = (overScoped ? scoped : active)
      .filter((item) => item.state === "ready" && !this.queues.has(item.handle))
      .sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt))[0];
    if (candidate) {
      candidate.state = "expired";
    }
  }
}
