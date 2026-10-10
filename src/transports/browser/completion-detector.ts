import type { CompletionResult, PageLike, ResponseMarker } from "./types.js";
import { RESPONSE_SELECTORS, STOP_GENERATING_PATTERN } from "./selectors/common.js";

export interface CompletionDetectorOptions {
  stabilityWindowMs?: number;
  pollIntervalMs?: number;
  /** Extra quiet time required before an unchanged response counts as complete when no streaming
   * signal was ever observed. Microsoft 365 can render an empty-looking assistant node long
   * before it starts writing, so "nothing moved" alone is a weak completion signal. */
  quietStreamingGraceMs?: number;
}

type CompletionSignal = { text: string; streaming: boolean; id?: string };

/** Polls observable UI signals; fixed sleep alone is deliberately not used. */
export class CompletionDetector {
  private readonly stabilityWindowMs: number;
  private readonly pollIntervalMs: number;
  private readonly quietStreamingGraceMs: number;
  constructor(options: CompletionDetectorOptions = {}) {
    this.stabilityWindowMs = options.stabilityWindowMs ?? 1_800;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.quietStreamingGraceMs = options.quietStreamingGraceMs ?? 3_000;
  }
  /**
   * `onSettling` is called once per quiet period, when the answer has actually held still: the same
   * non-empty text on two polls in a row, nothing generating on the second (so the caller can report
   * that it is confirming the answer). It is not called on the poll where the text just changed, so
   * text that grows on every poll never reports it. A quiet period ends when the text changes or a
   * streaming signal appears; the next one reports again.
   */
  async wait(
    page: PageLike,
    marker: ResponseMarker,
    timeoutMs = 300_000,
    signal?: AbortSignal,
    onSettling?: () => void
  ): Promise<CompletionResult> {
    const started = Date.now();
    let last = "";
    let sawStreamingSignal = false;
    // Where the stability measurement of the current text started: the poll that first showed it
    // (non-empty, no streaming signal), or the first poll without a streaming signal when the text
    // did not change meanwhile. Undefined while something is generating and while the text is empty.
    // A streaming signal restarts the count when it clears: the page can still change the text right
    // after it stops generating (a final re-render with citations), so text that merely held still
    // while the agent was busy -- a status line while it searches -- must not count as an answer the
    // moment the signal goes.
    let quietSince: number | undefined;
    // Whether `onSettling` was called for the current quiet period: the same non-empty text on two
    // polls in a row, the second without a streaming signal. A poll where the text just changed only
    // starts the stability measurement above; the next poll that shows that text reports. A change of
    // the text, or a streaming signal, ends the period.
    let settlingReported = false;
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted)
        return {
          complete: false,
          cancelled: true,
          partial: last || undefined,
          reason: "cancelled",
          sawStreamingSignal,
          finalChars: last.length
        };
      const state = await this.signal(page, marker);
      const now = Date.now();
      if (state.streaming) {
        sawStreamingSignal = true;
        last = state.text;
        quietSince = undefined;
        settlingReported = false;
      } else if (state.text !== last) {
        last = state.text;
        quietSince = state.text ? now : undefined;
        settlingReported = false;
      } else if (state.text) {
        // The same text as on the previous poll, nothing generating: the answer held still.
        quietSince ??= now;
        if (!settlingReported) {
          settlingReported = true;
          onSettling?.();
        }
      }
      // A response is only complete when there is text, nothing is still generating, and the text
      // held still. Without any streaming evidence the wait additionally serves the grace period,
      // so a not-yet-started response is never mistaken for a finished one.
      if (state.text && quietSince !== undefined) {
        const required = this.stabilityWindowMs + (sawStreamingSignal ? 0 : this.quietStreamingGraceMs);
        if (now - quietSince >= required)
          return { complete: true, reason: "stable", sawStreamingSignal, finalChars: state.text.length };
      }
      await delay(this.pollIntervalMs, page);
    }
    return {
      complete: false,
      timedOut: true,
      partial: last || undefined,
      reason: "timeout",
      sawStreamingSignal,
      finalChars: last.length
    };
  }
  private async signal(page: PageLike, marker: ResponseMarker): Promise<CompletionSignal> {
    const stopControl = await this.stopControlVisible(page);
    try {
      if (page.evaluate) {
        const observed = await page.evaluate<{ text: string; streaming: boolean; id?: string }>(
          (args: { marker: ResponseMarker; selector: string }) => {
            const nodes = Array.from(document.querySelectorAll(args.selector)) as HTMLElement[];
            const node = nodes[nodes.length - 1];
            const text = node?.innerText?.trim() || "";
            const busy = node?.getAttribute("aria-busy") || "";
            const streaming =
              /generating|生成中|streaming/i.test(busy) ||
              busy === "true" ||
              node?.getAttribute("data-streaming") === "true";
            return { text, id: node?.id, streaming };
          },
          { marker, selector: RESPONSE_SELECTORS.join(", ") }
        );
        return { ...observed, streaming: observed.streaming || stopControl };
      }
    } catch {
      /* unknown means keep polling; an unreadable page is not evidence of streaming */
    }
    return { text: "", streaming: stopControl };
  }
  /** The stop-generating control by accessible name: the most reliable "still writing" signal,
   * and the one that survives Microsoft 365 renaming its internal attributes. */
  private async stopControlVisible(page: PageLike): Promise<boolean> {
    try {
      const locator = page.getByRole?.("button", { name: STOP_GENERATING_PATTERN });
      if (!locator) return false;
      const count = (await locator.count?.()) ?? 0;
      if (count < 1) return false;
      for (let index = 0; index < count; index++) {
        const control = count === 1 ? locator : locator.nth?.(index);
        if (await control?.isVisible?.()) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
async function delay(ms: number, page: PageLike): Promise<void> {
  if (page.waitForTimeout) await page.waitForTimeout(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}
