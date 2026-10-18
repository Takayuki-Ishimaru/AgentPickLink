import { createHash } from "node:crypto";
import { get } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { compareVersions } from "./update-checker.js";

export type ExtensionRelease = { tag: string; name: string; url: string; sha256: string; size: number };
export const MAX_VSIX_BYTES = 64 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_BASE = "https://github.com/Takayuki-Ishimaru/AgentPickLink/releases/download/";
const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com"
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Prefer the newest published version with an uploaded universal VSIX and a SHA-256 digest. */
export function newestExtensionRelease(feed: unknown, installed: string): ExtensionRelease | undefined {
  if (!Array.isArray(feed) || compareVersions(installed, installed) === undefined) return undefined;
  let result: ExtensionRelease | undefined;
  for (const value of feed.slice(0, 100)) {
    const release = record(value);
    if (!release || release.draft !== false || typeof release.tag_name !== "string") continue;
    const tag = release.tag_name;
    if (compareVersions(tag, result?.tag ?? installed) !== 1 || !Array.isArray(release.assets)) continue;
    const name = `agent-pick-link-${tag.replace(/^v/, "")}.vsix`;
    for (const value of release.assets.slice(0, 100)) {
      const asset = record(value);
      if (
        !asset ||
        asset.name !== name ||
        asset.state !== "uploaded" ||
        typeof asset.size !== "number" ||
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0 ||
        asset.size > MAX_VSIX_BYTES ||
        typeof asset.digest !== "string" ||
        !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest)
      )
        continue;
      result = {
        tag,
        name,
        size: asset.size,
        sha256: asset.digest.slice(7).toLowerCase(),
        url: `${DOWNLOAD_BASE}${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
      };
      break;
    }
  }
  return result;
}

function downloadUrl(input: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !DOWNLOAD_HOSTS.has(url.hostname)
  )
    throw new Error("update-download-url");
  return url;
}

/** No credentials; one deadline and AbortSignal cover the whole redirect chain and body. */
export function downloadExtensionRelease(release: ExtensionRelease, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    const finish = (error?: Error, bytes?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else resolve(bytes!);
    };
    const abort = () => finish(new Error("update-download-aborted"));
    const timer = setTimeout(() => finish(new Error("update-download-timeout")), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    const visit = (input: string, redirects: number): void => {
      if (settled) return;
      try {
        const url = downloadUrl(input);
        request = get(url, { signal, headers: { "User-Agent": "AgentPickLink" } }, (res) => {
          if (settled) {
            res.resume();
            return;
          }
          response = res;
          res.on("error", (error) => finish(error));
          res.on("aborted", () => finish(new Error("update-download-truncated")));
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
            res.resume();
            if (!res.headers.location || redirects >= 5) {
              finish(new Error("update-download-redirect"));
              return;
            }
            try {
              visit(new URL(res.headers.location, url).href, redirects + 1);
            } catch {
              finish(new Error("update-download-url"));
            }
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            finish(new Error("update-download-http"));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_VSIX_BYTES || size > release.size) finish(new Error("update-download-size"));
            else chunks.push(chunk);
          });
          let ended = false;
          res.on("end", () => {
            ended = true;
            if (settled) return;
            const bytes = Buffer.concat(chunks);
            if (size !== release.size) finish(new Error("update-download-size"));
            else if (createHash("sha256").update(bytes).digest("hex") !== release.sha256)
              finish(new Error("update-download-digest"));
            else finish(undefined, bytes);
          });
          res.on("close", () => {
            if (!ended) finish(new Error("update-download-truncated"));
          });
        });
        request.on("error", (error) => finish(error));
      } catch {
        finish(new Error("update-download-url"));
      }
    };
    if (signal.aborted) {
      abort();
      return;
    }
    if (
      !Number.isSafeInteger(release.size) ||
      release.size <= 0 ||
      release.size > MAX_VSIX_BYTES ||
      !/^[a-f0-9]{64}$/.test(release.sha256)
    ) {
      finish(new Error("update-download-metadata"));
      return;
    }
    visit(release.url, 0);
  });
}
