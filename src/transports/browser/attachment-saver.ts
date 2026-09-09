import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HostAllowlist } from "../../domain/host-pattern.js";
import { isGenericAttachmentName, filenameFromAttachmentUrl } from "../../domain/attachment-filename.js";
import {
  attachmentMediaType,
  canonicalAttachmentMediaType,
  extensionForAttachmentMediaType
} from "../../domain/attachment-media.js";
import type { AgentAttachment } from "../../domain/response.js";
import { RESPONSE_SELECTORS } from "./selectors/common.js";
import type {
  ApiRequestLike,
  AttachmentCandidate,
  BrowserDocumentLike,
  BrowserRequestContextLike,
  PageLike
} from "./types.js";

export type AttachmentSaverOptions = {
  enabled?: boolean;
  directory?: string;
  allowedHosts?: string[];
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  timeoutMs?: number;
};

export type AttachmentSaveContext = {
  workspaceKey: string;
  requestId: string;
  workspaceRoot?: string;
};

/** Saves only explicit response-file anchors or completed-response download controls. URL files
 * use the authenticated request client; UI files click only a control carrying an exact download
 * signal and validate the resulting Download URL, filename, size, and body before saving. */
export class AttachmentSaver {
  private readonly enabled: boolean;
  private readonly directory?: string;
  private readonly allowedHosts: HostAllowlist;
  private readonly maxAttachments: number;
  private readonly maxAttachmentBytes: number;
  private readonly maxTotalAttachmentBytes: number;
  private readonly timeoutMs: number;

  constructor(options: AttachmentSaverOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.directory = options.directory;
    this.allowedHosts = new HostAllowlist(options.allowedHosts ?? []);
    this.maxAttachments = options.maxAttachments ?? 10;
    this.maxAttachmentBytes = options.maxAttachmentBytes ?? 25 * 1024 * 1024;
    this.maxTotalAttachmentBytes = options.maxTotalAttachmentBytes ?? 100 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  async save(
    page: PageLike,
    candidates: AttachmentCandidate[],
    context: AttachmentSaveContext
  ): Promise<AgentAttachment[]> {
    const limited = candidates.slice(0, this.maxAttachments);
    if (!limited.length) return [];
    if (!this.enabled) return limited.map((item) => notSaved(item, "downloads-disabled"));

    const browserContext = page.context?.();
    const request = browserContext?.request;
    let totalBytes = 0;
    const baseDirectory = context.workspaceRoot
      ? path.join(context.workspaceRoot, "APL_downloads")
      : this.directory;
    if (!baseDirectory) return limited.map((item) => notSaved(item, "downloads-disabled"));
    if (context.workspaceRoot) {
      const workspaceInfo = await lstat(context.workspaceRoot).catch(() => undefined);
      if (!workspaceInfo || workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory())
        return limited.map((item) =>
          notSaved(item, "download-failed", page.url(), "destination-unavailable")
        );
    }
    const destination = path.join(
      baseDirectory,
      safeSegment(context.workspaceKey, "workspace"),
      safeSegment(context.requestId, "request")
    );
    try {
      await ensureDirectoryNoSymlinks(
        baseDirectory,
        safeSegment(context.workspaceKey, "workspace"),
        safeSegment(context.requestId, "request")
      );
    } catch {
      return limited.map((item) => notSaved(item, "download-failed", page.url(), "destination-unavailable"));
    }

    const attachments: AgentAttachment[] = [];
    const usedNames = new Set<string>();
    let lastUiDownloadStartedAt: number | undefined;
    for (const candidate of limited) {
      if (candidate.fileCardIndex !== undefined) {
        try {
          lastUiDownloadStartedAt = await waitForUiDownloadGap(page, lastUiDownloadStartedAt);
          const attachment = await saveFileCard(
            page,
            candidate,
            destination,
            usedNames,
            this.allowedHosts,
            this.timeoutMs,
            this.maxAttachmentBytes,
            this.maxTotalAttachmentBytes - totalBytes
          );
          totalBytes += attachment.sizeBytes ?? 0;
          attachments.push(attachment);
        } catch (error) {
          const stage = stageOf(error);
          attachments.push(
            notSaved(
              candidate,
              stage === "preview-host-not-allowed" ? "host-not-allowed" : "download-failed",
              page.url(),
              stage
            )
          );
        }
        continue;
      }
      if (candidate.downloadControlIndex !== undefined) {
        try {
          lastUiDownloadStartedAt = await waitForUiDownloadGap(page, lastUiDownloadStartedAt);
          const attachment = await saveDownloadControl(
            page,
            candidate,
            destination,
            usedNames,
            this.allowedHosts,
            this.timeoutMs,
            this.maxAttachmentBytes,
            this.maxTotalAttachmentBytes - totalBytes
          );
          totalBytes += attachment.sizeBytes ?? 0;
          attachments.push(attachment);
        } catch (error) {
          attachments.push(notSaved(candidate, "download-failed", page.url(), stageOf(error)));
        }
        continue;
      }
      let source: URL;
      try {
        source = new URL(candidate.url!);
      } catch {
        // The candidate's own URL (typically a SharePoint/OneDrive viewer link discovered in the
        // response text, not yet a direct file URL) did not parse at all.
        attachments.push(notSaved(candidate, "host-not-allowed", undefined, "viewer-url-unparseable"));
        continue;
      }
      if (!isAllowedHttpsUrl(source, this.allowedHosts)) {
        attachments.push(notSaved(candidate, "host-not-allowed"));
        continue;
      }
      if (!request) {
        attachments.push(notSaved(candidate, "download-failed"));
        continue;
      }

      try {
        const downloadUrl = new URL(source);
        downloadUrl.searchParams.set("download", "1");
        let downloaded: DownloadedAttachment;
        try {
          downloaded = await fetchAttachment(
            request,
            downloadUrl,
            this.timeoutMs,
            this.maxAttachmentBytes,
            this.maxTotalAttachmentBytes - totalBytes,
            this.allowedHosts
          );
        } catch (firstError) {
          // A Microsoft 365 session can be authenticated while the tenant's SharePoint host has
          // not received its SSO cookies yet. A passive navigation in the same persistent browser
          // context establishes that session without filling a form or clicking any action. Retry
          // the bounded HTTP download exactly once afterward.
          let resolvedDownload: URL | undefined;
          try {
            resolvedDownload = await establishPassiveFileSession(browserContext, source, this.timeoutMs);
          } catch {
            // The retry itself could not even be attempted; the first attempt's own stage (if any)
            // remains the more useful diagnostic.
            throw firstError;
          }
          try {
            downloaded = await fetchAttachment(
              request,
              resolvedDownload ?? downloadUrl,
              this.timeoutMs,
              this.maxAttachmentBytes,
              this.maxTotalAttachmentBytes - totalBytes,
              this.allowedHosts
            );
          } catch {
            // The passive-SSO retry ran but the download still failed: worth its own stage, since
            // it rules out "the tenant simply had not issued SSO cookies yet" as the explanation.
            throw new AttachmentStageError("attachment-sso-retry-failed", "sso-retry-failed");
          }
        }
        const { body, headers } = downloaded;

        const name = uniqueFilename(downloadedFilename(candidate, headers, body, downloaded.url), usedNames);
        const localPath = path.resolve(destination, name);
        await writeFile(localPath, body, { flag: "wx", mode: 0o600 });
        totalBytes += body.length;
        attachments.push({
          index: candidate.index,
          name,
          mediaType: normalizeMediaType(headers["content-type"], name),
          sourceUrl: candidate.url!,
          status: "saved",
          localPath,
          sizeBytes: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
          kind: "url"
        });
      } catch (error) {
        attachments.push(notSaved(candidate, "download-failed", undefined, stageOf(error)));
      }
    }
    return attachments;
  }
}

/** Creates the workspace/request tree without following a pre-existing symlink in any segment. */
async function ensureDirectoryNoSymlinks(base: string, ...segments: string[]): Promise<void> {
  let current = path.resolve(base);
  for (const segment of [".", ...segments]) {
    if (segment !== ".") current = path.join(current, segment);
    const info = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (info?.isSymbolicLink()) throw new Error("attachment destination symlink rejected");
    if (info) {
      if (!info.isDirectory()) throw new Error("attachment destination is not a directory");
      continue;
    }
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      // Another concurrent response may have created this exact directory. Re-stat it and only
      // continue when the winner created a real directory rather than a symlink or file.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("attachment destination could not be created", { cause: error });
      const created = await lstat(current).catch(() => undefined);
      if (!created || created.isSymbolicLink() || !created.isDirectory())
        throw new Error("attachment destination is not a directory", { cause: error });
    }
  }
}

