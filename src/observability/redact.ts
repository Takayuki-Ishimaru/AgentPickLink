const FORBIDDEN_KEYS =
  /prompt|message|response|body|html|cookie|token|authorization|password|secret|workspaceRoot|profilePath/i;

/** Allow-list diagnostic metadata and reject body-like fields by construction. */
export function redactMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(value, 0);
}

export function sanitizedUrlPattern(value: string | undefined): {
  hostname?: string;
  sanitizedPathPattern?: string;
} {
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      hostname: url.hostname.toLocaleLowerCase(),
      sanitizedPathPattern: url.pathname.replace(/[A-Fa-f0-9]{16,}|\d{6,}/g, ":id")
    };
  } catch {
    return {};
  }
}

function sanitizeObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 3) return {};
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) continue;
    const safe = sanitizeValue(item, depth + 1);
    if (safe !== OMIT) entries.push([key, safe]);
  }
  return Object.fromEntries(entries);
}
const OMIT = Symbol("omit");
function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === undefined || value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 512) return value;
  if (Array.isArray(value) && value.length <= 100) {
    const items = value.map((item) => sanitizeValue(item, depth)).filter((item) => item !== OMIT);
    return items.length === value.length ? items : OMIT;
  }
  if (value && typeof value === "object" && !Array.isArray(value))
    return sanitizeObject(value as Record<string, unknown>, depth);
  return OMIT;
}
