import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendBrokerPort } from "../../src/frontend/broker-port.js";
import { createSdkServer } from "../../src/frontend/mcp-server.js";
import { attachmentFixtures } from "../helpers/attachment-fixtures.js";

const minimalBroker: FrontendBrokerPort = {
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
    conversationHandle: "conv_x",
    text: "answer",
    citations: [],
    attachments: [],
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

/** §H4(b): the attachments resource must refuse both a symlink planted inside the attachments
 * directory (even one whose target sits outside it) and a file over the configured size cap --
 * without ever distinguishing either refusal from a plain "not found" (see readAttachmentResource
 * in src/frontend/mcp-server.ts). */
describe("attachment resource containment", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function connect(attachmentsDirectory: string, maxAttachmentReadBytes?: number) {
    const server = await createSdkServer(minimalBroker, () => "C:\\workspace", {
      attachmentsDirectory,
      maxAttachmentReadBytes
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(
      () => client.close(),
      () => server.close()
    );
    return client;
  }

  it("rejects a symlink inside the attachments directory even when its target sits outside it", async () => {
    const attachmentsDirectory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-symlink-"));
    const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "apl-outside-symlink-"));
    const outsideSecret = path.join(outsideDirectory, "secret.txt");
    await writeFile(outsideSecret, "outside the attachments directory", "utf8");
    const linkPath = path.join(attachmentsDirectory, "planted-link.txt");
    await symlink(outsideSecret, linkPath);

    try {
      const client = await connect(attachmentsDirectory);
      await expect(client.readResource({ uri: pathToFileURL(linkPath).href })).rejects.toThrow();
    } finally {
      await rm(attachmentsDirectory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an attachments directory that is itself a symlink", async () => {
    const realDirectory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-real-"));
    const linkedDirectory = path.join(os.tmpdir(), `apl-attachments-link-${Date.now()}`);
    await symlink(realDirectory, linkedDirectory, "dir");
    const filePath = path.join(linkedDirectory, "result.txt");
    await writeFile(path.join(realDirectory, "result.txt"), "secret", "utf8");

    try {
      const client = await connect(linkedDirectory);
      await expect(client.readResource({ uri: pathToFileURL(filePath).href })).rejects.toThrow();
    } finally {
      await rm(linkedDirectory, { force: true });
      await rm(realDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a file over the configured size cap", async () => {
    const attachmentsDirectory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-oversize-"));
    const bigPath = path.join(attachmentsDirectory, "big.txt");
    await writeFile(bigPath, "x".repeat(64), "utf8");

    try {
      // A tiny cap so the fixture does not need to actually be huge.
      const client = await connect(attachmentsDirectory, 16);
      await expect(client.readResource({ uri: pathToFileURL(bigPath).href })).rejects.toThrow();

      // The same file is readable once the cap is not exceeded, confirming the rejection above was
      // actually about size and not some other containment failure.
      const permissive = await connect(attachmentsDirectory, 1024);
      await expect(permissive.readResource({ uri: pathToFileURL(bigPath).href })).resolves.toMatchObject({
        contents: [{ text: "x".repeat(64) }]
      });
    } finally {
      await rm(attachmentsDirectory, { recursive: true, force: true });
    }
  });

  it("returns attachment bytes exactly and only decodes safe, valid UTF-8 text", async () => {
    const attachmentsDirectory = await mkdtemp(path.join(os.tmpdir(), "apl-attachments-media-"));
    const fixtures = [
      ...attachmentFixtures().map(({ body, mediaType }, index) => ({
        name: `legacy-${index}`,
        bytes: body,
        expected: { mimeType: mediaType, blob: true }
      })),
      {
        name: "attachment-1",
        bytes: Buffer.from("%PDF-1.3\nlegacy extensionless PDF\0\xff"),
        expected: { mimeType: "application/pdf", blob: true }
      },
      {
        name: "image.png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
        expected: { mimeType: "image/png", blob: true }
      },
      {
        name: "opaque",
        bytes: Buffer.from([0x00, 0x80, 0xff, 0x01]),
        expected: { mimeType: "application/octet-stream", blob: true }
      },
      {
        name: "invalid.txt",
        bytes: Buffer.from([0x66, 0x6f, 0x80, 0x6f]),
        expected: { mimeType: "text/plain", blob: true }
      },
      {
        name: "invalid.csv",
        bytes: Buffer.from([0x61, 0x2c, 0xc3, 0x28]),
        expected: { mimeType: "text/csv", blob: true }
      },
      {
        name: "utf16.txt",
        bytes: Buffer.from([0xff, 0xfe, 0x61, 0x00]),
        expected: { mimeType: "text/plain", blob: true }
      },
      {
        name: "utf8-bom.txt",
        bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")]),
        expected: { mimeType: "text/plain", text: "\uFEFFhello" }
      },
      {
        name: "page.html",
        bytes: Buffer.from("<script>doNotRun()</script>", "utf8"),
        expected: { mimeType: "text/html", blob: true }
      },
      {
        name: "vector.svg",
        bytes: Buffer.from("<svg><script>doNotRun()</script></svg>", "utf8"),
        expected: { mimeType: "image/svg+xml", blob: true }
      }
    ] as const;

    try {
      for (const fixture of fixtures)
        await writeFile(path.join(attachmentsDirectory, fixture.name), fixture.bytes);
      const client = await connect(attachmentsDirectory);
      for (const fixture of fixtures) {
        const result = await client.readResource({
          uri: pathToFileURL(path.join(attachmentsDirectory, fixture.name)).href
        });
        expect(result.contents[0]).toMatchObject({ mimeType: fixture.expected.mimeType });
        if ("text" in fixture.expected) {
          expect(result.contents[0]).toMatchObject({ text: fixture.expected.text });
          expect(result.contents[0]).not.toHaveProperty("blob");
        } else {
          expect(result.contents[0]).toMatchObject({ blob: fixture.bytes.toString("base64") });
          expect(result.contents[0]).not.toHaveProperty("text");
        }
      }
    } finally {
      await rm(attachmentsDirectory, { recursive: true, force: true });
    }
  });
});
