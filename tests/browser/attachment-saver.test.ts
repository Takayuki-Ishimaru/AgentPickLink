import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AttachmentSaver,
  sharePointViewerDownloadUrl
} from "../../src/transports/browser/attachment-saver.js";
import type { PageLike } from "../../src/transports/browser/types.js";

/** Which of the saver's page scripts a fake `evaluate` was handed, by a marker in its source. */
function evaluateStep(fn: unknown): "reveal" | "open-card" | "download-control" {
  const source = String(fn);
  if (source.includes("PointerEvent")) return "reveal";
  if (source.includes("previewControl")) return "open-card";
  return "download-control";
}

describe("response attachment saving", () => {
  it("saves multiple authenticated response files and returns verifiable metadata", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const bodies = new Map([
      ["APL-Multi-01.pdf", Buffer.from("%PDF-1.7 one")],
      ["APL-Multi-02.pdf", Buffer.from("%PDF-1.7 two")],
      ["APL-Multi-03.pdf", Buffer.from("%PDF-1.7 three")]
    ]);
    const requested: string[] = [];
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async (url) => {
            requested.push(url);
            const name = new URL(url).pathname.split("/").at(-1)!;
            const body = bodies.get(name)!;
            return {
              ok: () => true,
              status: () => 200,
              headers: () => ({ "content-type": "application/pdf", "content-length": `${body.length}` }),
              body: async () => body
            };
          }
        }
      })
    };
    const saver = new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    });
    const candidates = [...bodies.keys()].map((name, index) => ({
      index: index + 1,
      name,
      url: `https://tenant.sharepoint.com/files/${name}`
    }));

    const attachments = await saver.save(page, candidates, {
      workspaceKey: "workspace-key",
      requestId: "req_multi"
    });

    expect(attachments).toHaveLength(3);
    expect(attachments.every((item) => item.status === "saved")).toBe(true);
    expect(requested.every((url) => new URL(url).searchParams.get("download") === "1")).toBe(true);
    for (const attachment of attachments) {
      const expected = bodies.get(attachment.name)!;
      expect(await readFile(attachment.localPath!)).toEqual(expected);
      expect(attachment.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
      expect(attachment.mediaType).toBe("application/pdf");
    }
  });

  it("uses the opened workspace's APL_downloads directory when a workspace root is supplied", async () => {
    const appDataDirectory = await mkdtemp(path.join(os.tmpdir(), "apl-appdata-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "apl-workspace-"));
    const body = Buffer.from("workspace-local");
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async () => ({
            ok: () => true,
            status: () => 200,
            headers: () => ({ "content-type": "text/plain" }),
            body: async () => body
          })
        }
      })
    };
    const [attachment] = await new AttachmentSaver({
      enabled: true,
      directory: appDataDirectory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "result.txt", url: "https://tenant.sharepoint.com/files/result.txt" }], {
      workspaceKey: "workspace-key",
      workspaceRoot,
      requestId: "request"
    });

    expect(attachment?.status).toBe("saved");
    expect(attachment?.localPath).toBe(
      path.join(workspaceRoot, "APL_downloads", "workspace-key", "request", "result.txt")
    );
    expect(await readFile(attachment!.localPath!)).toEqual(body);
  });

  it("does not follow a workspace-root symlink", async () => {
    const realRoot = await mkdtemp(path.join(os.tmpdir(), "apl-workspace-real-"));
    const linkedRoot = path.join(os.tmpdir(), `apl-workspace-link-${Date.now()}`);
    await symlink(realRoot, linkedRoot, "dir");
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async () => ({
            ok: () => true,
            status: () => 200,
            headers: () => ({ "content-type": "text/plain" }),
            body: async () => Buffer.from("must not save")
          })
        }
      })
    };

    try {
      await expect(
        new AttachmentSaver({ enabled: true, allowedHosts: ["tenant.sharepoint.com"] }).save(
          page,
          [{ index: 1, name: "result.txt", url: "https://tenant.sharepoint.com/result.txt" }],
          { workspaceKey: "workspace", workspaceRoot: linkedRoot, requestId: "request" }
        )
      ).resolves.toMatchObject([{ status: "not-saved", errorCode: "download-failed" }]);
    } finally {
      await rm(linkedRoot, { force: true });
      await rm(realRoot, { recursive: true, force: true });
    }
  });

  it("allows concurrent saves to create one workspace request directory", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "apl-workspace-concurrent-"));
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async (url) => ({
            ok: () => true,
            status: () => 200,
            headers: () => ({ "content-type": "text/plain" }),
            body: async () => Buffer.from(new URL(url).pathname)
          })
        }
      })
    };
    const saver = () => new AttachmentSaver({ enabled: true, allowedHosts: ["tenant.sharepoint.com"] });
    const [left, right] = await Promise.all([
      saver().save(page, [{ index: 1, name: "left.txt", url: "https://tenant.sharepoint.com/left.txt" }], {
        workspaceKey: "workspace",
        workspaceRoot,
        requestId: "request"
      }),
      saver().save(page, [{ index: 2, name: "right.txt", url: "https://tenant.sharepoint.com/right.txt" }], {
        workspaceKey: "workspace",
        workspaceRoot,
        requestId: "request"
      })
    ]);
    expect(left[0]?.status).toBe("saved");
    expect(right[0]?.status).toBe("saved");
  });

  it("does not fetch files from an unapproved host or when downloads are disabled", async () => {
    let requests = 0;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async () => {
            requests++;
            throw new Error("must not fetch");
          }
        }
      })
    };
    const candidate = {
      index: 1,
      name: "report.pdf",
      url: "https://unexpected.example/report.pdf"
    };
    const context = { workspaceKey: "workspace", requestId: "request" };

    await expect(new AttachmentSaver().save(page, [candidate], context)).resolves.toMatchObject([
      { status: "not-saved", errorCode: "downloads-disabled" }
    ]);
    await expect(
      new AttachmentSaver({ enabled: true, directory: os.tmpdir(), allowedHosts: ["allowed.example"] }).save(
        page,
        [candidate],
        context
      )
    ).resolves.toMatchObject([{ status: "not-saved", errorCode: "host-not-allowed" }]);
    expect(requests).toBe(0);
  });

  it("requires HTTPS for allowlisted URL attachments and rejects redirects off the allowlist", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    let requests = 0;
    const requestedUrls: string[] = [];
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async (url) => {
            requests++;
            requestedUrls.push(url);
            return {
              ok: () => true,
              status: () => 302,
              headers: () => ({ location: "https://evil.example/download" }),
              body: async () => Buffer.alloc(0)
            };
          }
        }
      })
    };
    const saver = new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    });

    await expect(
      saver.save(page, [{ index: 1, name: "http.pdf", url: "http://tenant.sharepoint.com/files/http.pdf" }], {
        workspaceKey: "workspace",
        requestId: "http"
      })
    ).resolves.toMatchObject([{ status: "not-saved", errorCode: "host-not-allowed" }]);
    await expect(
      saver.save(
        page,
        [{ index: 1, name: "redirect.pdf", url: "https://tenant.sharepoint.com/files/redirect.pdf" }],
        { workspaceKey: "workspace", requestId: "redirect" }
      )
    ).resolves.toMatchObject([{ status: "not-saved", errorCode: "download-failed", stage: "http-rejected" }]);
    expect(requests).toBe(1);
    expect(requestedUrls).toEqual(["https://tenant.sharepoint.com/files/redirect.pdf?download=1"]);
  });

  it("follows only allowlisted HTTPS redirects and stops after ten hops", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const requestedUrls: string[] = [];
    let calls = 0;
    const body = Buffer.from("redirected pdf");
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async (url) => {
            requestedUrls.push(url);
            calls++;
            if (calls === 1)
              return {
                ok: () => false,
                status: () => 302,
                headers: () => ({ location: "/files/final.pdf" }),
                body: async () => Buffer.alloc(0)
              };
            return {
              ok: () => true,
              status: () => 200,
              url: () => url,
              headers: () => ({ "content-type": "application/pdf" }),
              body: async () => body
            };
          }
        }
      })
    };
    const saver = new AttachmentSaver({ enabled: true, directory, allowedHosts: ["tenant.sharepoint.com"] });
    const saved = await saver.save(
      page,
      [{ index: 1, name: "final.pdf", url: "https://tenant.sharepoint.com/files/start.pdf" }],
      { workspaceKey: "workspace", requestId: "redirect-ok" }
    );
    expect(saved[0]).toMatchObject({ status: "saved", sizeBytes: body.length });
    expect(requestedUrls).toEqual([
      "https://tenant.sharepoint.com/files/start.pdf?download=1",
      "https://tenant.sharepoint.com/files/final.pdf"
    ]);

    const loopPage: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async (url) => ({
            ok: () => false,
            status: () => 302,
            headers: () => ({ location: url }),
            body: async () => Buffer.alloc(0)
          })
        }
      })
    };
    const loopResult = await saver.save(
      loopPage,
      [{ index: 1, name: "loop.pdf", url: "https://tenant.sharepoint.com/files/loop.pdf" }],
      { workspaceKey: "workspace", requestId: "redirect-loop" }
    );
    expect(loopResult).toMatchObject([
      { status: "not-saved", errorCode: "download-failed", stage: "http-rejected" }
    ]);
  });

  it("rejects an HTML viewer response instead of saving it as the advertised file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async () => ({
            ok: () => true,
            status: () => 200,
            headers: () => ({ "content-type": "text/html" }),
            body: async () => Buffer.from("<!doctype html><title>Viewer</title>")
          })
        }
      })
    };
    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "report.pdf", url: "https://tenant.sharepoint.com/report.pdf" }], {
      workspaceKey: "workspace",
      requestId: "request"
    });
    expect(result).toMatchObject([{ status: "not-saved", errorCode: "download-failed" }]);
  });

  it("establishes passive SharePoint SSO and retries once when the first request returns sign-in HTML", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const body = Buffer.from("%PDF-1.7 authenticated");
    let requests = 0;
    let navigatedTo: string | undefined;
    let bootstrapClosed = false;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async () => {
            requests++;
            if (requests === 1)
              return {
                ok: () => true,
                status: () => 200,
                headers: () => ({ "content-type": "text/html" }),
                body: async () => Buffer.from("<!doctype html><title>Sign in</title>")
              };
            return {
              ok: () => true,
              status: () => 200,
              headers: () => ({ "content-type": "application/pdf" }),
              body: async () => body
            };
          }
        },
        newPage: async () => ({
          url: () => navigatedTo ?? "about:blank",
          goto: async (url) => {
            navigatedTo = url;
          },
          waitForTimeout: async () => undefined,
          close: async () => {
            bootstrapClosed = true;
          }
        })
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "report.pdf", url: "https://tenant.sharepoint.com/:b:/g/report" }], {
      workspaceKey: "workspace",
      requestId: "request"
    });

    expect(requests).toBe(2);
    expect(navigatedTo).toBe("https://tenant.sharepoint.com/:b:/g/report");
    expect(bootstrapClosed).toBe(true);
    expect(result).toMatchObject([
      { status: "saved", name: "report.pdf", mediaType: "application/pdf", sizeBytes: body.length }
    ]);
  });

  it("uses Content-Disposition to name an opaque allowlisted SharePoint attachment", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const body = Buffer.from("%PDF-1.7 opaque share link");
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async () => ({
            ok: () => true,
            status: () => 200,
            headers: () => ({
              "content-type": "application/pdf",
              "content-disposition": "attachment; filename*=UTF-8''APL-T08-PdfFile%20Result.pdf"
            }),
            body: async () => body
          })
        }
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(
      page,
      [
        {
          index: 1,
          name: "attachment-1",
          url: "https://tenant.sharepoint.com/:b:/g/personal/user/opaque-token"
        }
      ],
      { workspaceKey: "workspace", requestId: "request" }
    );

    expect(result).toMatchObject([
      {
        status: "saved",
        name: "APL-T08-PdfFile Result.pdf",
        mediaType: "application/pdf",
        sizeBytes: body.length
      }
    ]);
    expect(await readFile(result[0]!.localPath!)).toEqual(body);
  });

  it("saves an explicit M365 file-card download after validating its final URL and suggested name", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const temporaryPath = path.join(directory, "playwright-download.tmp");
    const body = Buffer.from("PK valid docx");
    await writeFile(temporaryPath, body);
    let clicked = false;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async () => {
        clicked = true;
      },
      waitForEvent: async () => ({
        url: () => "https://tenant.sharepoint.com/download/document",
        suggestedFilename: () => "APL-T05-WordFile.docx",
        path: async () => temporaryPath,
        failure: async () => null
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "APL-T05-Word-Result 4", downloadControlIndex: 0 }], {
      workspaceKey: "workspace",
      requestId: "request"
    });

    expect(clicked).toBe(true);
    expect(result).toMatchObject([
      {
        status: "saved",
        name: "APL-T05-WordFile.docx",
        sourceUrl: "https://tenant.sharepoint.com/download/document",
        sizeBytes: body.length
      }
    ]);
    expect(await readFile(result[0]!.localPath!)).toEqual(body);
  });

  it("saves a same-origin blob from the explicitly selected download anchor", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const temporaryPath = path.join(directory, "playwright-blob-download.tmp");
    const body = Buffer.from("PK blob zip fixture");
    await writeFile(temporaryPath, body);
    const blobUrl = "blob:https://m365.example.test/7f8e9d00-1111-4222-8333-abcdefabcdef";
    let clicked = false;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        expect(String(fn)).toContain("a[download]");
        const control = {
          href: blobUrl,
          download: "APL-T09-Multi.zip",
          matches: (selector: string) => selector === "a[download]",
          getAttribute: (name: string) => (name === "download" ? "APL-T09-Multi.zip" : null),
          textContent: "",
          innerHTML: "",
          click: () => {
            clicked = true;
            // Simulate a synchronous click handler that replaces href after activation.
            control.href = "blob:https://evil.example/replaced-by-handler";
          }
        };
        const response = {
          closest: () => response,
          querySelectorAll: () => [control]
        };
        const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: { querySelectorAll: () => [response] }
        });
        try {
          return (fn as (args: unknown) => unknown)({
            selector: "response",
            index: 0,
            expectedName: "APL-T09-Multi.zip"
          }) as never;
        } finally {
          if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
          else Reflect.deleteProperty(globalThis, "document");
        }
      },
      waitForEvent: async () => ({
        url: () => blobUrl,
        suggestedFilename: () => "APL-T09-Multi.zip",
        path: async () => temporaryPath,
        failure: async () => null
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "APL-T09-Multi.zip", downloadControlIndex: 0 }], {
      workspaceKey: "workspace",
      requestId: "request-blob-positive"
    });

    expect(clicked).toBe(true);
    expect(result).toMatchObject([
      { status: "saved", name: "APL-T09-Multi.zip", sizeBytes: body.length, sourceUrl: blobUrl }
    ]);
    expect(await readFile(result[0]!.localPath!)).toEqual(body);
  });

  it("does not click a blob anchor when a dynamic preceding control shifts the candidate index", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const temporaryPath = path.join(directory, "playwright-shifted-blob.tmp");
    await writeFile(temporaryPath, Buffer.from("PK shifted blob fixture"));
    let clicked = false;
    const wrongAnchor = {
      href: "blob:https://m365.example.test/wrong",
      download: "other-file.zip",
      matches: (selector: string) => selector === "a[download]",
      getAttribute: (name: string) => (name === "download" ? "other-file.zip" : null),
      textContent: "",
      innerHTML: "",
      click: () => {
        clicked = true;
      }
    };
    const rightAnchor = {
      ...wrongAnchor,
      href: "blob:https://m365.example.test/right",
      download: "APL-T09-Multi.zip"
    };
    const response = {
      closest: () => response,
      querySelectorAll: () => [wrongAnchor, rightAnchor]
    };
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown, args: unknown) => {
        const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: { querySelectorAll: () => [response] }
        });
        try {
          return (fn as (input: unknown) => unknown)(args) as never;
        } finally {
          if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
          else Reflect.deleteProperty(globalThis, "document");
        }
      },
      waitForEvent: async () => ({
        url: () => wrongAnchor.href,
        suggestedFilename: () => "other-file.zip",
        path: async () => temporaryPath,
        failure: async () => null,
        cancel: async () => undefined
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "APL-T09-Multi.zip", downloadControlIndex: 0 }], {
      workspaceKey: "workspace",
      requestId: "request-blob-shifted"
    });

    expect(clicked).toBe(false);
    expect(result).toMatchObject([{ status: "not-saved", errorCode: "download-failed" }]);
  });

  it("preserves arbitrary names and bodies from explicit browser downloads", async () => {
    const names = [
      "image.png",
      "vector.svg",
      "notes.md",
      "data.xml",
      "page.html",
      "README",
      "payload.unknown"
    ];
    for (const name of names) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
      const temporaryPath = path.join(directory, name.replace(/[^A-Za-z0-9]/g, "_") + ".tmp");
      const body = name === "README" ? Buffer.alloc(0) : Buffer.from("explicit download: " + name);
      await writeFile(temporaryPath, body);
      const page: PageLike = {
        url: () => "https://m365.example.test/chat",
        evaluate: async () => true as never,
        waitForEvent: async () => ({
          url: () => "https://tenant.sharepoint.com/download/arbitrary",
          suggestedFilename: () => name,
          path: async () => temporaryPath,
          failure: async () => null
        })
      };

      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: ["tenant.sharepoint.com"]
      }).save(page, [{ index: 1, name, downloadControlIndex: 0 }], {
        workspaceKey: "workspace",
        requestId: "request-arbitrary-" + name
      });

      expect(result).toMatchObject([{ status: "saved", name, sizeBytes: body.length }]);
      expect(await readFile(result[0]!.localPath!)).toEqual(body);
    }
  });

  it("preserves arbitrary Content-Disposition filenames including HTML and empty files", async () => {
    const cases = [
      { name: "page.html", type: "text/html", body: Buffer.from("<!doctype html><p>export</p>") },
      { name: "vector.svg", type: "image/svg+xml", body: Buffer.from("<svg/>") },
      { name: "README", type: "application/octet-stream", body: Buffer.alloc(0) },
      { name: "payload.unknown", type: "application/octet-stream", body: Buffer.from([0, 1, 2, 3]) }
    ];
    for (const item of cases) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
      const page: PageLike = {
        url: () => "https://m365.example.test/chat",
        context: () => ({
          request: {
            get: async () => ({
              ok: () => true,
              status: () => 200,
              headers: () => ({
                "content-type": item.type,
                "content-disposition": 'attachment; filename="' + item.name + '"'
              }),
              body: async () => item.body
            })
          }
        })
      };

      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: ["tenant.sharepoint.com"]
      }).save(page, [{ index: 1, name: "candidate-fallback", url: "https://tenant.sharepoint.com/export" }], {
        workspaceKey: "workspace",
        requestId: "request-header-" + item.name
      });

      expect(result).toMatchObject([{ status: "saved", name: item.name, sizeBytes: item.body.length }]);
      expect(await readFile(result[0]!.localPath!)).toEqual(item.body);
    }
  });

  it("rejects blob downloads without an exact trusted anchor and stable page origin", async () => {
    const cases = [
      {
        name: "foreign-origin",
        expectedBlobUrl: "blob:https://evil.example/11111111-1111-4111-8111-111111111111",
        actualUrl: "blob:https://evil.example/11111111-1111-4111-8111-111111111111"
      },
      {
        name: "null-origin",
        expectedBlobUrl: "blob:null/22222222-2222-4222-8222-222222222222",
        actualUrl: "blob:null/22222222-2222-4222-8222-222222222222"
      },
      {
        name: "data-origin",
        expectedBlobUrl: "blob:data:text/plain,download",
        actualUrl: "blob:data:text/plain,download"
      },
      {
        name: "file-origin",
        expectedBlobUrl: "blob:file:///tmp/download",
        actualUrl: "blob:file:///tmp/download"
      },
      {
        name: "credentials",
        expectedBlobUrl: "blob:https://user:secret@m365.example.test/33333333-3333-4333-8333-333333333333",
        actualUrl: "blob:https://user:secret@m365.example.test/33333333-3333-4333-8333-333333333333"
      },
      {
        name: "non-default-port",
        expectedBlobUrl: "blob:https://m365.example.test:8443/44444444-4444-4444-8444-444444444444",
        actualUrl: "blob:https://m365.example.test:8443/44444444-4444-4444-8444-444444444444"
      },
      {
        name: "different-blob-id",
        expectedBlobUrl: "blob:https://m365.example.test/55555555-5555-4555-8555-555555555555",
        actualUrl: "blob:https://m365.example.test/66666666-6666-4666-8666-666666666666"
      },
      {
        name: "generic-button",
        expectedBlobUrl: undefined,
        actualUrl: "blob:https://m365.example.test/77777777-7777-4777-8777-777777777777"
      },
      {
        name: "page-origin-changed",
        expectedBlobUrl: "blob:https://m365.example.test/88888888-8888-4888-8888-888888888888",
        actualUrl: "blob:https://m365.example.test/88888888-8888-4888-8888-888888888888",
        changedPageOrigin: "https://other.example.test/chat"
      }
    ] as const;

    for (const scenario of cases) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
      const temporaryPath = path.join(directory, `${scenario.name}.tmp`);
      await writeFile(temporaryPath, Buffer.from("PK untrusted blob fixture"));
      let pageUrlCalls = 0;
      let cancelled = false;
      const page: PageLike = {
        url: () => {
          pageUrlCalls++;
          return pageUrlCalls > 1 && scenario.changedPageOrigin
            ? scenario.changedPageOrigin
            : "https://m365.example.test/chat";
        },
        evaluate: async () => ({ expectedBlobUrl: scenario.expectedBlobUrl }) as never,
        waitForEvent: async () => ({
          url: () => scenario.actualUrl,
          suggestedFilename: () => "untrusted.zip",
          path: async () => temporaryPath,
          failure: async () => null,
          cancel: async () => {
            cancelled = true;
          }
        })
      };

      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: ["tenant.sharepoint.com"]
      }).save(page, [{ index: 1, name: "untrusted.zip", downloadControlIndex: 0 }], {
        workspaceKey: "workspace",
        requestId: `request-blob-${scenario.name}`
      });

      expect(result).toMatchObject([{ status: "not-saved", errorCode: "download-failed" }]);
      expect(cancelled).toBe(true);
    }
  });

  it("opens an explicit filename card and saves the preview's download", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const temporaryPath = path.join(directory, "playwright-preview-download.tmp");
    const body = Buffer.from("PK valid xlsx");
    await writeFile(temporaryPath, body);
    const calls: string[] = [];
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        const step = evaluateStep(fn);
        calls.push(step);
        return (step === "reveal" ? "control-visible" : step === "download-control") as never;
      },
      waitForEvent: async () => ({
        url: () => "https://tenant.sharepoint.com/download/workbook",
        suggestedFilename: () => "APL-T06-Spreadsheet.xlsx",
        path: async () => temporaryPath,
        failure: async () => null
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "APL-T06-Spreadsheet.xlsx", fileCardIndex: 3 }], {
      workspaceKey: "workspace",
      requestId: "request"
    });

    // The card is hovered/focused first, then opened, then its download control is activated.
    expect(calls).toEqual(["reveal", "open-card", "download-control"]);
    expect(result).toMatchObject([
      {
        status: "saved",
        name: "APL-T06-Spreadsheet.xlsx",
        sourceUrl: "https://tenant.sharepoint.com/download/workbook",
        sizeBytes: body.length
      }
    ]);
    expect(await readFile(result[0]!.localPath!)).toEqual(body);
  });

  it("falls back to a download control revealed inside the selected file card", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const temporaryPath = path.join(directory, "playwright-card-download.tmp");
    const body = Buffer.from("PK card fallback");
    await writeFile(temporaryPath, body);
    let cardFallbackClicked = false;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        const source = String(fn);
        if (source.includes("PointerEvent")) return "control-visible" as never;
        if (source.includes("previewControl")) return undefined as never;
        if (source.includes("cardControls")) {
          cardFallbackClicked = true;
          return true as never;
        }
        return undefined as never;
      },
      waitForEvent: async () => ({
        url: () => "https://tenant.sharepoint.com/download/card-fallback",
        suggestedFilename: () => "APL-T06-Excel-Result.xlsx",
        path: async () => temporaryPath,
        failure: async () => null
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "APL-T06-Excel-Result.xlsx", fileCardIndex: 0 }], {
      workspaceKey: "workspace",
      requestId: "request"
    });

    expect(cardFallbackClicked).toBe(true);
    expect(result).toMatchObject([
      { status: "saved", name: "APL-T06-Excel-Result.xlsx", sizeBytes: body.length }
    ]);
  });

  it("reports a missing preview frame separately from a missing card download control", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        const source = String(fn);
        if (source.includes("PointerEvent")) return "control-visible" as never;
        if (source.includes("previewControl")) return undefined as never;
        if (source.includes("cardControls")) return false as never;
        return [] as never;
      },
      waitForTimeout: async () => undefined,
      waitForEvent: () => new Promise<never>(() => undefined),
      context: () => ({
        request: {
          get: async () => {
            throw new Error("preview request must not run");
          }
        }
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"],
      timeoutMs: 300
    }).save(page, [{ index: 1, name: "missing-preview.xlsx", fileCardIndex: 0 }], {
      workspaceKey: "workspace",
      requestId: "request"
    });

    expect(result).toMatchObject([
      {
        status: "not-saved",
        errorCode: "download-failed",
        stage: "preview-download-control-not-found"
      }
    ]);
  });

  it("rejects a recognized preview on an unapproved host before any download fallback", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    let fallbackClicked = false;
    const viewer =
      "https://blocked.example/_layouts/15/embed.aspx?uniqueId=a006a8f6-d137-49dd-bcb2-8097892c1d03";
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        const source = String(fn);
        if (source.includes("PointerEvent")) return "control-visible" as never;
        if (source.includes("previewControl")) return undefined as never;
        if (source.includes("iframe[src]")) return [viewer] as never;
        fallbackClicked = true;
        return false as never;
      },
      waitForEvent: async () => {
        throw new Error("download fallback must not be started");
      },
      context: () => ({
        request: {
          get: async () => {
            throw new Error("blocked preview must not be fetched");
          }
        }
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "blocked.xlsx", fileCardIndex: 0 }], {
      workspaceKey: "workspace",
      requestId: "request"
    });

    expect(fallbackClicked).toBe(false);
    expect(result).toMatchObject([
      {
        status: "not-saved",
        errorCode: "host-not-allowed",
        stage: "preview-host-not-allowed"
      }
    ]);
  });

  it("resolves a SharePoint Office preview GUID and saves the file through the authenticated request", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const body = Buffer.from("PK authenticated docx");
    const viewer =
      "https://tenant.sharepoint.com/:w:/r/personal/user/_layouts/15/Doc.aspx?sourcedoc=%7B12345678-1234-1234-1234-1234567890ab%7D&file=report.docx";
    let requested: string | undefined;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        const step = evaluateStep(fn);
        if (step === "reveal") return "control-visible" as never;
        return (step === "open-card" ? undefined : [viewer]) as never;
      },
      waitForEvent: async () => {
        throw new Error("browser download fallback must not be used");
      },
      context: () => ({
        request: {
          get: async (url) => {
            requested = url;
            return {
              ok: () => true,
              status: () => 200,
              headers: () => ({
                "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              }),
              body: async () => body
            };
          }
        }
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "report.docx", fileCardIndex: 0 }], {
      workspaceKey: "workspace",
      requestId: "request"
    });

    expect(requested).toBe(
      "https://tenant.sharepoint.com/personal/user/_layouts/15/download.aspx?UniqueId=12345678-1234-1234-1234-1234567890ab"
    );
    expect(result).toMatchObject([{ status: "saved", name: "report.docx", sizeBytes: body.length }]);
  });

  it("discovers a SharePoint Office viewer rendered in a child frame", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const body = Buffer.from("PK framed docx");
    const viewer =
      "https://tenant.sharepoint.com/:w:/r/personal/user/_layouts/15/Doc.aspx?sourcedoc=%7B87654321-4321-4321-4321-ba0987654321%7D";
    let requested: string | undefined;
    const frame = {
      url: () => viewer,
      evaluate: async () => []
    };
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        const step = evaluateStep(fn);
        if (step === "reveal") return "control-visible" as never;
        return (step === "open-card" ? undefined : []) as never;
      },
      frames: () => [frame],
      waitForEvent: async () => {
        throw new Error("browser download fallback must not be used");
      },
      context: () => ({
        request: {
          get: async (url) => {
            requested = url;
            return {
              ok: () => true,
              status: () => 200,
              headers: () => ({
                "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              }),
              body: async () => body
            };
          }
        }
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "framed.docx", fileCardIndex: 0 }], {
      workspaceKey: "workspace",
      requestId: "request"
    });

    expect(requested).toBe(
      "https://tenant.sharepoint.com/personal/user/_layouts/15/download.aspx?UniqueId=87654321-4321-4321-4321-ba0987654321"
    );
    expect(result).toMatchObject([{ status: "saved", name: "framed.docx", sizeBytes: body.length }]);
  });

  it("reveals a hover-only download control by focusing the card and dispatching hover events", async () => {
    // Microsoft 365 renders a file card's controls only while the card is hovered or focused, and
    // PageLike exposes no pointer action, so the saver dispatches the hover events in the page.
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const temporaryPath = path.join(directory, "playwright-hover-download.tmp");
    const body = Buffer.from("PK hovered docx");
    await writeFile(temporaryPath, body);
    const revealScripts: string[] = [];
    let controlVisible = false;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        const step = evaluateStep(fn);
        if (step === "reveal") {
          revealScripts.push(String(fn));
          // The control only appears once the card has actually been hovered.
          const stage = controlVisible ? "control-visible" : "control-not-visible";
          controlVisible = true;
          return stage as never;
        }
        // A control the hover never revealed cannot be clicked.
        return (step === "download-control" ? controlVisible : undefined) as never;
      },
      waitForEvent: async () => ({
        url: () => "https://tenant.sharepoint.com/download/hovered",
        suggestedFilename: () => "hovered.docx",
        path: async () => temporaryPath,
        failure: async () => null
      })
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"]
    }).save(page, [{ index: 1, name: "hovered.docx", fileCardIndex: 0 }], {
      workspaceKey: "workspace",
      requestId: "request"
    });

    // It retried until the control became visible instead of giving up on the first look.
    expect(revealScripts.length).toBeGreaterThan(1);
    // Focus plus the hover events the card's own handlers listen for, dispatched in the page.
    expect(revealScripts[0]).toContain("focus");
    expect(revealScripts[0]).toContain("dispatchEvent");
    expect(revealScripts[0]).toContain("MouseEvent");
    expect(result).toMatchObject([{ status: "saved", name: "hovered.docx", sizeBytes: body.length }]);
  });

  it("reports a file card whose controls never become visible as a failed download", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        const step = evaluateStep(fn);
        if (step === "reveal") return "control-not-visible" as never;
        return (step === "download-control" ? false : undefined) as never;
      },
      // Playwright's waitForEvent only settles on a real download or its own timeout; this fixture
      // never produces one, so the saver has to give up through the control search instead.
      waitForEvent: () => new Promise<never>(() => undefined),
      waitForTimeout: async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
      }
    };

    const result = await new AttachmentSaver({
      enabled: true,
      directory,
      allowedHosts: ["tenant.sharepoint.com"],
      timeoutMs: 300
    }).save(page, [{ index: 1, name: "invisible.docx", fileCardIndex: 0 }], {
      workspaceKey: "workspace",
      requestId: "request"
    });

    expect(result).toMatchObject([{ status: "not-saved", errorCode: "download-failed" }]);
  }, 20_000);

  it("does not convert unrelated or malformed SharePoint viewer URLs", () => {
    expect(
      sharePointViewerDownloadUrl(
        new URL("https://tenant.sharepoint.com/:w:/r/personal/user/_layouts/15/Doc.aspx?sourcedoc=not-a-guid")
      )
    ).toBeUndefined();
    expect(
      sharePointViewerDownloadUrl(new URL("https://tenant.sharepoint.com/personal/user/report.docx"))
    ).toBeUndefined();
  });

  it("converts the SharePoint embed viewer used by M365 file-card previews", () => {
    expect(
      sharePointViewerDownloadUrl(
        new URL(
          "https://tenant.sharepoint.com/personal/user/_layouts/15/embed.aspx?uniqueId=a006a8f6-d137-49dd-bcb2-8097892c1d03&client_id=ignored"
        )
      )?.toString()
    ).toBe(
      "https://tenant.sharepoint.com/personal/user/_layouts/15/download.aspx?UniqueId=a006a8f6-d137-49dd-bcb2-8097892c1d03"
    );
  });

  describe("attachment kind and failure-stage vocabulary", () => {
    it("tags a saved plain-URL attachment with kind 'url'", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
      const body = Buffer.from("%PDF-1.7 kind-url");
      const page: PageLike = {
        url: () => "https://m365.example.test/chat",
        context: () => ({
          request: {
            get: async () => ({
              ok: () => true,
              status: () => 200,
              headers: () => ({ "content-type": "application/pdf" }),
              body: async () => body
            })
          }
        })
      };
      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: ["tenant.sharepoint.com"]
      }).save(page, [{ index: 1, name: "report.pdf", url: "https://tenant.sharepoint.com/report.pdf" }], {
        workspaceKey: "workspace",
        requestId: "request"
      });
      expect(result).toMatchObject([{ status: "saved", kind: "url" }]);
    });

    it("tags a saved download-control attachment with kind 'download-control' and a saved file card with kind 'file-card'", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
      const temporaryPath = path.join(directory, "playwright-download.tmp");
      await writeFile(temporaryPath, Buffer.from("PK kind check"));
      const page: PageLike = {
        url: () => "https://m365.example.test/chat",
        evaluate: async (fn: unknown) => (evaluateStep(fn) === "reveal" ? "control-visible" : true) as never,
        waitForEvent: async () => ({
          url: () => "https://tenant.sharepoint.com/download/document",
          suggestedFilename: () => "kind-check.docx",
          path: async () => temporaryPath,
          failure: async () => null
        })
      };
      const saver = new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: ["tenant.sharepoint.com"]
      });

      const downloadControlResult = await saver.save(
        page,
        [{ index: 1, name: "kind-check", downloadControlIndex: 0 }],
        { workspaceKey: "workspace", requestId: "request-download-control" }
      );
      expect(downloadControlResult).toMatchObject([{ status: "saved", kind: "download-control" }]);

      const fileCardResult = await saver.save(page, [{ index: 1, name: "kind-check", fileCardIndex: 0 }], {
        workspaceKey: "workspace",
        requestId: "request-file-card"
      });
      expect(fileCardResult).toMatchObject([{ status: "saved", kind: "file-card" }]);
    });

    it("reports 'viewer-url-unparseable' for a candidate URL that does not parse", async () => {
      const page: PageLike = { url: () => "https://m365.example.test/chat" };
      const result = await new AttachmentSaver({
        enabled: true,
        directory: os.tmpdir(),
        allowedHosts: ["tenant.sharepoint.com"]
      }).save(page, [{ index: 1, name: "report.pdf", url: "not a url" }], {
        workspaceKey: "workspace",
        requestId: "request"
      });
      expect(result).toMatchObject([
        { status: "not-saved", errorCode: "host-not-allowed", kind: "url", stage: "viewer-url-unparseable" }
      ]);
    });

    it("reports 'http-rejected' for a non-OK HTTP response", async () => {
      const page: PageLike = {
        url: () => "https://m365.example.test/chat",
        context: () => ({
          request: {
            get: async () => ({
              ok: () => false,
              status: () => 403,
              headers: () => ({}),
              body: async () => Buffer.alloc(0)
            })
          }
        })
      };
      const result = await new AttachmentSaver({
        enabled: true,
        directory: os.tmpdir(),
        allowedHosts: ["tenant.sharepoint.com"]
      }).save(page, [{ index: 1, name: "report.pdf", url: "https://tenant.sharepoint.com/report.pdf" }], {
        workspaceKey: "workspace",
        requestId: "request"
      });
      expect(result).toMatchObject([
        { status: "not-saved", errorCode: "download-failed", stage: "http-rejected" }
      ]);
    });

    it("reports 'oversize' when the declared or actual body exceeds the per-attachment cap", async () => {
      const page: PageLike = {
        url: () => "https://m365.example.test/chat",
        context: () => ({
          request: {
            get: async () => ({
              ok: () => true,
              status: () => 200,
              headers: () => ({ "content-type": "application/pdf", "content-length": "999999" }),
              body: async () => Buffer.from("%PDF-1.7 too big")
            })
          }
        })
      };
      const result = await new AttachmentSaver({
        enabled: true,
        directory: os.tmpdir(),
        allowedHosts: ["tenant.sharepoint.com"],
        maxAttachmentBytes: 10
      }).save(page, [{ index: 1, name: "report.pdf", url: "https://tenant.sharepoint.com/report.pdf" }], {
        workspaceKey: "workspace",
        requestId: "request"
      });
      expect(result).toMatchObject([
        { status: "not-saved", errorCode: "download-failed", stage: "oversize" }
      ]);
    });

    it("reports 'quota-exceeded' when a file would exceed the remaining total-attachment budget", async () => {
      const page: PageLike = {
        url: () => "https://m365.example.test/chat",
        context: () => ({
          request: {
            get: async () => ({
              ok: () => true,
              status: () => 200,
              headers: () => ({ "content-type": "application/pdf" }),
              body: async () => Buffer.from("%PDF-1.7 exceeds total budget")
            })
          }
        })
      };
      const result = await new AttachmentSaver({
        enabled: true,
        directory: os.tmpdir(),
        allowedHosts: ["tenant.sharepoint.com"],
        maxTotalAttachmentBytes: 4
      }).save(page, [{ index: 1, name: "report.pdf", url: "https://tenant.sharepoint.com/report.pdf" }], {
        workspaceKey: "workspace",
        requestId: "request"
      });
      expect(result).toMatchObject([
        { status: "not-saved", errorCode: "download-failed", stage: "quota-exceeded" }
      ]);
    });

    it("reports 'html-rejected' for an HTML viewer response, with kind 'url'", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
      const page: PageLike = {
        url: () => "https://m365.example.test/chat",
        context: () => ({
          request: {
            get: async () => ({
              ok: () => true,
              status: () => 200,
              headers: () => ({ "content-type": "text/html" }),
              body: async () => Buffer.from("<!doctype html><title>Viewer</title>")
            })
          }
        })
      };
      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: ["tenant.sharepoint.com"]
      }).save(page, [{ index: 1, name: "report.pdf", url: "https://tenant.sharepoint.com/report.pdf" }], {
        workspaceKey: "workspace",
        requestId: "request"
      });
      expect(result).toMatchObject([
        { status: "not-saved", errorCode: "download-failed", kind: "url", stage: "html-rejected" }
      ]);
    });

    it("reports 'sso-retry-failed' when the passive-SSO retry itself also fails", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
      let requests = 0;
      const page: PageLike = {
        url: () => "https://m365.example.test/chat",
        context: () => ({
          request: {
            get: async () => {
              requests++;
              // Both the first attempt and the post-SSO-bootstrap retry return sign-in HTML.
              return {
                ok: () => true,
                status: () => 200,
                headers: () => ({ "content-type": "text/html" }),
                body: async () => Buffer.from("<!doctype html><title>Sign in</title>")
              };
            }
          },
          newPage: async () => ({
            url: () => "about:blank",
            goto: async () => undefined,
            waitForTimeout: async () => undefined,
            close: async () => undefined
          })
        })
      };
      const result = await new AttachmentSaver({
        enabled: true,
        directory,
        allowedHosts: ["tenant.sharepoint.com"]
      }).save(page, [{ index: 1, name: "report.pdf", url: "https://tenant.sharepoint.com/:b:/g/report" }], {
        workspaceKey: "workspace",
        requestId: "request"
      });
      expect(requests).toBe(2);
      expect(result).toMatchObject([
        { status: "not-saved", errorCode: "download-failed", stage: "sso-retry-failed" }
      ]);
    });

    it("tags every attachment refused because downloads are disabled with its own kind", async () => {
      const page: PageLike = { url: () => "https://m365.example.test/chat" };
      const result = await new AttachmentSaver().save(
        page,
        [
          { index: 1, name: "a.pdf", url: "https://tenant.sharepoint.com/a.pdf" },
          { index: 2, name: "b.docx", downloadControlIndex: 0 },
          { index: 3, name: "c.xlsx", fileCardIndex: 0 }
        ],
        { workspaceKey: "workspace", requestId: "request" }
      );
      expect(result).toMatchObject([
        { errorCode: "downloads-disabled", kind: "url" },
        { errorCode: "downloads-disabled", kind: "download-control" },
        { errorCode: "downloads-disabled", kind: "file-card" }
      ]);
    });
  });
});

