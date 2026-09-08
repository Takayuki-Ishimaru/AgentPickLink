import { describe, expect, it, vi } from "vitest";
import { LazyBrokerPort } from "../../src/frontend/lazy-broker-port.js";
import type { FrontendBrokerPort } from "../../src/frontend/broker-port.js";
import { DomainError } from "../../src/domain/errors.js";

describe("LazyBrokerPort", () => {
  it("does not dispatch or start a factory after the frontend closes", async () => {
    const factory = vi.fn();
    const port = new LazyBrokerPort(factory);
    const pending = port.list("/repo", "first");
    port.close();
    await expect(pending).resolves.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    expect(factory).not.toHaveBeenCalled();

    const list = vi.fn(async () => ({ ok: true }));
    const connected = new LazyBrokerPort(async () => ({ list }) as unknown as FrontendBrokerPort);
    await connected.list("/repo", "connected");
    const afterConnect = connected.list("/repo", "closing");
    connected.close();
    await expect(afterConnect).resolves.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("coalesces reconnects after broker shutdown without replaying an in-flight ask", async () => {
    let live = true;
    const oldClose = vi.fn();
    const oldAsk = vi.fn(async () => {
      live = false;
      return { code: "BROKER_UNAVAILABLE", message: "closed", retryable: true };
    });
    const fresh = { list: vi.fn(async () => ({ ok: true })), isConnected: () => true };
    const factory = vi
      .fn()
      .mockResolvedValueOnce({ ask: oldAsk, close: oldClose, isConnected: () => live })
      .mockResolvedValueOnce(fresh);
    const port = new LazyBrokerPort(factory);
    await expect(
      port.ask("/repo", { agent: "requirements", message: "hello" }, "ask")
    ).resolves.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    expect(factory).toHaveBeenCalledTimes(1);
    await Promise.all([port.list("/repo", "list1"), port.list("/repo", "list2")]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(oldAsk).toHaveBeenCalledTimes(1);
    expect(oldClose).toHaveBeenCalledTimes(1);
    expect(fresh.list).toHaveBeenCalledTimes(2);
  });

  it("closes a connection that arrives after stdin shutdown without dispatching its request", async () => {
    let resolve!: (port: FrontendBrokerPort) => void;
    const factory = vi.fn(
      () =>
        new Promise<FrontendBrokerPort>((done) => {
          resolve = done;
        })
    );
    const port = new LazyBrokerPort(factory);
    const pending = port.list("/repo", "list");
    await Promise.resolve();
    port.close();
    const close = vi.fn();
    const list = vi.fn();
    resolve({ close, list } as unknown as FrontendBrokerPort);
    await expect(pending).resolves.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(port.isConnected()).toBe(false);
    await port.list("/repo", "later");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("connects on the first tool call and reuses that connection for later calls", async () => {
    const backing: FrontendBrokerPort = {
      list: async (_root, requestId) => ({
        ok: true,
        requestId,
        workspace: { configured: true, approvalStatus: "approved" },
        agents: []
      })
    };
    const factory = vi.fn().mockResolvedValue(backing);
    const port = new LazyBrokerPort(factory);

    expect(factory).not.toHaveBeenCalled();
    const first = await port.list("/repo", "req-1");
    const second = await port.list("/repo", "req-2");

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ ok: true, requestId: "req-1" });
    expect(second).toMatchObject({ ok: true, requestId: "req-2" });
  });

  it("converts a factory failure into a structured, retryable BROKER_UNAVAILABLE result instead of throwing", async () => {
    const port = new LazyBrokerPort(() => Promise.reject(new Error("spawn failed")));
    const result = await port.list("/repo", "req-1");
    // A non-DomainError factory failure is normalized by asDomainError (INTERNAL_ERROR, message
    // withheld by design) before this wrapper maps it onto the broker-unavailable envelope --
    // only the structured shape is guaranteed here, not the original error text.
    expect(result).toMatchObject({ code: "BROKER_UNAVAILABLE", retryable: true });
    expect(typeof (result as { message: string }).message).toBe("string");
  });

  it("preserves a specific broker DomainError code (e.g. BROKER_START_FAILED) surfaced by the factory", async () => {
    const port = new LazyBrokerPort(() =>
      Promise.reject(new DomainError("BROKER_START_FAILED", "The broker did not start.", true))
    );
    const result = await port.ask("/repo", { agent: "requirements", message: "hi" }, "req-2");
    expect(result).toMatchObject({ code: "BROKER_START_FAILED", retryable: true });
  });

  it("forwards onProgress through to the backing port's ask() unchanged", async () => {
    const askSpy = vi.fn(async (_root, input, requestId) => ({
      ok: true,
      requestId,
      conversationHandle: "conv_1",
      agent: input.agent,
      text: "",
      citations: [],
      attachments: [],
      elapsedMs: 0
    }));
    const backing: FrontendBrokerPort = { ask: askSpy };
    const port = new LazyBrokerPort(async () => backing);
    const onProgress = vi.fn();

    await port.ask("/repo", { agent: "requirements", message: "hi" }, "req-1", undefined, onProgress);

    expect(askSpy).toHaveBeenCalledWith(
      "/repo",
      { agent: "requirements", message: "hi" },
      "req-1",
      undefined,
      onProgress
    );
  });

  it("retries the factory on a later call after a failure, so recovery does not require a new port instance", async () => {
    const backing: FrontendBrokerPort = {
      session: async (_root, input, requestId) => ({
        ok: true,
        requestId,
        action: input.action,
        conversations: []
      })
    };
    const factory = vi.fn().mockRejectedValueOnce(new Error("not ready")).mockResolvedValueOnce(backing);
    const port = new LazyBrokerPort(factory);

    const failed = await port.session("/repo", { action: "list" }, "req-1");
    expect(failed).toMatchObject({ code: "BROKER_UNAVAILABLE" });

    const recovered = await port.session("/repo", { action: "list" }, "req-2");
    expect(recovered).toMatchObject({ ok: true, action: "list" });
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
