import path from "node:path";
import { attachmentSignatureExtension } from "./attachment-signature.js";

// These names describe content; they are not a list of permitted file formats. Unknown files
// retain their filename and bytes and are served as application/octet-stream.
const MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docm": "application/vnd.ms-word.document.macroenabled.12",
  ".dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  ".dotm": "application/vnd.ms-word.template.macroenabled.12",
  ".xlsm": "application/vnd.ms-excel.sheet.macroenabled.12",
  ".xlsb": "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  ".xltx": "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ".xltm": "application/vnd.ms-excel.template.macroenabled.12",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  ".ppsx": "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ".ppsm": "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
  ".potx": "application/vnd.openxmlformats-officedocument.presentationml.template",
  ".potm": "application/vnd.ms-powerpoint.template.macroenabled.12",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".epub": "application/epub+zip",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".rtf": "application/rtf",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".xhtml": "application/xhtml+xml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/vnd.microsoft.icon",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar"
};

export function attachmentMediaType(filename: string, body?: Buffer): string {
  const extension = path.extname(filename).toLowerCase();
  // Recover metadata for extensionless files, including downloads made before this fix.
  const detectedExtension = !extension && body ? attachmentSignatureExtension(body) : undefined;
  return MEDIA_TYPES[detectedExtension ?? extension] ?? "application/octet-stream";
}

const MEDIA_TYPE_ALIASES: Record<string, string> = {
  "binary/octet-stream": "application/octet-stream",
  "application/binary": "application/octet-stream",
  "application/download": "application/octet-stream",
  "application/x-download": "application/octet-stream",
  "application/force-download": "application/octet-stream",
  "application/x-pdf": "application/pdf",
  "application/x-zip-compressed": "application/zip",
  "application/x-gzip": "application/gzip",
  "application/x-rar-compressed": "application/vnd.rar",
  "application/x-7z": "application/x-7z-compressed",
  "image/jpg": "image/jpeg",
  "image/x-png": "image/png",
  "image/x-icon": "image/vnd.microsoft.icon",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-flac": "audio/flac",
  "text/rtf": "application/rtf",
  "text/xml": "application/xml",
  "text/x-markdown": "text/markdown",
  "text/yaml": "application/yaml",
  "text/x-yaml": "application/yaml",
  "application/x-yaml": "application/yaml",
  "application/javascript": "text/javascript",
  "application/csv": "text/csv"
};

export function canonicalAttachmentMediaType(value: string | undefined): string | undefined {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType ? (MEDIA_TYPE_ALIASES[mediaType] ?? mediaType) : undefined;
}

/** Preferred suffix when the response provides no filename or omits a format-specific extension. */
export function extensionForAttachmentMediaType(value: string | undefined): string {
  const mediaType = canonicalAttachmentMediaType(value);
  return Object.entries(MEDIA_TYPES).find(([, type]) => type === mediaType)?.[0] ?? ".bin";
}