type DownloadedAttachment = {
  body: Buffer;
  headers: Record<string, string>;
  url: string;
};

async function fetchAttachment(
  request: ApiRequestLike,
  url: URL,
  timeoutMs: number,
  maxAttachmentBytes: number,
  remainingTotalBytes: number,
  allowedHosts?: HostAllowlist
): Promise<DownloadedAttachment> {
  let response: Awaited<ReturnType<ApiRequestLike["get"]>>;
  let currentUrl = new URL(url);
  for (let redirectCount = 0; ; redirectCount++) {
    if (allowedHosts && !isAllowedHttpsUrl(currentUrl, allowedHosts))
      throw new AttachmentStageError("attachment-response-rejected", "http-rejected");
    response = await request.get(currentUrl.toString(), {
      timeout: timeoutMs,
      failOnStatusCode: false,
      // Redirects are followed manually so every Location target is checked before any request.
      maxRedirects: 0
    });
    const responseHeaders = lowerCaseHeaders(response.headers());
    const status = response.status();
    if (status >= 300 && status < 400) {
      const location = responseHeaders.location;
      if (!location || redirectCount >= 10)
        throw new AttachmentStageError("attachment-response-rejected", "http-rejected");
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        throw new AttachmentStageError("attachment-response-rejected", "http-rejected");
      }
      continue;
    }
    const headers = responseHeaders;
    if (allowedHosts && response.url) {
      let finalUrl: URL;
      try {
        finalUrl = new URL(response.url());
      } catch {
        throw new AttachmentStageError("attachment-response-rejected", "http-rejected");
      }
      if (!isAllowedHttpsUrl(finalUrl, allowedHosts))
        throw new AttachmentStageError("attachment-response-rejected", "http-rejected");
    }
    const declaredBytes = Number.parseInt(headers["content-length"] ?? "", 10);
    if (!response.ok()) throw new AttachmentStageError("attachment-response-rejected", "http-rejected");
    if (Number.isFinite(declaredBytes) && declaredBytes > maxAttachmentBytes)
      throw new AttachmentStageError("attachment-response-rejected", "oversize");
    if (Number.isFinite(declaredBytes) && declaredBytes > remainingTotalBytes)
      throw new AttachmentStageError("attachment-response-rejected", "quota-exceeded");
    const body = await response.body();
    if (body.length === 0 && !isExplicitAttachment(headers["content-disposition"]))
      throw new Error("attachment-body-rejected");
    if (body.length > maxAttachmentBytes)
      throw new AttachmentStageError("attachment-body-rejected", "oversize");
    if (body.length > remainingTotalBytes)
      throw new AttachmentStageError("attachment-body-rejected", "quota-exceeded");
    if (isHtml(headers["content-type"], body) && !isExplicitAttachment(headers["content-disposition"]))
      throw new AttachmentStageError("attachment-body-rejected", "html-rejected");
    return { body, headers, url: response.url?.() ?? currentUrl.toString() };
  }
}

