import { deflateRawSync } from "node:zlib";

export function compoundDocumentFixture(names: string[]): Buffer {
  const body = Buffer.alloc(1536);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(body);
  body.writeUInt16LE(3, 26);
  body.writeUInt16LE(0xfffe, 28);
  body.writeUInt16LE(9, 30);
  body.writeUInt16LE(6, 32);
  body.writeUInt32LE(1, 44);
  body.writeUInt32LE(0, 48);
  body.fill(0xff, 76, 512);
  body.writeUInt32LE(1, 76);
  for (const [index, name] of names.entries()) {
    const offset = 512 + index * 128;
    Buffer.from(name + "\0", "utf16le").copy(body, offset);
    body.writeUInt16LE((name.length + 1) * 2, offset + 64);
    body[offset + 66] = 2;
  }
  body.fill(0xff, 1024);
  body.writeUInt32LE(0xfffffffe, 1024);
  body.writeUInt32LE(0xfffffffd, 1028);
  return body;
}

/** Small ZIP fixtures with real local headers, central directory and checksums. */
export function zipFixture(
  entries: { name: string; body: Buffer; deflate?: boolean; flags?: number }[]
): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = entry.deflate ? deflateRawSync(entry.body) : entry.body;
    let crc = 0xffffffff;
    for (const byte of entry.body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, bytes);
    directory.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

export function officeFixture(part: string, type: string, deflate = true): Buffer {
  return zipFixture([
    { name: "padding", body: Buffer.alloc(8192) },
    { name: "_rels/.rels", body: Buffer.from("<Relationships/>") },
    { name: part, body: Buffer.from("<fixture/>") },
    {
      name: "[Content_Types].xml",
      body: Buffer.from(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override ContentType="${type}" PartName="/${part}"/></Types>`
      ),
      deflate
    }
  ]);
}

/** Format/transport fixtures, not documents suitable for layout or playback verification. */
export function attachmentFixtures(): { extension: string; mediaType: string; body: Buffer }[] {
  const office = [
    [
      "docx",
      "word/document.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    ],
    [
      "xlsx",
      "xl/workbook.xml",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
    ],
    [
      "pptx",
      "ppt/presentation.xml",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
    ],
    [
      "docm",
      "word/document.xml",
      "application/vnd.ms-word.document.macroenabled.12",
      "application/vnd.ms-word.document.macroEnabled.main+xml"
    ],
    [
      "xlsm",
      "xl/workbook.xml",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
    ],
    [
      "pptm",
      "ppt/presentation.xml",
      "application/vnd.ms-powerpoint.presentation.macroenabled.12",
      "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"
    ]
  ];
  const openDocument = [
    ["odt", "application/vnd.oasis.opendocument.text"],
    ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
    ["odp", "application/vnd.oasis.opendocument.presentation"],
    ["epub", "application/epub+zip"]
  ];
  const ftyp = (brand: string) =>
    Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from(`ftyp${brand}`), Buffer.alloc(4)]);
  return [
    { extension: "doc", mediaType: "application/msword", body: compoundDocumentFixture(["WordDocument"]) },
    { extension: "xls", mediaType: "application/vnd.ms-excel", body: compoundDocumentFixture(["Workbook"]) },
    {
      extension: "ppt",
      mediaType: "application/vnd.ms-powerpoint",
      body: compoundDocumentFixture(["PowerPoint Document"])
    },
    ...office.map(([extension, part, mediaType, type]) => ({
      extension,
      mediaType,
      body: officeFixture(part, type)
    })),
    ...openDocument.map(([extension, mediaType]) => ({
      extension,
      mediaType,
      body: zipFixture([{ name: "mimetype", body: Buffer.from(mediaType) }])
    })),
    { extension: "pdf", mediaType: "application/pdf", body: Buffer.from("%PDF-1.3\nfixture") },
    {
      extension: "png",
      mediaType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64"
      )
    },
    {
      extension: "jpg",
      mediaType: "image/jpeg",
      body: Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex")
    },
    { extension: "gif", mediaType: "image/gif", body: Buffer.from("GIF89a\x01\0\x01\0\0\0\0;") },
    { extension: "webp", mediaType: "image/webp", body: Buffer.from("RIFF\x04\0\0\0WEBP") },
    { extension: "tif", mediaType: "image/tiff", body: Buffer.from("49492a00080000000000", "hex") },
    { extension: "wav", mediaType: "audio/wav", body: Buffer.from("RIFF\x04\0\0\0WAVE") },
    { extension: "flac", mediaType: "audio/flac", body: Buffer.from("fLaC\0\0\0\0") },
    { extension: "mp3", mediaType: "audio/mpeg", body: Buffer.from("ID3\x04\0\0\0\0\0\0") },
    { extension: "mp4", mediaType: "video/mp4", body: ftyp("mp42") },
    { extension: "m4a", mediaType: "audio/mp4", body: ftyp("M4A ") },
    { extension: "mov", mediaType: "video/quicktime", body: ftyp("qt  ") },
    { extension: "avif", mediaType: "image/avif", body: ftyp("avif") },
    { extension: "heic", mediaType: "image/heic", body: ftyp("heic") },
    {
      extension: "zip",
      mediaType: "application/zip",
      body: zipFixture([{ name: "日本語.txt", body: Buffer.from("日本語") }])
    },
    { extension: "gz", mediaType: "application/gzip", body: Buffer.from("1f8b0800000000000003", "hex") },
    {
      extension: "7z",
      mediaType: "application/x-7z-compressed",
      body: Buffer.from("377abcaf271c0004", "hex")
    },
    { extension: "rar", mediaType: "application/vnd.rar", body: Buffer.from("526172211a070100", "hex") },
    { extension: "rtf", mediaType: "application/rtf", body: Buffer.from("{\\rtf1\\ansi fixture}") }
  ];
}
