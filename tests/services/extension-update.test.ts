import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadExtensionRelease,
  newestExtensionRelease,
  DOWNLOAD_TIMEOUT_MS,
  MAX_VSIX_BYTES,
  type ExtensionRelease
} from "../../src/services/extension-update.js";

const getMock = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ get: getMock }));
const bytes = Buffer.from("verified vsix bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const base = "https://github.com/Takayuki-Ishimaru/AgentPickLink/releases/download/";
const release = (tag: string, asset: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  assets: [
    {
      name: `agent-pick-link-${tag.replace(/^v/, "")}.vsix`,
      state: "uploaded",
      size: bytes.length,
      digest: `sha256:${digest}`,
      ...asset
    }
  ]
});
const selected = (): ExtensionRelease => newestExtensionRelease([release("v1.0.0")], "0.1.0")!;

type Reply = {
  status?: number;
  location?: string;
  chunks?: Buffer[];
  requestError?: boolean;
  responseError?: boolean;
  aborted?: boolean;
  close?: boolean;
  stall?: boolean;
};
const requests: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }> = [];
const responses: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }> = [];
function respond(...replies: Reply[]) {
  getMock.mockImplementation((_url, _options, callback) => {
    const reply = replies.shift() ?? {};
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    request.destroy.mockImplementation(() => request.emit("close"));
    requests.push(request);
    queueMicrotask(() => {
      if (reply.requestError) {
        request.emit("error", new Error("offline"));
        return;
      }
      if (reply.stall) return;
      const response = Object.assign(new EventEmitter(), {
        statusCode: reply.status ?? 200,
        headers: { location: reply.location },
        resume: vi.fn(),
        destroy: vi.fn()
      });
      response.destroy.mockImplementation(() => response.emit("close"));
      responses.push(response);
      callback(response);
      if (reply.responseError) response.emit("error", new Error("body error"));
      else if (reply.aborted) response.emit("aborted");
      else if (reply.close) response.emit("close");
      else {
        for (const chunk of reply.chunks ?? [bytes]) response.emit("data", chunk);
        response.emit("end");
        response.emit("close");
      }
      request.emit("close");
    });
    return request;
  });
}
const download = (target = selected(), signal = new AbortController().signal) =>
  downloadExtensionRelease(target, signal);

