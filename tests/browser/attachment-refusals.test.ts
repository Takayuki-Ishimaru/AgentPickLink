import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentSaver } from "../../src/transports/browser/attachment-saver.js";
import type {
  ApiResponseLike,
  AttachmentCandidate,
  BrowserDownloadLike,
  PageLike
} from "../../src/transports/browser/types.js";

// writeFile stays the real one unless a test makes one call fail part-way through.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

// v0.2.7 review: a download-control download from a disallowed host was refused and cancelled, but
// reported only as `download-failed` without a stage, while the URL path said
// `host-not-allowed / redirect-host-not-allowed`. One refusal must read the same on every path.

const ALLOWED = "tenant.sharepoint.com";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "apl-refusals-"));
  directories.push(directory);
  return directory;
}
async function savedFiles(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}
function saver(
  directory: string,
  options: { maxAttachmentBytes?: number; maxTotalAttachmentBytes?: number } = {}
) {
  return new AttachmentSaver({
    enabled: true,
    directory,
    allowedHosts: [ALLOWED],
    timeoutMs: 1_000,
    ...options
  });
}
const context = { workspaceKey: "workspace", requestId: "request" };

/** A browser download double. `bytes()` reports whether its body was ever awaited. */
function browserDownload(url: string, file?: string) {
  let cancels = 0;
  let awaited = false;
  const download: BrowserDownloadLike = {
    url: () => url,
    suggestedFilename: () => "report.docx",
    failure: async () => {
      awaited = true;
      return null;
    },
    path: async () => {
      awaited = true;
      return file ?? null;
    },
    cancel: async () => {
      cancels++;
    }
  };
  return { download, cancels: () => cancels, bytesAwaited: () => awaited };
}
/** A page whose UI scripts all succeed (reveal, open, click) and whose next download is `download`. */
function uiPage(download: BrowserDownloadLike): PageLike {
  return {
    url: () => "https://m365.example.test/chat",
    evaluate: async (fn: unknown) =>
      (String(fn).includes("PointerEvent") ? "control-visible" : true) as never,
    waitForEvent: async () => download
  };
}
function response(status: number, headers: Record<string, string>, body = Buffer.alloc(0)): ApiResponseLike {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    headers: () => headers,
    body: async () => body
  };
}