async function establishPassiveFileSession(
  context: BrowserRequestContextLike | undefined,
  source: URL,
  timeoutMs: number
): Promise<URL | undefined> {
  if (!context?.newPage) throw new Error("attachment-session-bootstrap-unavailable");
  const bootstrapPage = await context.newPage();
  try {
    await bootstrapPage
      .goto?.(source.toString(), {
        waitUntil: "domcontentloaded",
        timeout: Math.min(timeoutMs, 30_000)
      })
      .catch(() => undefined);
    await bootstrapPage.waitForTimeout?.(750);
    // SSO can take several redirects after DOMContentLoaded. Keep the authenticated context's
    // passive tab alive until it returns to the file host, instead of closing it on a login page.
    const attempts = Math.max(1, Math.ceil(Math.min(timeoutMs, 15_000) / 250));
    for (let attempt = 0; attempt < attempts; attempt++) {
      let current: URL | undefined;
      try {
        current = new URL(bootstrapPage.url());
      } catch {
        // A transient blank or detached page is not a resolved viewer.
      }
      if (current?.origin === source.origin) {
        const direct = sharePointViewerDownloadUrl(current);
        if (direct) return direct;
        // Do not mistake an intermediate sign-in page on the file host for the file itself.
        // A non-Office file can resolve to its actual path; retain any sharing/access query.
        if (
          current.pathname === source.pathname ||
          (/\.[^/.]+$/.test(current.pathname) && !/\.(?:aspx?|php|html?)$/i.test(current.pathname))
        ) {
          current.searchParams.set("download", "1");
          return current;
        }
      }
      if (!bootstrapPage.waitForTimeout) break;
      await bootstrapPage.waitForTimeout(250);
    }
    return undefined;
  } finally {
    await bootstrapPage.close?.().catch(() => undefined);
  }
}

/** Which candidate shape produced an attachment (see AgentAttachment.kind): a plain URL-based
 * candidate found in the response text, a completed-response download control, or a file card. */
function kindOf(candidate: AttachmentCandidate): NonNullable<AgentAttachment["kind"]> {
  if (candidate.fileCardIndex !== undefined) return "file-card";
  if (candidate.downloadControlIndex !== undefined) return "download-control";
  return "url";
}

function notSaved(
  candidate: AttachmentCandidate,
  errorCode: NonNullable<AgentAttachment["errorCode"]>,
  fallbackSourceUrl = "https://invalid.local/",
  stage?: string
): AgentAttachment {
  return {
    index: candidate.index,
    name: sanitizeFilename(candidate.name),
    mediaType: mediaTypeForName(candidate.name),
    sourceUrl: candidate.url ?? fallbackSourceUrl,
    status: "not-saved",
    errorCode,
    kind: kindOf(candidate),
    ...(stage ? { stage } : {})
  };
}

/** The acquisition stage recorded on a saver-internal failure, if any (metadata only). */
function stageOf(error: unknown): string | undefined {
  return error instanceof AttachmentStageError ? error.stage : undefined;
}

// All explicitly delivered filenames are accepted after path/filename sanitization.

/** How long a file card is given to reveal its preview/download controls after being focused and
 * hovered. Short on purpose: this is a nudge, not a wait for the file itself. */
const FILE_CARD_REVEAL_TIMEOUT_MS = 500;
const FILE_CARD_REVEAL_POLL_MS = 100;
/** Chromium can suppress a burst of synthetic download events from one response card. Keep a
 * short gap between UI-triggered downloads; direct authenticated HTTP fetches do not use it. */
const UI_DOWNLOAD_MIN_INTERVAL_MS = 150;
/** Events a hover-revealed control listens for; dispatched on the card, never on a control. */
const FILE_CARD_HOVER_EVENTS = ["mouseover", "mouseenter", "pointerenter"];

/**
 * Where an acquisition attempt got to before it failed (metadata only), recorded on the resulting
 * not-saved `AgentAttachment.stage` (src/domain/response.ts) so a UI change ("the controls never
 * became visible") can be told apart from a plain download failure ("the tenant returned an HTML
 * sign-in page") without reading logs. The first three are file-card-specific (see
 * revealFileCardControls); the rest are raised by the authenticated-fetch URL flow (see
 * fetchAttachment and the retry it feeds).
 */
export type AttachmentStage =
  | "card-missing"
  | "control-not-visible"
  | "control-visible"
  | "preview-frame-not-found"
  | "preview-download-control-not-found"
  | "preview-host-not-allowed"
  | "http-rejected"
  | "html-rejected"
  | "oversize"
  | "quota-exceeded"
  | "viewer-url-unparseable"
  | "sso-retry-failed";

/** Internal failure carrying the stage it happened at (see AttachmentStage). */
class AttachmentStageError extends Error {
  readonly stage: AttachmentStage;
  constructor(message: string, stage: AttachmentStage) {
    super(message);
    this.name = "AttachmentStageError";
    this.stage = stage;
  }
}

