import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAttestationJSON } from "../../src/services/extension-attestation.js";

const getMock = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ get: getMock }));
const url = "https://api.github.com/repos/Takayuki-Ishimaru/AgentPickLink/attestations/sha256:abc";
beforeEach(() => {
  getMock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function fixture() {
  const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const response = Object.assign(new EventEmitter(), { statusCode: 200, destroy: vi.fn() });
  const controller = new AbortController();
  getMock.mockImplementation((_url, _options, callback) => {
    queueMicrotask(() => callback(response));
    return request;
  });
  const promise = fetchAttestationJSON(url, controller.signal);
  return { request, response, controller, promise };
}

describe("attestation API transport boundary", () => {
  it("reads bounded JSON and detaches the cancellation listener after success", async () => {
    const f = fixture();
    await Promise.resolve();
    f.response.emit("data", Buffer.from('{"attestations":[]}'));
    f.response.emit("end");
    f.response.emit("close");
    await expect(f.promise).resolves.toEqual({ attestations: [] });
    expect(getEventListeners(f.controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a response closed before end", async () => {
    const f = fixture();
    const failure = expect(f.promise).rejects.toThrow("truncated");
    await Promise.resolve();
    f.response.emit("data", Buffer.from("{"));
    f.response.emit("close");
    await failure;
    expect(f.request.destroy).toHaveBeenCalled();
  });
  it("destroys both streams on oversize input and ignores later chunks and completion", async () => {
    const f = fixture();
    const failure = expect(f.promise).rejects.toThrow("size");
    await Promise.resolve();
    f.response.emit("data", Buffer.alloc(4 * 1024 * 1024 + 1));
    f.response.emit("data", Buffer.from('{"attestations":[]}'));
    f.response.emit("end");
    await failure;
    expect(f.response.destroy).toHaveBeenCalledTimes(1);
    expect(f.request.destroy).toHaveBeenCalledTimes(1);
    expect(getEventListeners(f.controller.signal, "abort")).toHaveLength(0);
  });
  it.each([302, 403, 404, 500])("refuses HTTP %s without redirects or fallback", async (status) => {
    const f = fixture();
    f.response.statusCode = status;
    await expect(f.promise).rejects.toThrow("http");
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(f.response.destroy).toHaveBeenCalled();
  });
  it("enforces a deadline even when called outside the complete verifier", async () => {
    const f = fixture();
    const failure = expect(f.promise).rejects.toThrow("http-timeout");
    await vi.advanceTimersByTimeAsync(10_001);
    await failure;
    expect(f.request.destroy).toHaveBeenCalled();
    expect(getEventListeners(f.controller.signal, "abort")).toHaveLength(0);
  });
  it("aborts a hanging body immediately", async () => {
    const f = fixture();
    const failure = expect(f.promise).rejects.toThrow("aborted");
    await Promise.resolve();
    f.controller.abort();
    await failure;
    expect(f.response.destroy).toHaveBeenCalled();
  });
});
