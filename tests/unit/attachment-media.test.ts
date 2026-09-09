import { describe, expect, it } from "vitest";
import {
  attachmentMediaType,
  canonicalAttachmentMediaType,
  extensionForAttachmentMediaType
} from "../../src/domain/attachment-media.js";
import {
  attachmentFixtures,
  compoundDocumentFixture,
  officeFixture,
  zipFixture
} from "../helpers/attachment-fixtures.js";

describe("attachment format recovery", () => {
  it("does not guess encrypted or ambiguous OLE containers and bounds cyclic directory chains", () => {
    for (const names of [
      ["EncryptedPackage"],
      ["WordDocument", "EncryptedPackage"],
      ["WordDocument", "Workbook"]
    ])
      expect(attachmentMediaType("download", compoundDocumentFixture(names))).toBe(
        "application/octet-stream"
      );
    const cyclic = compoundDocumentFixture(["WordDocument"]);
    cyclic.writeUInt32LE(0, 1024);
    expect(attachmentMediaType("download", cyclic)).toBe("application/octet-stream");
  });
  it.each(attachmentFixtures())(
    "detects extensionless $extension from bytes",
    ({ body, extension, mediaType }) => {
      expect(attachmentMediaType("download", body)).toBe(mediaType);
      expect(extensionForAttachmentMediaType(mediaType)).toBe(`.${extension}`);
      expect(attachmentMediaType("original.custom", body)).toBe("application/octet-stream");
    }
  );
  it.each([
    ["Application/X-Zip-Compressed; charset=binary", "application/zip", ".zip"],
    ["image/jpg", "image/jpeg", ".jpg"],
    ["audio/x-wav", "audio/wav", ".wav"],
    ["text/x-markdown", "text/markdown", ".md"],
    ["text/xml", "application/xml", ".xml"],
    ["application/x-yaml", "application/yaml", ".yaml"]
  ])("normalizes MIME alias %s", (value, mediaType, extension) => {
    expect(canonicalAttachmentMediaType(value)).toBe(mediaType);
    expect(extensionForAttachmentMediaType(value)).toBe(extension);
  });
  it.each(["", "a,b\n1,2", '{"value":42}', "<svg/>", "# title", "value: 42"])(
    "does not guess an ambiguous text format: %s",
    (text) => {
      expect(attachmentMediaType("download", Buffer.from(text))).toBe("application/octet-stream");
    }
  );
  it("does not mistake a ZIP with Office-looking paths for an Office file", () => {
    const body = zipFixture([{ name: "word/document.xml", body: Buffer.from("not an Office package") }]);
    expect(attachmentMediaType("download", body)).toBe("application/zip");
  });
  it("handles stored metadata and preserves macro-enabled template types", () => {
    const body = officeFixture(
      "word/document.xml",
      "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
      false
    );
    expect(attachmentMediaType("download", body)).toBe("application/vnd.ms-word.template.macroenabled.12");
  });
  it("bounds metadata decompression and rejects ambiguous or encrypted metadata", () => {
    for (const entries of [
      [{ name: "[Content_Types].xml", body: Buffer.alloc(2 * 1024 * 1024, 65), deflate: true }],
      [{ name: "mimetype", body: Buffer.from("application/epub+zip"), flags: 1 }],
      [
        { name: "mimetype", body: Buffer.from("application/epub+zip") },
        { name: "mimetype", body: Buffer.from("application/vnd.oasis.opendocument.text") }
      ]
    ])
      expect(attachmentMediaType("download", zipFixture(entries))).toBe("application/zip");
  });
  it("never throws for truncated inputs or damaged ZIP offsets", () => {
    for (const { body } of attachmentFixtures()) {
      for (const length of [0, 1, 2, 4, 8, 16, 22, body.length - 1])
        expect(() => attachmentMediaType("download", body.subarray(0, Math.max(0, length)))).not.toThrow();
    }
    const zip = zipFixture([{ name: "mimetype", body: Buffer.from("application/epub+zip") }]);
    zip.writeUInt32LE(0xffffffff, zip.length - 6);
    expect(attachmentMediaType("download", zip)).toBe("application/zip");
  });
});
