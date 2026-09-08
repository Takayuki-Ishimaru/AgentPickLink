import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUpdateCheck, RELEASES_API, UPDATE_CHECK_DELAY_MS } from "../../src/extension/update-checker.js";
import { createRuntimeHarness, logText, type RuntimeHarness } from "./harness.js";
import { resetVscodeMock, vscodeMock } from "./vscode-mock.js";

const getMock = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ get: getMock }));
let harness: RuntimeHarness;
let disposable: { dispose(): void } | undefined;

beforeEach(async () => {
  resetVscodeMock();
  getMock.mockReset();
  harness = await createRuntimeHarness({ language: "ja" });
  Object.assign(harness.context, { globalState: { get: () => undefined, update: async () => undefined } });
  vi.useFakeTimers();
});
afterEach(async () => {
  disposable?.dispose();
  disposable = undefined;
  vi.useRealTimers();
  await harness.dispose();
});

function respond(statusCode: number, body: string) {
  getMock.mockImplementation((_url, _options, callback) => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    request.destroy.mockImplementation((error) => {
      request.emit("error", error);
      request.emit("close");
    });
    queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode, resume: vi.fn() });
      callback(response);
      response.emit("data", Buffer.from(body));
      response.emit("end");
      request.emit("close");
    });
    return request;
  });
}

describe("startup update check", () => {
  it("checks the public API after startup and presents a localized notification", async () => {
    respond(200, JSON.stringify([{ tag_name: "v0.1.1", draft: false }]));
    disposable = startUpdateCheck(harness.context as never, harness.runtime);
    expect(getMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(getMock).toHaveBeenCalledOnce();
    expect(getMock.mock.calls[0][0]).toBe(RELEASES_API);
    expect(getMock.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
    expect(vscodeMock.messages).toMatchObject([
      { message: "AgentPickLink v0.1.1 が公開されています（現在: 0.1.0）。" }
    ]);
  });

  it.each(["disabled", "disposed"])("does not contact GitHub when %s", async (mode) => {
    if (mode === "disabled") vscodeMock.configuration.set("agentpicklink.checkForUpdates", false);
    disposable = startUpdateCheck(harness.context as never, harness.runtime);
    if (mode === "disposed") disposable.dispose();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(getMock).not.toHaveBeenCalled();
  });

  it.each([
    [403, "rate limited"],
    [200, "not JSON"],
    [302, "redirect"]
  ])("quietly handles HTTP %s without showing a false update", async (status, body) => {
    respond(Number(status), String(body));
    disposable = startUpdateCheck(harness.context as never, harness.runtime);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(vscodeMock.messages).toHaveLength(0);
    expect(logText()).toContain("update-check: unavailable");
  });

  it("bounds stalled requests and cancels them on disposal", async () => {
    let signal: AbortSignal | undefined;
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    request.destroy.mockImplementation((error) => {
      request.emit("error", error);
      request.emit("close");
    });
    getMock.mockImplementation((_url, options) => {
      signal = options.signal;
      return request;
    });
    disposable = startUpdateCheck(harness.context as never, harness.runtime);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS + 8_000);
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(vscodeMock.messages).toHaveLength(0);
    disposable.dispose();
    expect(signal?.aborted).toBe(true);
  });
});