/**
 * Microsoft 365 renders a file card's preview/download controls only while the card is hovered or
 * keyboard-focused. `PageLike` deliberately exposes no pointer action -- a `page.hover()`-style
 * call is not available here, and adding one would hand the transport a generic
 * point-at-any-element primitive -- so the card is focused and the hover events its own handlers
 * listen for are dispatched from inside the page instead. Nothing is clicked: this only makes the
 * controls visible so the existing, exactly-matched search can find them.
 */
async function revealFileCardControls(
  page: PageLike,
  fileCardIndex: number,
  timeoutMs: number
): Promise<AttachmentStage> {
  if (!page.evaluate) return "card-missing";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stage: AttachmentStage = await page
      .evaluate<AttachmentStage>(
        (args: { selector: string; index: number; events: string[] }) => {
          const nodes = Array.from(document.querySelectorAll(args.selector)) as HTMLElement[];
          const response = nodes[nodes.length - 1];
          if (!response) return "card-missing";
          const attachmentRoot = response.closest('[role="article"].fai-CopilotMessage') || response;
          const cards = Array.from(
            attachmentRoot.querySelectorAll('[role="group"], button, [role="button"], a')
          );
          const card = cards[args.index] as HTMLElement | undefined;
          if (!card) return "card-missing";
          card.focus?.();
          for (const type of args.events) {
            const pointer = type.startsWith("pointer") && typeof PointerEvent === "function";
            const init = { bubbles: type === "mouseover" || type === "pointerover", cancelable: true };
            card.dispatchEvent(pointer ? new PointerEvent(type, init) : new MouseEvent(type, init));
          }
          // A card that is itself the control needs no revealed child control.
          if (card.matches('button, [role="button"], a')) return "control-visible";
          const revealed = Array.from(card.querySelectorAll('button, [role="button"], a')).some((control) => {
            const signal = [
              control.matches("a[download]") ? "download-anchor" : "",
              control.getAttribute("aria-label"),
              control.getAttribute("title"),
              control.getAttribute("data-testid"),
              control.getAttribute("data-icon-name"),
              control.getAttribute("download"),
              control.textContent
            ]
              .filter(Boolean)
              .join(" ");
            return (
              /preview|プレビュー|(?:^|[\s_:-])download(?:[\s_:-]|$)|ダウンロード/i.test(signal) &&
              (control as HTMLElement).getClientRects().length > 0
            );
          });
          return revealed ? "control-visible" : "control-not-visible";
        },
        {
          selector: RESPONSE_SELECTORS.join(", "),
          index: fileCardIndex,
          events: FILE_CARD_HOVER_EVENTS
        }
      )
      .catch(() => "card-missing" as AttachmentStage);
    if (stage === "control-visible" || Date.now() >= deadline) return stage;
    await wait(page, FILE_CARD_REVEAL_POLL_MS);
  }
}

async function saveDownloadControl(
  page: PageLike,
  candidate: AttachmentCandidate,
  destination: string,
  usedNames: Set<string>,
  allowedHosts: HostAllowlist,
  timeoutMs: number,
  maxAttachmentBytes: number,
  remainingTotalBytes: number
): Promise<AgentAttachment> {
  if (!page.waitForEvent || !page.evaluate) throw new Error("attachment-download-control-unavailable");
  const downloadPromise = page.waitForEvent("download", { timeout: Math.min(timeoutMs, 30_000) });
  const verifiedPageOrigin = secureHttpsOrigin(page.url());
  let expectedBlobUrl: string | undefined;
  let contentType: string | undefined;
  try {
    const activation = await page.evaluate<{ expectedBlobUrl?: string; contentType?: string } | undefined>(
      async (args: { selector: string; index: number; expectedName: string; expectedUrl?: string }) => {
        const nodes = Array.from(document.querySelectorAll(args.selector)) as HTMLElement[];
        const response = nodes[nodes.length - 1];
        if (!response) throw new Error("attachment-response-missing");
        const attachmentRoot = response.closest('[role="article"].fai-CopilotMessage') || response;
        const controls = Array.from(attachmentRoot.querySelectorAll('button, [role="button"], a')).filter(
          (element) => {
            const signal = [
              element.matches("a[download]") ? "download-anchor" : "",
              element.getAttribute("aria-label"),
              element.getAttribute("title"),
              element.getAttribute("data-testid"),
              element.getAttribute("data-icon-name"),
              element.getAttribute("download"),
              element.textContent,
              element.innerHTML.slice(0, 2_000)
            ]
              .filter(Boolean)
              .join(" ");
            return /(?:^|[\s_:-])download(?:[\s_:-]|$)|ダウンロード/i.test(signal);
          }
        ) as HTMLElement[];
        const control = controls[args.index];
        if (!control) throw new Error("attachment-download-control-missing");
        const anchor = control.matches("a[download]") ? (control as HTMLAnchorElement) : undefined;
        const href = anchor?.href;
        if (href && !/^(?:https:|blob:)/.test(href))
          throw new Error("attachment-download-anchor-scheme-rejected");
        if (args.expectedUrl !== undefined && href !== args.expectedUrl)
          throw new Error("attachment-download-anchor-url-mismatch");
        // Current extracted anchors carry their URL, including download="" anchors whose name
        // is chosen by the browser. Retain the name check for legacy candidates without a URL.
        if (href?.startsWith("blob:") && !args.expectedUrl && anchor?.download !== args.expectedName)
          throw new Error("attachment-download-anchor-name-mismatch");
        // Blob downloads have no HTTP response headers in the broker. Read only the MIME of
        // this exact, same-origin blob before its click handler can revoke it. Never fetch an
        // HTTP URL here, and never execute or decode the downloaded content.
        let contentType: string | undefined;
        if (href?.startsWith("blob:") && typeof location !== "undefined" && location.protocol === "https:") {
          try {
            if (new URL(href.slice(5)).origin === location.origin) {
              const response = await fetch(href);
              contentType = response.headers.get("content-type") ?? undefined;
              await response.body?.cancel();
            }
          } catch {
            // CSP or a revoked blob may prevent inspection; the download still decides success.
          }
        }
        // Read the selected anchor before activation: a click handler may synchronously replace
        // href or remove the node, but the URL we validate must be the control we selected.
        if (href && anchor?.href !== href) throw new Error("attachment-download-anchor-url-mismatch");
        control.click();
        return href?.startsWith("blob:") ? { expectedBlobUrl: href, contentType } : undefined;
      },
      {
        selector: RESPONSE_SELECTORS.join(", "),
        index: candidate.downloadControlIndex!,
        expectedName: candidate.name,
        expectedUrl: candidate.url
      }
    );
    expectedBlobUrl = activation?.expectedBlobUrl;
    contentType = activation?.contentType;
  } catch (error) {
    void downloadPromise.catch(() => undefined);
    throw error;
  }
  const download = await downloadPromise;
  const currentPageOrigin = secureHttpsOrigin(page.url());
  return persistBrowserDownload(
    download,
    candidate,
    destination,
    usedNames,
    allowedHosts,
    maxAttachmentBytes,
    remainingTotalBytes,
    { expectedBlobUrl, verifiedPageOrigin, currentPageOrigin, contentType }
  );
}

