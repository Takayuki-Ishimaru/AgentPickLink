import { describe, expect, it } from "vitest";
import { ConversationService } from "../../src/services/conversation-service.js";
describe("conversation ownership", () => {
  const owner = { workspaceKey: "workspace-a", agentAlias: "knowledge", bindingFingerprint: "sha256:a" };
  const limits = { maxPerWorkspace: 1, maxTotal: 1, idleExpirationMinutes: 30, perConversationQueueLimit: 1 };

  it("releases failed/expired records and bounds expiry history across many workspaces", () => {
    const service = new ConversationService("broker_a", limits);
    let first = "";
    let latest = "";
    for (let i = 0; i < 1000; i++) {
      const conversation = service.create({ ...owner, workspaceKey: `workspace-${i}` });
      first ||= conversation.handle;
      latest = conversation.handle;
      conversation.state = i % 2 ? "failed" : "expired";
      expect(service.takeExpiredForCleanup()).toEqual([conversation]);
      expect(service.takeExpiredForCleanup()).toEqual([]);
    }
    expect(service.activeCount()).toBe(0);
    expect(() => service.get(first)).toThrow(/unknown/i);
    expect(() => service.get(latest)).toThrow(/expired/i);
  });

  it("does not evict or expire a ready handle with a queued invocation", async () => {
    const service = new ConversationService("broker_a", limits);
    const conversation = service.ready(service.create(owner).handle);
    const invocation = service.runExclusive(conversation.handle, async () => {
      conversation.lastUsedAt = new Date(0).toISOString();
      expect(service.takeExpiredForCleanup()).toEqual([]);
    });
    // runExclusive has reserved its queue but has not reached the busy state yet.
    expect(() => service.create(owner)).toThrow(/limit/i);
    await invocation;
    expect(service.get(conversation.handle).state).toBe("ready");
  });

  it("defers cleanup of an invalidated active invocation until it finishes", async () => {
    const service = new ConversationService("broker_a", limits);
    const conversation = service.ready(service.create(owner).handle);
    await service.runExclusive(conversation.handle, async () => {
      service.failAll();
      expect(service.takeExpiredForCleanup()).toEqual([]);
    });
    expect(service.takeExpiredForCleanup()).toEqual([conversation]);
  });

  it("does not disclose a workspace conversation to another workspace", () => {
    const service = new ConversationService("broker_a", {
      maxPerWorkspace: 6,
      maxTotal: 10,
      idleExpirationMinutes: 30,
      perConversationQueueLimit: 3
    });
    const c = service.create({
      workspaceKey: "workspace-a",
      agentAlias: "knowledge",
      bindingFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    service.ready(c.handle);
    expect(service.list("workspace-b")).toEqual([]);
    expect(() => service.close(c.handle, "workspace-b")).toThrow(/another workspace/i);
  });
  it("serializes a bounded per-conversation queue", async () => {
    const service = new ConversationService("broker_a", {
      maxPerWorkspace: 6,
      maxTotal: 10,
      idleExpirationMinutes: 30,
      perConversationQueueLimit: 1
    });
    const c = service.create({
      workspaceKey: "workspace-a",
      agentAlias: "knowledge",
      bindingFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    service.ready(c.handle);
    const trace: string[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = service.runExclusive(c.handle, async () => {
      trace.push("first");
      await gate;
      trace.push("first-done");
    });
    const second = service.runExclusive(c.handle, async () => {
      trace.push("second");
    });
    await expect(service.runExclusive(c.handle, async () => undefined)).rejects.toMatchObject({
      code: "CONCURRENT_REQUEST"
    });
    finish();
    await Promise.all([first, second]);
    expect(trace).toEqual(["first", "first-done", "second"]);
  });
  it("expires idle handles and LRU-evicts a ready conversation at the limit", () => {
    const owner = {
      workspaceKey: "workspace-a",
      agentAlias: "knowledge",
      bindingFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    };
    const service = new ConversationService("broker_a", {
      maxPerWorkspace: 1,
      maxTotal: 1,
      idleExpirationMinutes: 30,
      perConversationQueueLimit: 1
    });
    const first = service.ready(service.create(owner).handle);
    first.lastUsedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    expect(() => service.get(first.handle)).toThrow(/expired/i);
    expect(service.takeExpiredForCleanup()).toContain(first);
    const second = service.ready(service.create(owner).handle);
    const third = service.create(owner);
    expect(() => service.get(second.handle)).toThrow(/expired/i);
    expect(third.state).toBe("creating");
  });
  // A one-shot conversation kept open to be read was just handed to a caller who may read it at once
  // to learn whether a message went out: it is evicted by its turn, least recently used first, not
  // ahead of the caller's other sessions (independent review of the 2026-10-10 fixes).
  it("evicts a conversation kept open for reading only by its turn, least recently used first", () => {
    const owner = {
      workspaceKey: "workspace-a",
      agentAlias: "knowledge",
      bindingFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    };
    const service = new ConversationService("broker_a", {
      maxPerWorkspace: 2,
      maxTotal: 10,
      idleExpirationMinutes: 30,
      perConversationQueueLimit: 1
    });
    const session = service.ready(service.create(owner).handle);
    session.lastUsedAt = new Date(Date.now() - 60_000).toISOString();
    const kept = service.ready(service.create(owner).handle);
    kept.closeAfterRead = true;
    service.create(owner);
    expect(() => service.get(session.handle)).toThrow(/expired/i);
    expect(service.get(kept.handle)).toBe(kept);
  });
  it("rejects handles created by another broker instance", () => {
    const first = new ConversationService("broker_a", {
      maxPerWorkspace: 6,
      maxTotal: 10,
      idleExpirationMinutes: 30,
      perConversationQueueLimit: 1
    });
    const conversation = first.ready(
      first.create({
        workspaceKey: "workspace-a",
        agentAlias: "knowledge",
        bindingFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }).handle
    );
    const restarted = new ConversationService("broker_b", {
      maxPerWorkspace: 6,
      maxTotal: 10,
      idleExpirationMinutes: 30,
      perConversationQueueLimit: 1
    });
    expect(() => restarted.get(conversation.handle)).toThrow(/unknown/i);
  });
});
