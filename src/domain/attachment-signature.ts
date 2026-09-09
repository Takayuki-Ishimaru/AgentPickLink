import { inflateRawSync } from "node:zlib";

/** Bounded format hints, not content validation. No file is executed or extracted to disk.
 * Text formats and ambiguous containers need a filename or MIME supplied by the source. */
export function attachmentSignatureExtension(body: Buffer): string | undefined {
  const starts = (hex: string) => body.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  const text = (start: number, end: number) => body.toString("latin1", start, Math.min(end, body.length));
  if (/^%PDF-\d\.\d(?:\r|\n)/.test(text(0, 10))) return ".pdf";
  if (starts("89504e470d0a1a0a")) return ".png";
  if (starts("ffd8ff")) return ".jpg";
  if (/^GIF8[79]a$/.test(text(0, 6))) return ".gif";
  if (starts("49492a00") || starts("4d4d002a")) return ".tif";
  if (body.length >= 6 && starts("00000100") && body.readUInt16LE(4) > 0) return ".ico";
  if (body.length >= 26 && text(0, 2) === "BM" && body.readUInt32LE(10) >= 26) return ".bmp";
  if (body.length >= 12 && text(0, 4) === "RIFF") {
    if (text(8, 12) === "WEBP") return ".webp";
    if (text(8, 12) === "WAVE") return ".wav";
    if (text(8, 12) === "AVI ") return ".avi";
  }
  if (starts("664c6143")) return ".flac";
  if (body.length >= 27 && text(0, 5) === "OggS\0") return ".ogg";
  if (body.length >= 10 && text(0, 3) === "ID3" && body[3]! >= 2 && body[3]! <= 4) return ".mp3";
  if (body.length >= 16 && text(4, 8) === "ftyp") {
    const size = body.readUInt32BE(0);
    if (size >= 16 && size <= body.length && size <= 4096 && size % 4 === 0) {
      const brands = [text(8, 12)];
      for (let offset = 16; offset < size; offset += 4) brands.push(text(offset, offset + 4));
      if (brands.some((brand) => ["avif", "avis"].includes(brand))) return ".avif";
      if (brands.some((brand) => ["heic", "heix", "hevc", "hevx"].includes(brand))) return ".heic";
      if (brands.some((brand) => ["M4A ", "M4B "].includes(brand))) return ".m4a";
      if (brands.includes("qt  ")) return ".mov";
      if (brands.some((brand) => ["isom", "iso2", "mp41", "mp42", "M4V "].includes(brand))) return ".mp4";
    }
  }
  if (
    starts("1a45dfa3") &&
    body.subarray(4, 256).includes(Buffer.from([0x42, 0x82, 0x84, ...Buffer.from("webm")]))
  )
    return ".webm";
  if (body.length >= 10 && starts("1f8b08")) return ".gz";
  if (starts("377abcaf271c")) return ".7z";
  if (starts("526172211a0700") || starts("526172211a070100")) return ".rar";
  if (body.length >= 512 && text(257, 262) === "ustar") return ".tar";
  if (/^\{\\rtf[1-9][0-9]*[\\\s]/.test(text(0, 32))) return ".rtf";
  if (starts("d0cf11e0a1b11ae1")) return compoundDocumentExtension(body);
  if (starts("504b0304") || starts("504b0506")) return zipExtension(body);
  return undefined;
}

/** Legacy Office formats share an OLE header. Inspect bounded directory records, not a raw
 * substring search. Encrypted OOXML packages cannot be identified without decrypting them. */
function compoundDocumentExtension(body: Buffer): string | undefined {
  if (body.length < 512 || body.readUInt16LE(28) !== 0xfffe) return undefined;
  const shift = body.readUInt16LE(30);
  if (shift !== 9 && shift !== 12) return undefined;
  const sectorSize = 2 ** shift;
  let sector = body.readUInt32LE(48);
  const visited = new Set<number>();
  const extensions = new Set<string>();
  let encrypted = false;
  for (let count = 0; count < 128; count++) {
    if (sector === 0xfffffffe) return !encrypted && extensions.size === 1 ? [...extensions][0] : undefined;
    const start = (sector + 1) * sectorSize;
    if (visited.has(sector) || start + sectorSize > body.length) return undefined;
    visited.add(sector);
    for (let offset = start; offset < start + sectorSize; offset += 128) {
      const length = body.readUInt16LE(offset + 64);
      if (body[offset + 66] !== 2 || length < 2 || length > 64 || length % 2) continue;
      const name = body.toString("utf16le", offset, offset + length - 2);
      if (name === "EncryptedPackage") encrypted = true;
      if (name === "WordDocument") extensions.add(".doc");
      if (name === "Workbook" || name === "Book") extensions.add(".xls");
      if (name === "PowerPoint Document") extensions.add(".ppt");
    }
    const fatIndex = Math.floor(sector / (sectorSize / 4));
    // Large files using an extended DIFAT need source-provided metadata instead of an unbounded walk.
    if (fatIndex >= 109) return undefined;
    const fatSector = body.readUInt32LE(76 + fatIndex * 4);
    const pointer = (fatSector + 1) * sectorSize + (sector % (sectorSize / 4)) * 4;
    if (pointer + 4 > body.length) return undefined;
    sector = body.readUInt32LE(pointer);
  }
  return undefined;
}

type ZipEntry = { name: string; offset: number; size: number; method: number; flags: number };
const METADATA_LIMIT = 64 * 1024;

/** Read only a bounded central directory and at most two small metadata entries. ZIP64,
 * encrypted, malformed and ambiguous packages retain the generic ZIP type. See PKWARE APPNOTE. */
function zipExtension(body: Buffer): string {
  const entries = zipEntries(body);
  if (!entries) return ".zip";
  const metadata = (name: string): string | undefined => {
    const entry = entries.find((item) => item.name === name);
    if (!entry || entry.size > METADATA_LIMIT || entry.flags & 1) return undefined;
    const offset = entry.offset;
    if (offset + 30 > body.length || body.readUInt32LE(offset) !== 0x04034b50) return undefined;
    if (body.readUInt16LE(offset + 6) & 1 || body.readUInt16LE(offset + 8) !== entry.method) return undefined;
    const nameLength = body.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + body.readUInt16LE(offset + 28);
    if (
      start + entry.size > body.length ||
      body.toString("utf8", offset + 30, offset + 30 + nameLength) !== name
    )
      return undefined;
    const data = body.subarray(start, start + entry.size);
    try {
      if (entry.method === 0) return data.toString("utf8");
      if (entry.method === 8)
        return inflateRawSync(data, { maxOutputLength: METADATA_LIMIT }).toString("utf8");
    } catch {
      // A format hint must never make saving or reading a file fail.
    }
    return undefined;
  };
  const mime = metadata("mimetype");
  const openDocument: Record<string, string> = {
    "application/vnd.oasis.opendocument.text": ".odt",
    "application/vnd.oasis.opendocument.spreadsheet": ".ods",
    "application/vnd.oasis.opendocument.presentation": ".odp",
    "application/epub+zip": ".epub"
  };
  if (mime && openDocument[mime]) return openDocument[mime]!;
  const types = metadata("[Content_Types].xml");
  if (!types || !entries.some((entry) => entry.name === "_rels/.rels")) return ".zip";
  // Match the main part's declared content type, not just a word/xl/ppt folder. In particular,
  // macro-enabled documents and templates must not be mislabeled as DOCX/XLSX/PPTX.
  const mainTypes: [string, string, string][] = [
    [
      "word/document.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      ".docx"
    ],
    ["word/document.xml", "application/vnd.ms-word.document.macroEnabled.main+xml", ".docm"],
    [
      "word/document.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
      ".dotx"
    ],
    ["word/document.xml", "application/vnd.ms-word.template.macroEnabledTemplate.main+xml", ".dotm"],
    [
      "xl/workbook.xml",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
      ".xlsx"
    ],
    ["xl/workbook.xml", "application/vnd.ms-excel.sheet.macroEnabled.main+xml", ".xlsm"],
    ["xl/workbook.bin", "application/vnd.ms-excel.sheet.binary.macroEnabled.main", ".xlsb"],
    [
      "xl/workbook.xml",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
      ".xltx"
    ],
    ["xl/workbook.xml", "application/vnd.ms-excel.template.macroEnabled.main+xml", ".xltm"],
    [
      "ppt/presentation.xml",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
      ".pptx"
    ],
    ["ppt/presentation.xml", "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml", ".pptm"],
    [
      "ppt/presentation.xml",
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
      ".ppsx"
    ],
    ["ppt/presentation.xml", "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml", ".ppsm"],
    [
      "ppt/presentation.xml",
      "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
      ".potx"
    ],
    ["ppt/presentation.xml", "application/vnd.ms-powerpoint.template.macroEnabled.main+xml", ".potm"]
  ];
  const matches = new Set<string>();
  // No XML entities, DTD processing or external resources. Unsupported declarations stay ZIP.
  const cleanTypes = types.replace(/<!--[\s\S]*?-->/g, "");
  for (const match of cleanTypes.matchAll(/<(?:[\w.-]+:)?Override\s+([^<>]+)\/?>/g)) {
    const attributes = match[1]!;
    const part = attributes.match(/\bPartName\s*=\s*["']([^"']+)["']/)?.[1];
    const type = attributes.match(/\bContentType\s*=\s*["']([^"']+)["']/)?.[1];
    for (const [file, contentType, extension] of mainTypes) {
      if (part === `/${file}` && type === contentType && entries.some((entry) => entry.name === file))
        matches.add(extension);
    }
  }
  return matches.size === 1 ? [...matches][0]! : ".zip";
}

function zipEntries(body: Buffer): ZipEntry[] | undefined {
  for (let end = body.length - 22; end >= Math.max(0, body.length - 22 - 0xffff); end--) {
    if (body.readUInt32LE(end) !== 0x06054b50 || end + 22 + body.readUInt16LE(end + 20) !== body.length)
      continue;
    if (body.readUInt16LE(end + 4) !== 0 || body.readUInt16LE(end + 6) !== 0) return undefined;
    const count = body.readUInt16LE(end + 10);
    const size = body.readUInt32LE(end + 12);
    const start = body.readUInt32LE(end + 16);
    if (count > 4096 || count !== body.readUInt16LE(end + 8) || size > 1024 * 1024 || start + size !== end)
      return undefined;
    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    let cursor = start;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || body.readUInt32LE(cursor) !== 0x02014b50) return undefined;
      const nameLength = body.readUInt16LE(cursor + 28);
      const next = cursor + 46 + nameLength + body.readUInt16LE(cursor + 30) + body.readUInt16LE(cursor + 32);
      if (next > end || body.readUInt16LE(cursor + 34) !== 0) return undefined;
      const name = body.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      if (names.has(name)) return undefined;
      names.add(name);
      entries.push({
        name,
        offset: body.readUInt32LE(cursor + 42),
        size: body.readUInt32LE(cursor + 20),
        method: body.readUInt16LE(cursor + 10),
        flags: body.readUInt16LE(cursor + 8)
      });
      cursor = next;
    }
    return cursor === end ? entries : undefined;
  }
  return undefined;
}
