import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
const script = await readFile(new URL("../../media/setup-browser.js", import.meta.url), "utf8");
async function fixture(post: () => Promise<unknown>) {
  const notice = { textContent: "" };
  const fetch = vi.fn((url: string) =>
    url === "/events"
      ? Promise.resolve({
          ok: true,
          body: { getReader: () => ({ read: () => new Promise(() => undefined) }) }
        })
      : post()
  );
  const window = { aplSession: "secret-token" } as unknown as {
    aplSession?: string;
    aplBrowser: {
      postMessage: (message: unknown) => Promise<void>;
      onMessage: (fn: (message: unknown) => void) => void;
    };
  };
  vm.runInNewContext(script, { window, document: { getElementById: () => notice }, fetch, TextDecoder });
  const listener = vi.fn();
  window.aplBrowser.onMessage(listener);
  return { window, notice, fetch, listener };
}
it.each([403, 409, 410, 500, 502])(
  "shows actionable HTTP %s feedback without exposing the session token",
  async (status) => {
    const f = await fixture(async () => ({ ok: false, status }));
    await f.window.aplBrowser.postMessage({ type: "save" });
    expect(f.notice.textContent).toContain(String(status));
    expect(f.notice.textContent).not.toContain("secret-token");
    expect(f.window.aplSession).toBeUndefined();
    expect(f.listener).toHaveBeenLastCalledWith({
      type: "transport",
      pending: false,
      expired: status === 403 || status === 410
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  }
);
it("marks a network failure as unknown and does not resend", async () => {
  const f = await fixture(async () => {
    throw new Error("secret-token network error");
  });
  await f.window.aplBrowser.postMessage({ type: "save" });
  expect(f.notice.textContent).toContain("Network disconnected; result unknown");
  expect(f.notice.textContent).not.toContain("secret-token");
  expect(f.fetch).toHaveBeenCalledTimes(2);
});
it("blocks duplicate submission while pending, permits cancellation, and clears pending on success", async () => {
  let resolve!: (value: unknown) => void;
  const f = await fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  const request = f.window.aplBrowser.postMessage({ type: "setup" });
  await f.window.aplBrowser.postMessage({ type: "setup" });
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.listener).toHaveBeenLastCalledWith({ type: "transport", pending: true, expired: false });
  resolve({ ok: true, status: 204 });
  await request;
  expect(f.listener).toHaveBeenLastCalledWith({ type: "transport", pending: false, expired: false });
});
it("does not submit again after a 403", async () => {
  const f = await fixture(async () => ({ ok: false, status: 403 }));
  await f.window.aplBrowser.postMessage({ type: "save" });
  await f.window.aplBrowser.postMessage({ type: "save" });
  expect(f.fetch).toHaveBeenCalledTimes(2);
});