beforeEach(() => {
  getMock.mockReset();
  requests.length = 0;
  responses.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("installable GitHub releases", () => {
  it("chooses the newest published installable version, including betas, without downgrading", () => {
    expect(
      newestExtensionRelease(
        [
          release("v1.0.0"),
          release("v2.0.0-beta.1"),
          { ...release("v9.0.0"), draft: true },
          release("v3.0.0", { digest: null })
        ],
        "0.1.0"
      )?.tag
    ).toBe("v2.0.0-beta.1");
    expect(newestExtensionRelease([release("v2.0.0-beta.1"), release("v2.0.0")], "0.1.0")?.tag).toBe(
      "v2.0.0"
    );
    expect(newestExtensionRelease([release("v1.0.0")], "1.0.0")).toBeUndefined();
  });
  it.each([
    null,
    {},
    [null],
    [release("invalid")],
    [release("1.0.0-rc/1")],
    [{ ...release("1.0.0"), draft: undefined }]
  ])("rejects malformed releases %j", (value) => {
    expect(newestExtensionRelease(value, "0.1.0")).toBeUndefined();
  });
  it("rejects an invalid installed version", () => {
    expect(newestExtensionRelease([release("1.0.0")], "bad")).toBeUndefined();
  });
  it.each([
    { name: "other.vsix" },
    { state: "new" },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { size: "42" },
    { size: MAX_VSIX_BYTES + 1 },
    { digest: "sha256:bad" },
    { digest: `sha512:${digest}` }
  ])("rejects unusable VSIX assets %j", (asset) => {
    expect(newestExtensionRelease([release("1.0.0", asset)], "0.1.0")).toBeUndefined();
  });
  it("rebuilds the project URL, ignores supplied URLs, and normalizes the digest", () => {
    expect(
      newestExtensionRelease(
        [
          release("v1.0.0", {
            browser_download_url: "https://evil.test/evil.vsix",
            digest: `sha256:${digest.toUpperCase()}`
          })
        ],
        "0.1.0"
      )
    ).toEqual({
      tag: "v1.0.0",
      name: "agent-pick-link-1.0.0.vsix",
      url: `${base}v1.0.0/agent-pick-link-1.0.0.vsix`,
      sha256: digest,
      size: bytes.length
    });
  });
  it("bounds release traversal to 100 entries", () => {
    const feed = Array.from({ length: 100 }, (_, i) => release(`0.5.${i}`));
    feed.push(release("9.0.0"));
    expect(newestExtensionRelease(feed, "0.1.0")?.tag).toBe("0.5.99");
  });
});

describe("verified VSIX download", () => {
  it("returns exact verified bytes and clears its deadline without credentials", async () => {
    respond({ chunks: [bytes.subarray(0, 4), bytes.subarray(4)] });
    expect(await download()).toEqual(bytes);
    expect(vi.getTimerCount()).toBe(0);
    expect(getMock.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  });
  it("follows relative redirects and GitHub signed CDN URLs", async () => {
    respond(
      { status: 302, location: "next" },
      { status: 307, location: "https://release-assets.githubusercontent.com/file?signature=value" },
      {}
    );
    expect(await download()).toEqual(bytes);
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(getMock.mock.calls[1][0].href).toBe(`${base}v1.0.0/next`);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    "http://github.com/file",
    "https://evil.test/file",
    "https://github.com.evil.test/file",
    "https://user:pass@github.com/file",
    "https://github.com:8443/file",
    "https://github.com/file#hash",
    "file:///tmp/update.vsix"
  ])("rejects unsafe redirect %s before contacting it", async (location) => {
    respond({ status: 302, location });
    await expect(download()).rejects.toThrow();
    expect(getMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects unsafe initial URLs without opening a request", async () => {
    await expect(download({ ...selected(), url: "https://evil.test/file" })).rejects.toThrow();
    expect(getMock).not.toHaveBeenCalled();
  });
  it("allows five redirects but rejects a sixth", async () => {
    const redirect = { status: 302, location: "/next" };
    respond(...Array.from({ length: 5 }, () => redirect), {});
    expect(await download()).toEqual(bytes);
    getMock.mockReset();
    respond(...Array.from({ length: 6 }, () => redirect));
    await expect(download()).rejects.toThrow("redirect");
    expect(getMock).toHaveBeenCalledTimes(6);
  });
  it.each([
    { status: 403 },
    { status: 302 },
    { requestError: true },
    { responseError: true },
    { aborted: true },
    { close: true },
    { chunks: [bytes.subarray(1)] },
    { chunks: [Buffer.concat([bytes, Buffer.from("extra")])] }
  ])("rejects failed or incomplete downloads %j", async (reply) => {
    respond(reply);
    await expect(download()).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects tampered bytes with a correct size", async () => {
    respond({ chunks: [Buffer.alloc(bytes.length)] });
    await expect(download()).rejects.toThrow("digest");
  });
  it("rejects excessive declared sizes before requesting a body", async () => {
    await expect(download({ ...selected(), size: MAX_VSIX_BYTES + 1 })).rejects.toThrow("metadata");
    expect(getMock).not.toHaveBeenCalled();
  });
  it("bounds a stalled download by an overall deadline and destroys the request", async () => {
    respond({ stall: true });
    const result = expect(download()).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);
    await result;
    expect(requests[0].destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start requests for an already cancelled operation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(download(selected(), controller.signal)).rejects.toThrow("aborted");
    expect(getMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels one concurrent operation independently while the other succeeds", async () => {
    respond({ stall: true }, {});
    const controller = new AbortController();
    const cancelled = expect(download(selected(), controller.signal)).rejects.toThrow("aborted");
    const other = download();
    controller.abort();
    await cancelled;
    expect(await other).toEqual(bytes);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(requests[0].destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