async function saveFileCard(
  page: PageLike,
  candidate: AttachmentCandidate,
  destination: string,
  usedNames: Set<string>,
  allowedHosts: HostAllowlist,
  timeoutMs: number,
  maxAttachmentBytes: number,
  remainingTotalBytes: number
): Promise<AgentAttachment> {
  if (!page.waitForEvent || !page.evaluate) throw new Error("attachment-file-card-unavailable");
  // Hover/focus first: on Microsoft 365 the preview and download controls of a file card exist in
  // the DOM only while the card is hovered or focused.
  const stage = await revealFileCardControls(
    page,
    candidate.fileCardIndex!,
    Math.min(timeoutMs, FILE_CARD_REVEAL_TIMEOUT_MS)
  );
  await page.evaluate(
    (args: { selector: string; index: number; expectedName: string }) => {
      const nodes = Array.from(document.querySelectorAll(args.selector)) as HTMLElement[];
      const response = nodes[nodes.length - 1];
      if (!response) throw new Error("attachment-response-missing");
      const attachmentRoot = response.closest('[role="article"].fai-CopilotMessage') || response;
      const cards = Array.from(attachmentRoot.querySelectorAll('[role="group"], button, [role="button"], a'));
      const card = cards[args.index] as HTMLElement | undefined;
      const signal = [card?.getAttribute("aria-label"), card?.getAttribute("title"), card?.textContent]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const expectedName = args.expectedName.replace(/\s+/g, " ").trim();
      if (!card || !expectedName || !signal.includes(expectedName))
        throw new Error("attachment-file-card-missing");
      if (card.matches('button, [role="button"], a')) {
        card.click();
        return;
      }
      const previewControl = Array.from(card.querySelectorAll('button, [role="button"], a')).find(
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
      ) as HTMLElement | undefined;
      if (!previewControl) throw new Error("attachment-file-card-preview-control-missing");
      const previewSignal = [
        previewControl.getAttribute("aria-label"),
        previewControl.getAttribute("title"),
        previewControl.textContent
      ]
        .filter(Boolean)
        .join(" ");
      // M365 may automatically open a generated file. Its explicit control then says "Close
      // preview"/"プレビューを閉じます"; preserve that state so the SharePoint frame remains
      // available. Otherwise activate the exact preview control discovered above.
      if (!/close.{0,16}preview|preview.{0,16}close|プレビュー.{0,8}閉/i.test(previewSignal))
        previewControl.click();
    },
    {
      selector: RESPONSE_SELECTORS.join(", "),
      index: candidate.fileCardIndex!,
      expectedName: candidate.name
    }
  );

  let previewFailure: AttachmentStageError | undefined;
  const previewAttachment = await trySaveSharePointPreview(
    page,
    candidate,
    destination,
    usedNames,
    allowedHosts,
    timeoutMs,
    maxAttachmentBytes,
    remainingTotalBytes
  ).catch((error: unknown) => {
    if (error instanceof AttachmentStageError) previewFailure = error;
    return undefined;
  });
  if (previewAttachment) return previewAttachment;
  if (previewFailure?.stage === "preview-host-not-allowed") throw previewFailure;

  const downloadPromise = page.waitForEvent("download", { timeout: Math.min(timeoutMs, 30_000) });
  let clicked = false;
  try {
    for (let attempt = 0; attempt < 40 && !clicked; attempt++) {
      clicked = await page.evaluate(
        (args: { selector: string; index: number }) => {
          const responses = Array.from(document.querySelectorAll(args.selector));
          const response = responses[responses.length - 1];
          const attachmentRoot = response?.closest('[role="article"].fai-CopilotMessage') || response;
          const cards = attachmentRoot
            ? Array.from(attachmentRoot.querySelectorAll('[role="group"], button, [role="button"], a'))
            : [];
          const card = cards[args.index] as HTMLElement | undefined;
          const cardControls = card
            ? [
                ...(card.matches('button, [role="button"], a') ? [card] : []),
                ...Array.from(card.querySelectorAll('button, [role="button"], a'))
              ]
            : [];
          const controls = cardControls
            .filter((element, index, all) => all.indexOf(element) === index)
            .filter((element) => {
              const signal = [
                element.matches("a[download]") ? "download-anchor" : "",
                element.getAttribute("aria-label"),
                element.getAttribute("title"),
                element.getAttribute("data-testid"),
                element.getAttribute("data-icon-name"),
                element.getAttribute("download"),
                element.textContent,
                element.innerHTML.slice(0, 2_000)
              ]
                .filter(Boolean)
                .join(" ");
              return (
                /(?:^|[\s_:-])download(?:[\s_:-]|$)|ダウンロード/i.test(signal) &&
                (element as HTMLElement).getClientRects().length > 0
              );
            }) as HTMLElement[];
          // Prefer the selected card's own control. The page can contain unrelated download
          // buttons in a task pane, and choosing the last global match could activate the wrong file.
          const control = controls[0];
          control?.click();
          return !!control;
        },
        { selector: RESPONSE_SELECTORS.join(", "), index: candidate.fileCardIndex! }
      );
      if (!clicked) await wait(page, 250);
    }
    if (!clicked)
      throw new AttachmentStageError(
        "attachment-preview-download-control-missing",
        previewFailure?.stage === "preview-frame-not-found"
          ? "preview-download-control-not-found"
          : (previewFailure?.stage ?? stage)
      );
  } catch (error) {
    void downloadPromise.catch(() => undefined);
    throw error;
  }
  const download = await downloadPromise;
  return persistBrowserDownload(
    download,
    candidate,
    destination,
    usedNames,
    allowedHosts,
    maxAttachmentBytes,
    remainingTotalBytes
  );
}

