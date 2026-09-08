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
  async wait(
    page: PageLike,
    marker: ResponseMarker,
    timeoutMs = 300_000,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    const started = Date.now();
    let last = "";
    let stableSince = 0;
    let sawStreamingSignal = false;
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
      if (state.streaming) sawStreamingSignal = true;
      if (state.text !== last) {
        last = state.text;
        stableSince = Date.now();
      } else if (!stableSince && state.text && !state.streaming) stableSince = Date.now();
      // A response is only complete when there is text, nothing is still generating, and the text
      // held still. Without any streaming evidence the wait additionally serves the grace period,
      // so a not-yet-started response is never mistaken for a finished one.
      if (state.text && !state.streaming && stableSince) {
        const required = this.stabilityWindowMs + (sawStreamingSignal ? 0 : this.quietStreamingGraceMs);
        if (Date.now() - stableSince >= required)
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