describe("download host wildcards", () => {
  it("saves from any host below a `*.` wildcard and rejects the apex and look-alike hosts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-"));
    const body = Buffer.from("%PDF-1.7 wildcard");
    const requested: string[] = [];
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      context: () => ({
        request: {
          get: async (url) => {
            requested.push(url);
            return {
              ok: () => true,
              status: () => 200,
              headers: () => ({ "content-type": "application/pdf", "content-length": `${body.length}` }),
              body: async () => body
            };
          }
        }
      })
    };
    const saver = new AttachmentSaver({ enabled: true, directory, allowedHosts: ["*.sharepoint.com"] });

    const attachments = await saver.save(
      page,
      [
        { index: 1, name: "APL-W1.pdf", url: "https://contoso.sharepoint.com/files/APL-W1.pdf" },
        { index: 2, name: "APL-W2.pdf", url: "https://Contoso-my.SharePoint.com/personal/u/APL-W2.pdf" },
        { index: 3, name: "APL-W3.pdf", url: "https://sharepoint.com/APL-W3.pdf" },
        { index: 4, name: "APL-W4.pdf", url: "https://evilsharepoint.com/APL-W4.pdf" }
      ],
      { workspaceKey: "workspace", requestId: "req_wildcard" }
    );

    expect(attachments.map((item) => [item.status, item.errorCode])).toEqual([
      ["saved", undefined],
      ["saved", undefined],
      ["not-saved", "host-not-allowed"],
      ["not-saved", "host-not-allowed"]
    ]);
    expect(requested.map((url) => new URL(url).hostname)).toEqual([
      "contoso.sharepoint.com",
      "contoso-my.sharepoint.com"
    ]);
  });
});