async function trySaveSharePointPreview(
  page: PageLike,
  candidate: AttachmentCandidate,
  destination: string,
  usedNames: Set<string>,
  allowedHosts: HostAllowlist,
  timeoutMs: number,
  maxAttachmentBytes: number,
  remainingTotalBytes: number
): Promise<AgentAttachment | undefined> {
  const context = page.context?.();
  if (!context?.request || !page.evaluate) return undefined;
  const source = await findSharePointViewerInDom(page);
  const downloadUrl = source ? sharePointViewerDownloadUrl(source) : undefined;
  if (!source || !downloadUrl)
    throw new AttachmentStageError("attachment-preview-frame-not-found", "preview-frame-not-found");
  if (!isAllowedHttpsUrl(source, allowedHosts)) {
    throw new AttachmentStageError("attachment-preview-host-not-allowed", "preview-host-not-allowed");
  }

  let downloaded: DownloadedAttachment;
  try {
    downloaded = await fetchAttachment(
      context.request,
      downloadUrl,
      timeoutMs,
      maxAttachmentBytes,
      remainingTotalBytes,
      allowedHosts
    );
  } catch {
    await establishPassiveFileSession(context, source, timeoutMs);
    downloaded = await fetchAttachment(
      context.request,
      downloadUrl,
      timeoutMs,
      maxAttachmentBytes,
      remainingTotalBytes,
      allowedHosts
    );
  }
  const name = uniqueFilename(
    downloadedFilename(candidate, downloaded.headers, downloaded.body, downloaded.url),
    usedNames
  );
  const localPath = path.resolve(destination, name);
  await writeFile(localPath, downloaded.body, { flag: "wx", mode: 0o600 });
  return {
    index: candidate.index,
    name,
    mediaType: normalizeMediaType(downloaded.headers["content-type"], name),
    sourceUrl: source.toString(),
    status: "saved",
    localPath,
    sizeBytes: downloaded.body.length,
    sha256: createHash("sha256").update(downloaded.body).digest("hex"),
    kind: "file-card"
  };
}

async function findSharePointViewerInDom(page: PageLike): Promise<URL | undefined> {
  // Office's embedded viewer is mounted asynchronously after the response card is opened. On a
  // cold tenant session the SharePoint frame can appear several seconds after the card itself.
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const scope of documentScopes(page)) {
      // The frame URL itself is the most reliable signal for M365's OneUpContentFrame. Inspect it
      // before evaluating the document because Office may replace/detach sibling frames while the
      // preview boots; one transient frame must not abort discovery of the stable SharePoint frame.
      const values = [scope.url()];
      if (scope.evaluate) {
        const discovered = await scope
          .evaluate<string[]>(() =>
            Array.from(document.querySelectorAll("a[href], iframe[src]"))
              .flatMap((element) => [element.getAttribute("href"), element.getAttribute("src")])
              .filter((value): value is string => !!value)
              .slice(0, 200)
          )
          .catch(() => []);
        values.push(...discovered);
      }
      for (const value of values) {
        let possible: URL;
        try {
          possible = new URL(value, scope.url() || page.url());
        } catch {
          continue;
        }
        if (sharePointViewerDownloadUrl(possible)) return possible;
      }
    }
    await wait(page, 250);
  }
  return undefined;
}

function documentScopes(page: PageLike): BrowserDocumentLike[] {
  const scopes: BrowserDocumentLike[] = [page, ...(page.frames?.() ?? [])];
  return [...new Set(scopes)];
}