describe("one refusal, one error code and stage on every acquisition path", () => {
  it.each([
    { kind: "download-control", candidate: { index: 1, name: "report.docx", downloadControlIndex: 0 } },
    { kind: "file-card", candidate: { index: 1, name: "report.docx", fileCardIndex: 0 } }
  ] as const)(
    "refuses a $kind browser download from a disallowed host as host-not-allowed / source-host-not-allowed",
    async ({ kind, candidate }) => {
      const directory = await workspace();
      const blocked = browserDownload("https://files.example.net/report.docx");
      const result = await saver(directory).save(uiPage(blocked.download), [candidate], context);
      expect(result).toEqual([
        expect.objectContaining({
          status: "not-saved",
          errorCode: "host-not-allowed",
          stage: "source-host-not-allowed",
          kind
        })
      ]);
      expect(blocked.cancels()).toBe(1);
      expect(blocked.bytesAwaited()).toBe(false);
      expect(await savedFiles(directory)).toEqual([]);
    }
  );

  it("refuses a response URL on a disallowed host the same way, before any request", async () => {
    const directory = await workspace();
    let requests = 0;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async () => {
            requests++;
            return response(200, { "content-type": "text/plain" }, Buffer.from("must not save"));
          }
        }
      })
    };
    const result = await saver(directory).save(
      page,
      [{ index: 1, name: "report.txt", url: "https://files.example.net/report.txt" }],
      context
    );
    expect(result).toEqual([
      expect.objectContaining({
        status: "not-saved",
        errorCode: "host-not-allowed",
        stage: "source-host-not-allowed",
        kind: "url"
      })
    ]);
    expect(requests).toBe(0);
    expect(await savedFiles(directory)).toEqual([]);
  });

  it("keeps the redirect refusal distinct but under the same error code", async () => {
    const directory = await workspace();
    const requested: string[] = [];
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async (url) => {
            requested.push(url);
            return response(302, { location: "https://files.example.net/report.txt" });
          }
        }
      })
    };
    const result = await saver(directory).save(
      page,
      [{ index: 1, name: "report.txt", url: `https://${ALLOWED}/report.txt` }],
      context
    );
    expect(result).toEqual([
      expect.objectContaining({ errorCode: "host-not-allowed", stage: "redirect-host-not-allowed" })
    ]);
    expect(requested).toHaveLength(1);
  });

  it("refuses a download anchor with a non-HTTPS link before clicking, as a disallowed source", async () => {
    const directory = await workspace();
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      // How Playwright surfaces the page script's named error, thrown before it would click.
      evaluate: async () => {
        throw new Error("page.evaluate: Error: attachment-download-anchor-scheme-rejected\n    at eval");
      },
      waitForEvent: () => new Promise<BrowserDownloadLike>(() => undefined)
    };
    const result = await saver(directory).save(
      page,
      [
        {
          index: 1,
          name: "report.docx",
          downloadControlIndex: 0,
          url: "http://files.example.net/report.docx"
        }
      ],
      context
    );
    expect(result).toEqual([
      expect.objectContaining({
        status: "not-saved",
        errorCode: "host-not-allowed",
        stage: "source-host-not-allowed",
        kind: "download-control"
      })
    ]);
    expect(await savedFiles(directory)).toEqual([]);
  });

  it("reproduces the review's download contract: diagnostic cause kept, one cancel, nothing saved", async () => {
    const directory = await workspace();
    const temporary = path.join(directory, "fixture.txt");
    await writeFile(temporary, "synthetic download");
    let cancelled = 0;
    const download: BrowserDownloadLike = {
      url: () => "https://blocked.invalid/file.txt",
      suggestedFilename: () => "file.txt",
      failure: async () => null,
      path: async () => temporary,
      cancel: async () => {
        cancelled++;
      }
    };
    const page = {
      url: () => "https://allowed.invalid/chat",
      context: () => ({}),
      waitForEvent: async () => download,
      evaluate: async () => undefined
    } as unknown as PageLike;
    const workspaceRoot = path.join(directory, "workspace");
    await mkdir(workspaceRoot);
    const attachments = await new AttachmentSaver({
      enabled: true,
      allowedHosts: ["allowed.invalid"],
      timeoutMs: 1_000,
      overallTimeoutMs: 2_000
    }).save(page, [{ index: 1, name: "file.txt", downloadControlIndex: 0 }], {
      workspaceRoot,
      workspaceKey: "review",
      requestId: "contract-test"
    });
    expect(attachments).toEqual([
      expect.objectContaining({
        status: "not-saved",
        errorCode: "host-not-allowed",
        stage: "source-host-not-allowed"
      })
    ]);
    expect(cancelled).toBe(1);
    expect(await savedFiles(workspaceRoot)).toEqual([]);
  });
});

