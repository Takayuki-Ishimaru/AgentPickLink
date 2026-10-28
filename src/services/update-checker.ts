/**
 * Host-agnostic half of the GitHub release check: fetching the releases feed, comparing SemVer
 * tags and building the release URL. No `vscode` import, so the CLI can reuse it. The VS Code
 * notification -- the "update available" toast, its localized text and opening the browser --
 * stays in `src/extension/update-checker.ts`, which imports `fetchReleases` and
 * `checkGithubUpdate` from here.
 */
import { get } from "node:https";

export const RELEASES_API =
  "https://api.github.com/repos/Takayuki-Ishimaru/AgentPickLink/releases?per_page=100";
const NOTICE_KEY = "updates.lastNotifiedTag";

type Version = { core: number[]; pre: string[] };
function parseVersion(input: string): Version | undefined {
  if (input.length > 100) return undefined;
  const match =
    /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      input
    );
  if (!match) return undefined;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((part) => /^0\d+$/.test(part))) return undefined;
  return { core: match.slice(1, 4).map(Number), pre };
}

/** SemVer ordering, including beta identifiers; build metadata does not affect precedence. */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]! ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return Number(x !== undefined) - Number(y !== undefined);
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export type UpdateChannel = "stable" | "beta";

/** Stable releases must be stable both in GitHub metadata and SemVer. */
export function releaseInChannel(
  release: { tag_name: string; prerelease?: unknown },
  channel: UpdateChannel
): boolean {
  const version = parseVersion(release.tag_name);
  return !!version && (channel === "beta" || (release.prerelease !== true && version.pre.length === 0));
}

export function newestRelease(
  value: unknown,
  installed: string,
  channel: UpdateChannel = "beta"
): { tag: string; url: string } | undefined {
  if (!Array.isArray(value) || !parseVersion(installed)) return undefined;
  let newest = installed;
  let tag: string | undefined;
  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== "object" || item.draft !== false || typeof item.tag_name !== "string")
      continue;
    if (releaseInChannel(item, channel) && compareVersions(item.tag_name, newest) === 1) {
      newest = item.tag_name;
      tag = item.tag_name;
    }
  }
  return tag
    ? {
        tag,
        url: `https://github.com/Takayuki-Ishimaru/AgentPickLink/releases/tag/${encodeURIComponent(tag)}`
      }
    : undefined;
}

export async function checkGithubUpdate(options: {
  installed: string;
  channel?: UpdateChannel;
  state: { get(key: string): unknown; update(key: string, value: string): PromiseLike<void> };
  fetchReleases: () => Promise<unknown>;
  active: () => boolean;
  notify: (tag: string) => Promise<boolean>;
  open: (url: string) => PromiseLike<unknown>;
  /** Whether the notification action is still allowed to run; defaults to `active`. */
  notifyActive?: () => boolean;
  /** False resolves as soon as the notification is shown: its action then runs detached. */
  awaitNotification?: boolean;
}): Promise<void> {
  if (!options.active()) return;
  const release = newestRelease(await options.fetchReleases(), options.installed, options.channel);
  if (!options.active() || !release || options.state.get(NOTICE_KEY) === release.tag) return;
  await options.state.update(NOTICE_KEY, release.tag);
  if (!options.active()) return;
  const live = options.notifyActive ?? options.active;
  const act = async (): Promise<void> => {
    const open = await options.notify(release.tag);
    if (open && live()) await options.open(release.url);
  };
  if (options.awaitNotification === false) {
    // A notice can sit in the notification center for hours; its action must neither hold the
    // caller's scheduler nor surface a rejection nobody is awaiting.
    void act().catch(() => {});
    return;
  }
  await act();
}

export function fetchReleases(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // No credentials, workspace paths, account information or agent content are included
    // in this public metadata request.
    const request = get(
      RELEASES_API,
      {
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "AgentPickLink",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error("update-http-failed"));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) request.destroy(new Error("update-response-too-large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("update-response-invalid"));
          }
        });
      }
    );
    const timer = setTimeout(() => request.destroy(new Error("update-timeout")), 8_000);
    timer.unref?.();
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
  });
}