export function sharePointViewerDownloadUrl(source: URL): URL | undefined {
  const marker = source.pathname.toLocaleLowerCase().lastIndexOf("/_layouts/15/");
  if (marker < 0) return undefined;
  // PDF and other non-Office files often resolve to OneDrive's viewer with a server-relative id.
  // Convert only that file path on the same origin; never a URL supplied for another host.
  if (/\/onedrive\.aspx$/i.test(source.pathname)) {
    const id = source.searchParams.get("id");
    if (!id?.startsWith("/") || id.startsWith("//") || id.includes("\\")) return undefined;
    const file = new URL(id, source.origin);
    if (file.origin !== source.origin || file.search || file.hash) return undefined;
    const direct = new URL(`${source.pathname.slice(0, marker)}/_layouts/15/download.aspx`, source.origin);
    direct.searchParams.set("SourceUrl", file.toString());
    return direct;
  }
  if (!/\/(?:doc|embed)\.aspx$/i.test(source.pathname)) return undefined;
  const rawId = (
    /\/doc\.aspx$/i.test(source.pathname)
      ? source.searchParams.get("sourcedoc")
      : source.searchParams.get("uniqueId")
  )?.replace(/[{}]/g, "");
  if (!rawId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId))
    return undefined;
  const sitePath = source.pathname.slice(0, marker).replace(/^\/:([a-z]):\/r/i, "");
  const direct = new URL(source.origin);
  direct.pathname = `${sitePath}/_layouts/15/download.aspx`.replace(/\/{2,}/g, "/");
  direct.searchParams.set("UniqueId", rawId);
  return direct;
}

function isAllowedHttpsUrl(value: URL, allowedHosts: HostAllowlist): boolean {
  return (
    value.protocol === "https:" &&
    !value.username &&
    !value.password &&
    (!value.port || value.port === "443") &&
    allowedHosts.allows(value.hostname)
  );
}

async function persistBrowserDownload(
  download: import("./types.js").BrowserDownloadLike,
  candidate: AttachmentCandidate,
  destination: string,
  usedNames: Set<string>,
  allowedHosts: HostAllowlist,
  maxAttachmentBytes: number,
  remainingTotalBytes: number,
  validation: BrowserDownloadValidation = {}
): Promise<AgentAttachment> {
  const failure = await download.failure?.();
  if (failure) throw new Error("attachment-browser-download-failed");
  const sourceValue = download.url();
  const source = new URL(sourceValue);
  if (source.protocol === "blob:") {
    if (!isVerifiedBlobDownload(sourceValue, validation)) {
      await download.cancel?.().catch(() => undefined);
      throw new Error("attachment-blob-download-rejected");
    }
  } else if (
    source.protocol !== "https:" ||
    source.username ||
    source.password ||
    (source.port && source.port !== "443") ||
    !allowedHosts.allows(source.hostname) ||
    (validation.expectedBlobUrl && sourceValue !== validation.expectedBlobUrl)
  ) {
    await download.cancel?.().catch(() => undefined);
    throw new Error("attachment-download-host-rejected");
  }
  const suggestedName = download.suggestedFilename().trim() || `attachment-${candidate.index}`;
  const temporaryPath = await download.path();
  if (!temporaryPath) throw new Error("attachment-download-path-missing");
  const body = await readFile(temporaryPath);
  if (body.length > maxAttachmentBytes || body.length > remainingTotalBytes)
    throw new Error("attachment-download-body-rejected");
  const name = uniqueFilename(
    completeAttachmentFilename(
      selectAttachmentFilename(candidate, suggestedName, sourceValue),
      validation.contentType,
      body,
      suggestedName
    ),
    usedNames
  );
  const localPath = path.resolve(destination, name);
  await writeFile(localPath, body, { flag: "wx", mode: 0o600 });
  return {
    index: candidate.index,
    name,
    mediaType: normalizeMediaType(validation.contentType, name),
    sourceUrl: source.toString(),
    status: "saved",
    localPath,
    sizeBytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    kind: kindOf(candidate)
  };
}

type BrowserDownloadValidation = {
  contentType?: string;
  expectedBlobUrl?: string;
  verifiedPageOrigin?: string;
  currentPageOrigin?: string;
};

/** A blob is accepted only when the exact anchor selected by the page script produced it and the
 * page stayed on the same verified HTTPS origin across the click/download callback. Generic buttons
 * and blob URLs from any other origin have no trusted file source and are rejected. */
function isVerifiedBlobDownload(sourceValue: string, validation: BrowserDownloadValidation): boolean {
  if (!validation.expectedBlobUrl || sourceValue !== validation.expectedBlobUrl) return false;
  if (!validation.verifiedPageOrigin || validation.verifiedPageOrigin !== validation.currentPageOrigin)
    return false;
  let outer: URL;
  let embedded: URL;
  try {
    outer = new URL(sourceValue);
    embedded = new URL(sourceValue.slice("blob:".length));
  } catch {
    return false;
  }
  if (outer.protocol !== "blob:" || embedded.protocol !== "https:") return false;
  if (
    embedded.username ||
    embedded.password ||
    (embedded.port && embedded.port !== "443") ||
    embedded.origin !== validation.verifiedPageOrigin ||
    !embedded.pathname ||
    embedded.pathname === "/"
  )
    return false;
  return true;
}

function secureHttpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