describe("every browser-download refusal names its stage", () => {
  it.each([
    { limit: { maxAttachmentBytes: 4 }, stage: "oversize" },
    { limit: { maxTotalAttachmentBytes: 4 }, stage: "quota-exceeded" }
  ])("reports a body over the limit as $stage, like the URL path", async ({ limit, stage }) => {
    const directory = await workspace();
    const file = path.join(await workspace(), "body.docx");
    await writeFile(file, "more than four bytes");
    const result = await saver(directory, limit).save(
      uiPage(browserDownload(`https://${ALLOWED}/report.docx`, file).download),
      [{ index: 1, name: "report.docx", downloadControlIndex: 0 }],
      context
    );
    expect(result).toEqual([
      expect.objectContaining({ status: "not-saved", errorCode: "download-failed", stage })
    ]);
    expect(await savedFiles(directory)).toEqual([]);
  });

  it("reports a blob that the selected anchor did not produce as download-source-unverified", async () => {
    const directory = await workspace();
    const blob = browserDownload("blob:https://m365.example.test/11111111-1111-4111-8111-111111111111");
    const result = await saver(directory).save(
      uiPage(blob.download),
      [{ index: 1, name: "report.docx", downloadControlIndex: 0 }],
      context
    );
    expect(result).toEqual([
      expect.objectContaining({ errorCode: "download-failed", stage: "download-source-unverified" })
    ]);
    expect(blob.cancels()).toBe(1);
  });

  it.each([
    { thrown: "attachment-download-control-missing", stage: "control-missing" },
    { thrown: "attachment-download-anchor-url-mismatch", stage: "control-changed" },
    { thrown: "attachment-response-missing", stage: "response-missing" },
    { thrown: "attachment-download-activation-expired", stage: "control-activation-timeout" }
  ])("maps the page script's $thrown to $stage", async ({ thrown, stage }) => {
    const directory = await workspace();
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async () => {
        throw new Error(`page.evaluate: Error: ${thrown}\n    at eval`);
      },
      waitForEvent: () => new Promise<BrowserDownloadLike>(() => undefined)
    };
    const result = await saver(directory).save(
      page,
      [{ index: 1, name: "report.docx", downloadControlIndex: 0 }],
      context
    );
    expect(result).toEqual([expect.objectContaining({ errorCode: "download-failed", stage })]);
  });
});

describe("URL-path failures that used to carry no stage", () => {
  const urlPage = (get: () => Promise<ApiResponseLike>): PageLike => ({
    url: () => "https://m365.example.test/chat",
    context: () => ({ request: { get } })
  });
  const candidate: AttachmentCandidate = {
    index: 1,
    name: "report.pdf",
    url: `https://${ALLOWED}/report.pdf`
  };

  it("names an empty body empty-body and a transport error request-failed", async () => {
    const directory = await workspace();
    const empty = await saver(directory).save(
      urlPage(async () => response(200, { "content-type": "application/pdf" })),
      [candidate],
      context
    );
    const transport = await saver(directory).save(
      urlPage(async () => {
        throw new Error("ECONNRESET synthetic");
      }),
      [candidate],
      { ...context, requestId: "request-2" }
    );
    expect(empty).toEqual([expect.objectContaining({ errorCode: "download-failed", stage: "empty-body" })]);
    expect(transport).toEqual([
      expect.objectContaining({ errorCode: "download-failed", stage: "request-failed" })
    ]);
  });

  it("never overwrites an existing file and reports write-failed", async () => {
    const directory = await workspace();
    const destination = path.join(directory, "workspace", "request");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "report.pdf"), "earlier result");
    const result = await saver(directory).save(
      urlPage(async () => response(200, { "content-type": "application/pdf" }, Buffer.from("%PDF-1.7 new"))),
      [candidate],
      context
    );
    expect(result).toEqual([
      expect.objectContaining({ errorCode: "download-failed", stage: "write-failed" })
    ]);
    // The earlier file is neither overwritten nor removed.
    expect(await readFile(path.join(destination, "report.pdf"), "utf8")).toBe("earlier result");
  });

  it("removes a partially written file when the write fails part-way (e.g. a full disk)", async () => {
    const directory = await workspace();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(writeFile).mockImplementationOnce(async (file, data, options) => {
      await actual.writeFile(file, (data as Buffer).subarray(0, 4), options);
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    const result = await saver(directory).save(
      urlPage(async () => response(200, { "content-type": "application/pdf" }, Buffer.from("%PDF-1.7 new"))),
      [candidate],
      context
    );
    expect(result).toEqual([
      expect.objectContaining({ status: "not-saved", errorCode: "download-failed", stage: "write-failed" })
    ]);
    expect(await savedFiles(directory)).toEqual([]);
  });

  it("names a finished browser download that cannot be read browser-download-failed", async () => {
    const directory = await workspace();
    const vanished = browserDownload(`https://${ALLOWED}/report.docx`, path.join(directory, "gone.tmp"));
    const result = await saver(directory).save(
      uiPage(vanished.download),
      [{ index: 1, name: "report.docx", downloadControlIndex: 0 }],
      context
    );
    expect(result).toEqual([
      expect.objectContaining({ errorCode: "download-failed", stage: "browser-download-failed" })
    ]);
  });
});
