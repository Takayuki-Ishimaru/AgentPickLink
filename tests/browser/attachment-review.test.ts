import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentSaver, sanitizeFilename } from "../../src/transports/browser/attachment-saver.js";
import type { AttachmentCandidate, PageLike } from "../../src/transports/browser/types.js";

const host = "tenant.sharepoint.com";
const body = Buffer.from("添付原本\nＡ①㎏\u0000\ufffd");
const candidates = (length: number): AttachmentCandidate[] =>
  Array.from({ length }, (_, i) => ({
    index: i + 1,
    name: `file-${i + 1}.txt`,
    url: `https://${host}/files/${i + 1}`
  }));
function fixture(delay = 0) {
  const requested: string[] = [];
  const page: PageLike = {
    url: () => "https://m365.example.test/chat",
    context: () => ({
      request: {
        get: async (url) => {
          requested.push(url);
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          return {
            ok: () => true,
            status: () => 200,
            headers: () => ({ "content-type": "text/plain" }),
            body: async () => body,
            url: () => url
          };
        }
      }
    })
  };
  return { page, requested };
}
const context = (requestId = "request") => ({ workspaceKey: "workspace", requestId });

describe("attachment review regressions", () => {
  it.each([0, 10, 12])("returns every discovered candidate at the count boundary %s", async (count) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-count-limit-"));
    try {
      const { page, requested } = fixture();
      const items = candidates(count);
      if (count > 10) {
        items[10] = { index: 11, name: "control.txt", downloadControlIndex: 0 };
        items[11] = { index: 12, name: "card.txt", fileCardIndex: 0 };
      }
      const result = await new AttachmentSaver({ enabled: true, directory, allowedHosts: [host] }).save(
        page,
        items,
        context()
      );
      expect(result).toHaveLength(count);
      expect(result.map((item) => item.index)).toEqual(items.map((item) => item.index));
      expect(result.slice(0, 10).every((item) => item.status === "saved")).toBe(true);
      expect(
        result
          .slice(10)
          .every(
            (item) =>
              item.status === "not-saved" &&
              item.errorCode === "attachment-count-limit" &&
              item.stage === "attachment-count-limit"
          )
      ).toBe(true);
      expect(requested).toHaveLength(Math.min(count, 10));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports overflow with disabled downloads, missing destinations and cancellation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-count-paths-"));
    try {
      const { page, requested } = fixture();
      const controller = new AbortController();
      controller.abort();
      for (const [saver, saveContext, expected] of [
        [new AttachmentSaver(), context("disabled"), "downloads-disabled"],
        [new AttachmentSaver({ enabled: true }), context("missing"), "downloads-disabled"],
        [
          new AttachmentSaver({ enabled: true, directory, allowedHosts: [host] }),
          { ...context("cancelled"), signal: controller.signal },
          "download-failed"
        ],
        [
          new AttachmentSaver({ enabled: true, directory }),
          { ...context("unavailable"), workspaceRoot: path.join(directory, "does-not-exist") },
          "download-failed"
        ]
      ] as const) {
        const result = await saver.save(page, candidates(12), saveContext);
        expect(result.map((item) => item.errorCode)).toEqual([
          ...Array(10).fill(expected),
          ...Array(2).fill("attachment-count-limit")
        ]);
      }
      expect(requested).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["日本".repeat(60) + ".txt", "😀".repeat(120) + ".txt", "日本".repeat(60)])(
    "saves long names and collisions within UTF-8 and UTF-16 limits: %s",
    async (name) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "apl-filename-bytes-"));
      try {
        const { page } = fixture();
        const input = candidates(2).map((item) => ({ ...item, name }));
        const results = await new AttachmentSaver({ enabled: true, directory, allowedHosts: [host] }).save(
          page,
          input,
          context()
        );
        expect(new Set(results.map((item) => item.name)).size).toBe(2);
        for (const saved of results) {
          expect(saved.status).toBe("saved");
          expect(Buffer.byteLength(saved.name)).toBeLessThanOrEqual(240);
          expect(saved.name.length).toBeLessThanOrEqual(240);
          expect(saved.name).not.toMatch(/[\ud800-\udbff]$/u);
          if (name.endsWith(".txt")) expect(saved.name).toMatch(/\.txt$/);
          expect(await readFile(saved.localPath!)).toEqual(body);
          expect(saved.sha256).toBe(createHash("sha256").update(body).digest("hex"));
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
  it("keeps short Unicode names and reserved-name protection", () => {
    expect(sanitizeFilename("売上 報告書①.pdf")).toBe("売上 報告書①.pdf");
    expect(sanitizeFilename("CON.pdf")).toBe("_CON.pdf");
  });

  it("bounds a hanging HTTP body and never persists its late result", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-phase-hang-"));
    let release!: (value: Buffer) => void;
    const pending = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async () => {
            calls++;
            return {
              ok: () => true,
              status: () => 200,
              headers: () => ({ "content-type": "text/plain" }),
              body: () => pending
            };
          }
        }
      })
    };
    try {
      const started = performance.now();
      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: [host],
        overallTimeoutMs: 80
      }).save(page, candidates(12), context());
      expect(performance.now() - started).toBeLessThan(1000);
      expect(calls).toBe(1);
      expect(result.slice(0, 10).every((item) => item.stage === "attachment-phase-timeout")).toBe(true);
      expect(result.slice(10).every((item) => item.stage === "attachment-count-limit")).toBe(true);
      release(body);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await readdir(path.join(directory, "workspace", "request"))).toEqual([]);
    } finally {
      release(body);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies one total deadline across files, preserves completed files and isolates concurrent saves", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-phase-multi-"));
    try {
      const slow = fixture(60),
        fast = fixture();
      const saver = new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: [host],
        overallTimeoutMs: 100
      });
      const [timed, completed] = await Promise.all([
        saver.save(slow.page, candidates(3), context("slow")),
        saver.save(fast.page, candidates(3), context("fast"))
      ]);
      expect(timed[0].status).toBe("saved");
      expect(timed.slice(1).every((item) => item.stage === "attachment-phase-timeout")).toBe(true);
      expect(slow.requested).toHaveLength(2);
      expect(completed.every((item) => item.status === "saved")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await readdir(path.join(directory, "workspace", "slow"))).toEqual(["file-1.txt"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps human cancellation distinct from a deadline", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-phase-cancel-"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      const { page } = fixture(100);
      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: [host],
        overallTimeoutMs: 500
      }).save(page, candidates(2), { ...context(), signal: controller.signal });
      expect(result.every((item) => item.stage === "cancelled")).toBe(true);
    } finally {
      clearTimeout(timer);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels a started browser download at the phase deadline", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-phase-browser-"));
    let cancelled = 0;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async () => undefined as never,
      waitForEvent: async () => ({
        url: () => `https://${host}/file.txt`,
        suggestedFilename: () => "file.txt",
        path: () => new Promise(() => {}),
        cancel: async () => {
          cancelled++;
        }
      })
    };
    try {
      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: [host],
        overallTimeoutMs: 80,
        timeoutMs: 1000
      }).save(
        page,
        [
          { index: 1, name: "file.txt", downloadControlIndex: 0 },
          ...candidates(1).map((item) => ({ ...item, index: 2 }))
        ],
        context()
      );
      expect(result.every((item) => item.stage === "attachment-phase-timeout")).toBe(true);
      expect(cancelled).toBe(1);
      expect(await readdir(path.join(directory, "workspace", "request"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not let a stuck download-cancel RPC extend an exhausted phase indefinitely", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-phase-stuck-cancel-"));
    let cancelled = 0;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async () => undefined as never,
      waitForEvent: async () => ({
        url: () => `https://${host}/file.txt`,
        suggestedFilename: () => "file.txt",
        path: () => new Promise(() => {}),
        cancel: () => {
          cancelled++;
          return new Promise(() => {});
        }
      })
    };
    try {
      const started = performance.now();
      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: [host],
        overallTimeoutMs: 80,
        timeoutMs: 1000
      }).save(page, [{ index: 1, name: "file.txt", downloadControlIndex: 0 }], context());
      expect(result[0].stage).toBe("attachment-phase-timeout");
      expect(cancelled).toBe(1);
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("gives in-page click guards the whole-phase deadline and prevents late clicks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-phase-click-"));
    let clicks = 0;
    let clickBy = Infinity;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      waitForEvent: () => new Promise(() => {}),
      evaluate: async (_fn, arg) => {
        clickBy = (arg as { clickBy: number }).clickBy;
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (Date.now() <= clickBy) clicks++;
        return undefined as never;
      }
    };
    try {
      const started = Date.now();
      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: [host],
        overallTimeoutMs: 80,
        timeoutMs: 1000
      }).save(page, [{ index: 1, name: "file.txt", downloadControlIndex: 0 }], context());
      expect(result[0].stage).toBe("attachment-phase-timeout");
      expect(clickBy).toBeLessThanOrEqual(started + 80);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(clicks).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("includes the passive SSO retry in the same overall deadline", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-phase-sso-"));
    let requests = 0,
      tabs = 0,
      closed = 0;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async () => {
            requests++;
            return { ok: () => false, status: () => 403, headers: () => ({}), body: async () => body };
          }
        },
        newPage: async () => {
          tabs++;
          return {
            url: () => `https://${host}/file.txt`,
            goto: () => new Promise(() => {}),
            close: async () => {
              closed++;
            }
          };
        }
      })
    };
    try {
      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: [host],
        overallTimeoutMs: 80,
        timeoutMs: 1000
      }).save(page, candidates(2), context());
      expect(result.every((item) => item.stage === "attachment-phase-timeout")).toBe(true);
      expect({ requests, tabs, closed }).toEqual({ requests: 1, tabs: 1, closed: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
