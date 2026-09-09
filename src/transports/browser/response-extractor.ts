import { htmlToMarkdown } from "./markdown-converter.js";
import { RESPONSE_SELECTORS } from "./selectors/common.js";
import {
  BrowserTransportError,
  type AttachmentCandidate,
  type AgentCitation,
  type ExtractedResponse,
  type PageLike,
  type ResponseMarker,
  type Surface
} from "./types.js";

import { HostAllowlist } from "../../domain/host-pattern.js";
import {
  attachmentNameFromLabel,
  filenameFromAttachmentUrl,
  isGenericAttachmentName
} from "../../domain/attachment-filename.js";

export interface ResponseExtractorOptions {
  maxCodePoints?: number;
  citationUrl?: (url: string) => string | undefined;
  attachmentHosts?: string[];
}
export class ResponseExtractor {
  private readonly maxCodePoints: number;
  private readonly citationUrl?: (url: string) => string | undefined;
  private readonly attachmentHosts: HostAllowlist;
  constructor(options: ResponseExtractorOptions = {}) {
    this.maxCodePoints = options.maxCodePoints ?? 50_000;
    this.citationUrl = options.citationUrl;
    this.attachmentHosts = new HostAllowlist(options.attachmentHosts ?? []);
  }
  async extract(page: PageLike, marker: ResponseMarker, _surface?: Surface): Promise<ExtractedResponse> {
    let payload: any;
    try {
      if (page.evaluate)
        payload = await page.evaluate(
          (args: { marker: ResponseMarker; selector: string }) => {
            const nodes = Array.from(document.querySelectorAll(args.selector)) as HTMLElement[];
            const node = nodes[nodes.length - 1];
            if (!node) return { html: "", citations: [], actionRequired: false };
            // M365 nests the textual markdown reply inside the assistant article but renders a
            // generated-file card as its sibling. Keep `node` for response text isolation while
            // using the enclosing assistant article for attachment controls.
            const attachmentRoot = node.closest('[role="article"].fai-CopilotMessage') || node;
            const citations = Array.from(node.querySelectorAll("a[href]")).map((el, i) => {
              const a = el as HTMLAnchorElement;
              return { index: i + 1, title: a.textContent?.trim() || undefined, url: a.href };
            });
            const downloadControls = Array.from(attachmentRoot.querySelectorAll('button, [role="button"], a'))
              .filter((element) => {
                const hasDownloadAttribute = element.matches("a[download]");
                const signal = [
                  element.getAttribute("aria-label"),
                  element.getAttribute("title"),
                  element.getAttribute("data-testid"),
                  element.getAttribute("data-icon-name"),
                  element.getAttribute("download"),
                  hasDownloadAttribute ? "download" : "",
                  element.textContent,
                  element.innerHTML.slice(0, 2_000)
                ]
                  .filter(Boolean)
                  .join(" ");
                return /(?:^|[\s_:-])download(?:[\s_:-]|$)|ダウンロード/i.test(signal);
              })
              .map((element, downloadControlIndex) => {
                const downloadName = element.getAttribute("download")?.trim() || "";
                let container: Element | null = element;
                let title = "";
                const filenameLabels: string[] = [];
                for (let depth = 0; container && container !== attachmentRoot && depth < 5; depth++) {
                  // Stop before a shared container can contribute a neighbouring file's name.
                  if (
                    container !== element &&
                    Array.from(container.querySelectorAll('a[download], button, [role="button"]')).filter(
                      (control) =>
                        control.matches("a[download]") ||
                        /download|ダウンロード/i.test(
                          [
                            control.getAttribute("aria-label"),
                            control.getAttribute("title"),
                            control.textContent
                          ]
                            .filter(Boolean)
                            .join(" ")
                        )
                    ).length > 1
                  )
                    break;
                  for (const label of [
                    container.getAttribute("title"),
                    container.getAttribute("aria-label"),
                    ...Array.from(container.querySelectorAll("span"))
                      .slice(0, 20)
                      .map((child) => child.textContent),
                    container.textContent
                  ]) {
                    if (label?.trim()) filenameLabels.push(label.trim());
                  }
                  const text = (container.textContent || "").replace(/\s+/g, " ").trim();
                  if (text && text.length <= 255 && text.length > title.length) title = text;
                  container = container.parentElement;
                }
                return {
                  title: downloadName || title || `attachment-${downloadControlIndex + 1}`,
                  downloadFilename: downloadName || undefined,
                  filenameLabels,
                  downloadUrl: element.matches("a[download]")
                    ? (element as HTMLAnchorElement).href
                    : undefined,
                  downloadControlIndex
                };
              });
            const fileCards = Array.from(
              attachmentRoot.querySelectorAll('[role="group"], button, [role="button"], a')
            )
              .map((element, fileCardIndex) => {
                const signal = [
                  element.getAttribute("aria-label"),
                  element.getAttribute("title"),
                  element.textContent
                ]
                  .filter(Boolean)
                  .join(" ")
                  .replace(/\s+/g, " ")
                  .trim();
                const match = signal.match(/(?:^|\s)([^\r\n<>:"/\\|?*]{1,220}\.[^\s<>:"/\\|?*]+)(?=\s|$)/u);
                if (!match) return undefined;
                const fileName = match[1]!.trim();
                if (element.matches('button, [role="button"], a')) {
                  // A generated PDF can be rendered as a normal SharePoint anchor. It is a URL
                  // attachment, not an Office preview card. Only classify a standalone
                  // interactive element as a card when it explicitly carries a preview signal.
                  const previewSignal = [
                    element.getAttribute("aria-label"),
                    element.getAttribute("title"),
                    element.getAttribute("data-testid"),
                    element.getAttribute("data-icon-name")
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return /preview|プレビュー/i.test(previewSignal)
                    ? { title: fileName, fileCardIndex }
                    : undefined;
                }
                const preview = Array.from(element.querySelectorAll('button, [role="button"], a')).some(
                  (control) => {
                    const previewSignal = [
                      control.getAttribute("aria-label"),
                      control.getAttribute("title"),
                      control.textContent
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return /preview|プレビュー/i.test(previewSignal);
                  }
                );
                return preview ? { title: fileName, fileCardIndex } : undefined;
              })
              .filter(Boolean);
            const groupedCitationAttributes = Array.from(node.querySelectorAll("[data-grouped-citations]"))
              .map((element) => element.getAttribute("data-grouped-citations"))
              .filter((value): value is string => !!value);
            const actionRequired = Array.from(
              attachmentRoot.querySelectorAll('button, [role="button"]')
            ).some((x: Element) =>
              /confirm|approve|run|実行|確認|承認/i.test(x.textContent || x.getAttribute("aria-label") || "")
            );
            const content = node.cloneNode(true) as HTMLElement;
            content.querySelectorAll("[data-grouped-citations]").forEach((element) => element.remove());
            return {
              html: content.innerHTML,
              text: content.innerText || "",
              citations,
              downloadControls,
              fileCards,
              groupedCitationAttributes,
              actionRequired
            };
          },
          { marker, selector: RESPONSE_SELECTORS.join(", ") }
        );
    } catch {
      payload = undefined;
    }
    if (!payload?.html && !payload?.text)
      throw new BrowserTransportError(
        "RESPONSE_EXTRACTION_FAILED",
        "The latest assistant response could not be isolated from the chat UI."
      );
    const text = htmlToMarkdown(payload.html || payload.text || "");
    const bounded = truncate(text, this.maxCodePoints);
    const groupedCitations = parseGroupedCitationAttributes(payload.groupedCitationAttributes);
    const attachmentCandidates = extractAttachmentCandidates(
      [
        ...(payload.citations || []),
        ...(payload.downloadControls || []),
        ...(payload.fileCards || []),
        ...groupedCitations
      ],
      this.attachmentHosts
    );
    return {
      text: bounded.text,
      truncated: bounded.truncated,
      citations: normalizeCitations([...(payload.citations || []), ...groupedCitations], this.citationUrl),
      attachmentCandidates,
      actionRequired: !!payload.actionRequired
    };
  }
}

/** Treat explicit M365 file cards/download controls and filename-shaped HTTPS anchors as response
 * attachments. UI file cards win over same-name links because M365 can expose a generated file's
 * task-page navigation as a citation beside the real card. */
export function extractAttachmentCandidates(
  value: unknown,
  attachmentHosts: HostAllowlist = new HostAllowlist()
): AttachmentCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: AttachmentCandidate[] = [];
  const seen = new Set<string>();
  const seenNames = new Map<string, number>();
  const addCandidate = (nameKey: string, next: AttachmentCandidate) => {
    let existingIndex = seenNames.get(nameKey);
    const sameName = existingIndex === undefined ? undefined : out[existingIndex];
    if (
      sameName?.url &&
      next.url &&
      sameName.url !== next.url &&
      candidatePriority(sameName) === candidatePriority(next)
    ) {
      nameKey += `\0${next.url}`;
      existingIndex = seenNames.get(nameKey);
    }
    if (existingIndex !== undefined) {
      const existing = out[existingIndex]!;
      if (candidatePriority(next) >= candidatePriority(existing)) return;
      out[existingIndex] = { ...next, index: existing.index };
      return;
    }
    next.index = out.length + 1;
    seenNames.set(nameKey, out.length);
    out.push(next);
  };
  for (const raw of value.slice(0, 100)) {
    if (out.length >= 20) break;
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.title !== "string") continue;
    const title = candidate.title.trim();
    if (!title || title.length > 255) continue;
    const explicitName = filenameInText(title);
    // An explicit download attribute is a complete filename, not prose to search for a suffix.
    // For example, "data.backup README" must not be shortened to "data.backup".
    const name =
      Number.isInteger(candidate.downloadControlIndex) &&
      typeof candidate.downloadFilename === "string" &&
      candidate.downloadFilename.trim()
        ? candidate.downloadFilename.trim()
        : (explicitName ?? title);
    const normalizedName = name.toLocaleLowerCase();
    if (Number.isInteger(candidate.downloadControlIndex)) {
      const labels = Array.isArray(candidate.filenameLabels) ? candidate.filenameLabels : [];
      const sourceNames = labels
        .filter((label): label is string => typeof label === "string")
        .map(attachmentNameFromLabel);
      const sourceFilename =
        sourceNames.find((label) => label && /\.[^\s.]+$/.test(label)) ?? sourceNames.find(Boolean);
      addCandidate((sourceFilename ?? name).toLocaleLowerCase(), {
        index: 0,
        name,
        ...(sourceFilename && sourceFilename !== name ? { sourceFilename } : {}),
        downloadControlIndex: candidate.downloadControlIndex as number,
        ...(typeof candidate.downloadUrl === "string" ? { url: candidate.downloadUrl } : {})
      });
      continue;
    }
    if (Number.isInteger(candidate.fileCardIndex) && explicitName) {
      addCandidate(normalizedName, {
        index: 0,
        name,
        fileCardIndex: candidate.fileCardIndex as number
      });
      continue;
    }
    if (typeof candidate.url !== "string") continue;
    let url: URL;
    try {
      url = new URL(candidate.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
      continue;
    const allowlistedHost = attachmentHosts.allows(url.hostname);
    if (attachmentHosts.size > 0 && !allowlistedHost) continue;
    // Personal/shared opaque links often have no filename in their visible label. File links
    // use p/s as well as r/g; folder (:f:) sharing links are not downloadable attachments.
    const allowlistedSharingLink =
      allowlistedHost && /^\/:(?:b|w|x|p|t|i|v|u):\/(?:r|g|p|s)\//i.test(url.pathname);
    if (!explicitName && !allowlistedSharingLink) continue;
    if (explicitName && isLikelyFilenameReference(explicitName, url.hostname)) continue;
    url.hash = "";
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    addCandidate(explicitName ? normalizedName : normalized, {
      index: 0,
      name:
        explicitName ??
        filenameFromAttachmentUrl(normalized) ??
        (isGenericAttachmentName(title) ? undefined : attachmentNameFromLabel(title)) ??
        `attachment-${out.length + 1}`,
      url: normalized
    });
  }
  return out;
}

function filenameInText(value: string): string | undefined {
  const name = value.match(/(?:^|\s)([^\r\n<>:"/\\|?*]{1,220}\.[^\s<>:"/\\|?*]+)(?=\s|$)/u)?.[1]?.trim();
  return name;
}

function isLikelyFilenameReference(name: string, hostname?: string): boolean {
  const domainLike = /^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z]{2,63}$/i.test(name);
  const commonDomain =
    /\.(?:com|org|net|edu|gov|io|ai|dev|app|jp|co|uk|de|fr|ca|au|us|info|biz|me|tv|xyz|cloud)$/i.test(name);
  return (
    (domainLike && commonDomain) ||
    (hostname !== undefined && name.toLocaleLowerCase() === hostname.toLocaleLowerCase() && domainLike) ||
    /(?:^|\s)(?:v(?:ersion)?\s*)?\d+(?:\.\d+)+$/i.test(name)
  );
}

function candidatePriority(value: unknown): number {
  if (!value || typeof value !== "object") return 3;
  const candidate = value as Record<string, unknown>;
  if (Number.isInteger(candidate.fileCardIndex)) return 0;
  if (Number.isInteger(candidate.downloadControlIndex)) return 1;
  return 2;
}
export function parseGroupedCitationAttributes(value: unknown): AgentCitation[] {
  if (!Array.isArray(value)) return [];
  const citations: AgentCitation[] = [];
  for (const raw of value.slice(0, 100)) {
    if (typeof raw !== "string" || raw.length > 100_000) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed.slice(0, 100)) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.url !== "string") continue;
      const marker = typeof candidate.index === "string" ? candidate.index : undefined;
      const numericIndex = marker ? Number.parseInt(marker, 10) : Number.NaN;
      const source = typeof candidate.name === "string" ? candidate.name : undefined;
      citations.push({
        index: Number.isFinite(numericIndex) ? numericIndex : undefined,
        marker,
        title: source,
        source,
        url: candidate.url
      });
    }
  }
  return citations;
}
export function normalizeCitations(
  citations: AgentCitation[],
  normalizeUrl?: (url: string) => string | undefined
): AgentCitation[] {
  const out: AgentCitation[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    if (out.length >= 20) break;
    let url = citation.url;
    if (url) {
      try {
        const parsed = new URL(url);
        if (
          parsed.protocol !== "https:" ||
          parsed.username ||
          parsed.password ||
          (parsed.port && parsed.port !== "443")
        )
          continue;
        parsed.hash = "";
        url = normalizeUrl ? normalizeUrl(parsed.toString()) : parsed.toString();
      } catch {
        continue;
      }
    }
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);
    out.push({ ...citation, url });
  }
  return out;
}
export function truncate(value: string, maxCodePoints = 50_000): { text: string; truncated: boolean } {
  const points = Array.from(value);
  if (points.length <= maxCodePoints) return { text: value, truncated: false };
  let result = points.slice(0, maxCodePoints).join("");
  const boundary = result.lastIndexOf("\n\n");
  if (boundary > Math.floor(maxCodePoints * 0.7)) result = result.slice(0, boundary);
  return { text: result.trimEnd(), truncated: true };
}