async function wait(page: PageLike, ms: number): Promise<void> {
  if (page.waitForTimeout) await page.waitForTimeout(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUiDownloadGap(page: PageLike, lastStartedAt: number | undefined): Promise<number> {
  if (lastStartedAt !== undefined) {
    const remaining = UI_DOWNLOAD_MIN_INTERVAL_MS - (Date.now() - lastStartedAt);
    if (remaining > 0) await wait(page, remaining);
  }
  return Date.now();
}

function safeSegment(value: string, fallback: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return safe || fallback;
}

export function sanitizeFilename(value: string): string {
  const leaf = path.basename(value.trim().replace(/\\/g, "/"));
  let safe = Array.from(leaf)
    .map((character) =>
      (character.codePointAt(0) ?? 0) <= 0x1f || '<>:"/\\|?*'.includes(character) ? "_" : character
    )
    .join("")
    .replace(/[. ]+$/g, "")
    .slice(0, 240);
  if (!safe) safe = "attachment.bin";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe;
}

function uniqueFilename(value: string, used: Set<string>): string {
  if (!used.has(value.toLocaleLowerCase())) {
    used.add(value.toLocaleLowerCase());
    return value;
  }
  const extension = path.extname(value);
  const stem = value.slice(0, value.length - extension.length);
  for (let index = 2; ; index++) {
    const next = `${stem}-${index}${extension}`;
    if (!used.has(next.toLocaleLowerCase())) {
      used.add(next.toLocaleLowerCase());
      return next;
    }
  }
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLocaleLowerCase(), value]));
}

function isHtml(contentType: string | undefined, body: Buffer): boolean {
  if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType ?? "")) return true;
  return /^\s*<(?:!doctype\s+html|html)\b/i.test(body.subarray(0, 256).toString("utf8"));
}

function isExplicitAttachment(value: string | undefined): boolean {
  return /^\s*attachment(?:\s*;|$)/i.test(value ?? "");
}

function normalizeMediaType(contentType: string | undefined, name: string, body?: Buffer): string {
  const value = canonicalAttachmentMediaType(contentType);
  if (
    value &&
    !["application/octet-stream", "text/plain", "application/zip"].includes(value) &&
    extensionForAttachmentMediaType(value) !== ".bin"
  )
    return value;
  const inferred = attachmentMediaType(name, body);
  return inferred !== "application/octet-stream" ? inferred : (value ?? "application/octet-stream");
}

function downloadedFilename(
  candidate: AttachmentCandidate,
  headers: Record<string, string>,
  body: Buffer,
  finalUrl?: string
): string {
  const fromHeader = filenameFromContentDisposition(headers["content-disposition"]);
  const rawCandidateName = candidate.name.trim();
  if (fromHeader || rawCandidateName || finalUrl)
    return completeAttachmentFilename(
      selectAttachmentFilename(candidate, fromHeader, finalUrl),
      headers["content-type"],
      body,
      fromHeader ?? rawCandidateName
    );
  return sanitizeFilename(
    `attachment-${candidate.index}${extensionForAttachmentMediaType(normalizeMediaType(headers["content-type"], "", body))}`
  );
}

/** A transport placeholder must not hide a filename supplied by the agent's selected file. */
function selectAttachmentFilename(
  candidate: AttachmentCandidate,
  delivered?: string,
  finalUrl?: string
): string {
  const sourceNames = [candidate.sourceFilename, candidate.name];
  const names = [
    delivered,
    ...sourceNames,
    filenameFromAttachmentUrl(finalUrl),
    filenameFromAttachmentUrl(candidate.url)
  ]
    .filter((name): name is string => !!name?.trim())
    .map(sanitizeFilename);
  return (
    names.find((name) => !isGenericAttachmentName(name)) ??
    (delivered?.trim()
      ? sanitizeFilename(delivered)
      : candidate.name.trim()
        ? sanitizeFilename(candidate.name)
        : `attachment-${candidate.index}`)
  );
}

/** Preserve existing extensions and intentionally extensionless text/unknown files. MIME is
 * available for HTTP downloads; browser downloads use bounded signature inspection and the
 * selected response file's name. Only the saved name changes, never the original bytes. */
function completeAttachmentFilename(
  value: string,
  contentType: string | undefined,
  body: Buffer,
  fallbackName = ""
): string {
  const name = sanitizeFilename(value);
  if (path.extname(name)) return name;
  let mediaType = normalizeMediaType(contentType, name, body);
  if (["application/octet-stream", "text/plain", "application/zip"].includes(mediaType)) {
    const fromSourceName = attachmentMediaType(sanitizeFilename(fallbackName));
    if (fromSourceName !== "application/octet-stream") mediaType = fromSourceName;
  }
  const extension = extensionForAttachmentMediaType(mediaType);
  if (extension === ".bin" || (mediaType === "text/plain" && !/^attachment-\d+$/.test(name))) return name;
  // Leave room for the suffix after the filename sanitizer's length limit.
  return `${name.slice(0, 240 - extension.length)}${extension}`;
}

function filenameFromContentDisposition(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const encoded = value
    .match(/(?:^|;)\s*filename\*\s*=\s*([^;]+)/i)?.[1]
    ?.trim()
    .replace(/^"|"$/g, "");
  const basic = value.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  let raw = basic?.[1] ?? basic?.[2]?.trim();
  if (encoded) {
    try {
      const utf8 = encoded.match(/^UTF-8'[^']*'(.*)$/i)?.[1];
      // Retain compatibility with servers sending bare percent-encoded names, but do not
      // turn an unsupported charset/language declaration into part of the filename.
      if (utf8 !== undefined || !encoded.includes("'")) raw = decodeURIComponent(utf8 ?? encoded);
    } catch {
      // A valid basic filename is still usable if filename* is malformed.
    }
  }
  if (!raw) return undefined;
  const name = sanitizeFilename(raw);
  return name;
}

function mediaTypeForName(name: string): string {
  return attachmentMediaType(name);
}
