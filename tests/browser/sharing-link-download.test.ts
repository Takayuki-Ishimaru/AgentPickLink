import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { AttachmentSaver } from "../../src/transports/browser/attachment-saver.js";
import { ResponseExtractor } from "../../src/transports/browser/response-extractor.js";
import type { PageLike } from "../../src/transports/browser/types.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome"
].find((item): item is string => !!item && existsSync(item));
const origin = "https://tenant-my.sharepoint.com";

describe.skipIf(!executable)("personal sharing links with a real browser session", () => {
  it("waits for passive SSO and preserves filenames and bytes across file formats", async () => {
    const files = ["pdf", "docx", "xlsx", "pptx", "csv", "zip"].map((extension) => ({
      name: `日本語.${extension}`,
      body: Buffer.from(
        extension === "pdf" ? "%PDF-1.7\nsynthetic PDF" : `synthetic ${extension} bytes\0\xff`
      )
    }));
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, origin);
      const index = Number(url.searchParams.get("file") ?? url.pathname.split("/").at(-1));
      if (url.pathname === "/chat") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<div data-message-author-role="assistant">${files.map((_, i) => `<a href="${origin}/:b:/p/person/${i}">Open file</a>`).join(" ")}</div>`
        );
      } else if (url.pathname.includes("/download.aspx")) {
        const file = files.find(
          (f) => url.searchParams.get("SourceUrl") === origin + "/files/" + encodeURIComponent(f.name)
        );
        if (!file || !req.headers.cookie?.includes("file-session=ready")) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
        });
        res.end(file.body);
      } else if (url.pathname.includes("/onedrive.aspx")) {
        res.setHeader("Content-Type", "text/html");
        res.end("<title>File viewer</title>");
      } else if (!files[index]) {
        res.writeHead(404);
        res.end();
      } else if (url.pathname === "/passive-login") {
        const viewer =
          "/personal/person/_layouts/15/onedrive.aspx?id=" +
          encodeURIComponent("/files/" + files[index]!.name);
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<script>setTimeout(()=>{document.cookie='file-session=ready; Path=/';location.href=${JSON.stringify(viewer)}},1200)</script>`
        );
      } else if (url.searchParams.get("download") === "1") {
        // The opaque sharing endpoint remains a viewer even after SSO; the resolved URL is needed.
        res.setHeader("Content-Type", "text/html");
        res.end("<!doctype html><title>File viewer</title>");
      } else {
        res.writeHead(302, { Location: `/passive-login?file=${index}` });
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const local = `http://127.0.0.1:${address.port}`;
    const toLocal = (value: string) => value.replace(origin, local);
    const toPublic = (value: string) => value.replace(local, origin);
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-real-sharing-"));
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(local + "/chat");
      const extracted = await new ResponseExtractor({
        attachmentHosts: ["tenant-my.sharepoint.com"]
      }).extract(page as unknown as PageLike, { assistantCount: 0 });
      expect(extracted.attachmentCandidates).toHaveLength(files.length);
      // Only the fixture transport maps the allowlisted HTTPS URL to loopback. Real browser HTTP,
      // cookie storage, delayed navigation and API requests run unchanged; production policy is intact.
      const savingPage: PageLike = {
        url: () => origin + "/chat",
        context: () => ({
          request: {
            get: async (url, options) => {
              requests.push(url);
              const response = await context.request.get(toLocal(url), options);
              return {
                ok: () => response.ok(),
                status: () => response.status(),
                headers: () => response.headers(),
                body: () => response.body(),
                url: () => toPublic(response.url())
              };
            }
          },
          newPage: async () => {
            const tab = await context.newPage();
            return {
              url: () => toPublic(tab.url()),
              goto: (url, options) => tab.goto(toLocal(url), options),
              waitForTimeout: (ms) => tab.waitForTimeout(ms),
              close: () => tab.close()
            };
          }
        })
      };
      const saved = await new AttachmentSaver({
        enabled: true,
        directory,
        timeoutMs: 5_000,
        allowedHosts: ["tenant-my.sharepoint.com"]
      }).save(savingPage, extracted.attachmentCandidates!, { workspaceKey: "test", requestId: "sharing" });
      for (const [index, file] of files.entries()) {
        expect(saved[index]).toMatchObject({ status: "saved", name: file.name });
        expect(await readFile(saved[index]!.localPath!)).toEqual(file.body);
      }
      expect(context.pages()).toEqual([page]);
      expect(requests.filter((url) => url.includes("/download.aspx"))).toHaveLength(files.length);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
