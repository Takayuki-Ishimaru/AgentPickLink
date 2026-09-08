import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { FrontendBrokerPort } from "../../src/frontend/broker-port.js";
import { createSdkServer } from "../../src/frontend/mcp-server.js";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { attachmentMediaType } from "../../src/domain/attachment-media.js";
import { AttachmentSaver } from "../../src/transports/browser/attachment-saver.js";
import { ResponseExtractor } from "../../src/transports/browser/response-extractor.js";
import type { PageLike } from "../../src/transports/browser/types.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome"
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

describe.skipIf(!executable)("arbitrary response attachments through a real browser", () => {
  it("extracts and saves explicit files without changing names or bytes or executing their content", async () => {
    const files = [
      {
        name: "pixel.png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64"
        )
      },
      {
        name: "drawing.svg",
        body: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><text>日本語・中文・한국어</text><script>globalThis.attachmentExecuted=true</script></svg>'
        )
      },
      { name: "notes.md", body: Buffer.from("\ufeff# UTF-8 BOM\n日本語\r\n") },
      {
        name: "data.xml",
        body: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><result>日本語・𠮷</result>')
      },
      {
        name: "page.html",
        body: Buffer.from(
          '<!doctype html><html><meta charset="utf-8"><body>日本語・中文・한국어<script>globalThis.attachmentExecuted=true</script></body></html>'
        )
      },
      { name: "sample.js", body: Buffer.from("globalThis.attachmentExecuted=true") },
      { name: "audio.wav", body: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0xfe]) },
      { name: "video.mp4", body: Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff]) },
      { name: "bundle.tar.gz", body: Buffer.from([0x1f, 0x8b, 0, 0xff, 0xfe]) },
      { name: "データ.unlisted sample", body: Buffer.from([0, 255, 254, 128, 1, 2, 3]) },
      { name: "README", body: Buffer.from("No extension\n") },
      { name: "empty.unknown", body: Buffer.alloc(0) },
      {
        name: "utf16.csv",
        body: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("name,value\r\n日本語,42", "utf16le")])
      },
      {
        name: "日本語.csv",
        body: Buffer.from('\ufeff項目,値\r\n"東京,大阪",42\r\n"改行\r\n引用""符",100\r\n')
      },
      {
        name: "多言語.json",
        body: Buffer.from(JSON.stringify({ 日本語: "𠮷・中文・한국어・😀", value: 42 }))
      }
    ];
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-format-flow-"));
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      // A fresh, unauthenticated context: never opens the user's dedicated product profile.
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      await page.route("https://attachments.example.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<article role="article" class="fai-CopilotMessage"><div data-testid="markdown-reply">Old reply<a download="old.txt" href="blob:null/old">old.txt</a></div></article><article role="article" class="fai-CopilotMessage"><div data-testid="markdown-reply">Current attachments</div></article>'
        })
      );
      await page.goto("https://attachments.example.test/chat");
      await page.evaluate(
        (items) => {
          const replies = document.querySelectorAll('[data-testid="markdown-reply"]');
          const reply = replies[replies.length - 1]!;
          for (const item of items) {
            const link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob([new Uint8Array(item.bytes)], { type: item.mediaType }));
            link.download = item.name;
            link.textContent = item.name;
            reply.append(link, document.createElement("br"));
          }
        },
        files.map((file) => ({
          name: file.name,
          bytes: [...file.body],
          mediaType: attachmentMediaType(file.name)
        }))
      );

      const pageLike = page as unknown as PageLike;
      const extracted = await new ResponseExtractor().extract(pageLike, { assistantCount: 1 });
      expect(extracted.attachmentCandidates?.map((file) => file.name)).toEqual(
        files.map((file) => file.name)
      );
      const saved = await new AttachmentSaver({
        enabled: true,
        directory,
        maxAttachments: 20,
        timeoutMs: 5_000,
        allowedHosts: []
      }).save(pageLike, extracted.attachmentCandidates!, { workspaceKey: "formats", requestId: "one" });
      expect(saved).toHaveLength(files.length);
      for (const [index, file] of files.entries()) {
        expect(saved[index]).toMatchObject({
          name: file.name,
          status: "saved",
          sizeBytes: file.body.length,
          sha256: createHash("sha256").update(file.body).digest("hex"),
          mediaType: attachmentMediaType(file.name)
        });
        expect(await readFile(saved[index]!.localPath!)).toEqual(file.body);
      }
      const broker: FrontendBrokerPort = {
        list: async (_root, requestId) => ({
          ok: true,
          requestId,
          workspace: { configured: true, approvalStatus: "approved" },
          agents: []
        }),
        ask: async (_root, input, requestId) => ({
          ok: true,
          requestId,
          agent: input.agent,
          conversationHandle: "fixture",
          text: "Generated files",
          citations: [],
          attachments: saved,
          elapsedMs: 1,
          truncated: false,
          actionRequired: false,
          submissionState: "sent",
          sourceType: "m365-agent"
        }),
        session: async (_root, input, requestId) => ({
          ok: true,
          requestId,
          action: input.action,
          conversations: []
        })
      };
      const server = await createSdkServer(broker, () => directory, { attachmentsDirectory: directory });
      const client = new Client({ name: "format-roundtrip", version: "0.1.0" });
      try {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        for (const [index, file] of files.entries()) {
          const resource = await client.readResource({ uri: pathToFileURL(saved[index]!.localPath!).href });
          const content = resource.contents[0]!;
          const bytes =
            "blob" in content
              ? Buffer.from(content.blob as string, "base64")
              : Buffer.from(content.text as string, "utf8");
          expect(bytes).toEqual(file.body);
          expect(content.mimeType).toBe(attachmentMediaType(file.name));
        }
        // Replacing a same-name anchor after extraction must not activate a different blob.
        let downloadCount = 0;
        page.on("download", () => downloadCount++);
        await page.evaluate(() => {
          const replies = document.querySelectorAll('[data-testid="markdown-reply"]');
          replies[replies.length - 1]!.querySelector("a")!.href = URL.createObjectURL(
            new Blob(["wrong file"])
          );
        });
        const refused = await new AttachmentSaver({ enabled: true, directory, timeoutMs: 500 }).save(
          pageLike,
          [extracted.attachmentCandidates![0]!],
          { workspaceKey: "formats", requestId: "changed" }
        );
        expect(refused[0]!.status).toBe("not-saved");
        expect(downloadCount).toBe(0);
        await page.evaluate(() => {
          const replies = document.querySelectorAll('[data-testid="markdown-reply"]');
          replies[replies.length - 1]!.querySelector("a")!.href =
            "javascript:globalThis.attachmentExecuted=true";
        });
        const unsafeLink = await new ResponseExtractor().extract(pageLike, { assistantCount: 1 });
        const unsafeSaved = await new AttachmentSaver({ enabled: true, directory, timeoutMs: 500 }).save(
          pageLike,
          [unsafeLink.attachmentCandidates![0]!],
          { workspaceKey: "formats", requestId: "unsafe" }
        );
        expect(unsafeSaved[0]!.status).toBe("not-saved");
        expect(downloadCount).toBe(0);

        // Empty download attributes explicitly request a file but let the browser choose its name.
        const unnamedBytes = Buffer.from([0, 255, 254, 128, 42]);
        await page.evaluate(
          (bytes) => {
            const replies = document.querySelectorAll('[data-testid="markdown-reply"]');
            const reply = replies[replies.length - 1]!;
            const anchor = document.createElement("a");
            anchor.download = "";
            anchor.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
            anchor.textContent = "Download the result";
            reply.replaceChildren(anchor);
          },
          [...unnamedBytes]
        );
        const unnamed = await new ResponseExtractor().extract(pageLike, { assistantCount: 1 });
        let suggestedName = "";
        page.once("download", (download) => {
          suggestedName = download.suggestedFilename();
        });
        const unnamedSaved = await new AttachmentSaver({ enabled: true, directory, timeoutMs: 5_000 }).save(
          pageLike,
          unnamed.attachmentCandidates!,
          { workspaceKey: "formats", requestId: "unnamed" }
        );
        expect(unnamedSaved).toHaveLength(1);
        expect(unnamedSaved[0]).toMatchObject({ status: "saved", name: suggestedName });
        expect(suggestedName).not.toBe("");
        const unnamedResource = await client.readResource({
          uri: pathToFileURL(unnamedSaved[0]!.localPath!).href
        });
        expect(Buffer.from(unnamedResource.contents[0]!.blob as string, "base64")).toEqual(unnamedBytes);
      } finally {
        await client.close();
        await server.close();
      }
      expect(await page.evaluate(() => Reflect.get(globalThis, "attachmentExecuted"))).toBeUndefined();
      expect(context.pages()).toHaveLength(1);
      await context.close();
    } finally {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
