import { describe, expect, it } from "vitest";
import {
  isDiscoveryDiagnostic,
  splitDiscoveryWarnings,
  summarizeDiscoveryCompleteness
} from "../../src/domain/discovery-warnings.js";

describe("splitDiscoveryWarnings", () => {
  it("keeps failure tags as warnings and moves the run's summaries to diagnostics, in order", () => {
    const lines = [
      "landing-not-rendered:unknown",
      "route:/chat/all: main=yes landmarks=div[navigation]:85",
      "no-sidebar",
      "store-catalog:items=212 attr=0 nav=10 forbidden-only=201 more=2",
      "store-catalog-failed:TimeoutError:page.click",
      "sidebar:5/5 link:32/5 scroll:0 store:route:/chat/agentstore",
      "store-shapes:lists=#0:おすすめ:12(nav=10 forbidden=1 other=1) cards=nav={attrs=class,role}",
      "description-details:stage=dialog opened=1 dialogs=1 {label=empty labelLength=0 nameNodes=1 built=1 next=span regionVisible=1 p=1 visibleP=1} count=1",
      "landing: rendered=yes main=yes"
    ];

    expect(splitDiscoveryWarnings(lines)).toEqual({
      warnings: [
        "landing-not-rendered:unknown",
        "no-sidebar",
        "store-catalog-failed:TimeoutError:page.click"
      ],
      diagnostics: [
        "route:/chat/all: main=yes landmarks=div[navigation]:85",
        "store-catalog:items=212 attr=0 nav=10 forbidden-only=201 more=2",
        "sidebar:5/5 link:32/5 scroll:0 store:route:/chat/agentstore",
        "store-shapes:lists=#0:おすすめ:12(nav=10 forbidden=1 other=1) cards=nav={attrs=class,role}",
        "description-details:stage=dialog opened=1 dialogs=1 {label=empty labelLength=0 nameNodes=1 built=1 next=span regionVisible=1 p=1 visibleP=1} count=1",
        "landing: rendered=yes main=yes"
      ]
    });
  });

  it("tells a summary from a failure tag that merely starts with the same word", () => {
    expect(isDiscoveryDiagnostic("sidebar:12/2 link:1/0 scroll:0 store:unavailable")).toBe(true);
    expect(isDiscoveryDiagnostic("sidebar-scan-failed")).toBe(false);
    expect(isDiscoveryDiagnostic("sidebar-scroll-failed")).toBe(false);
    expect(isDiscoveryDiagnostic("store-catalog-failed:unknown")).toBe(false);
    expect(isDiscoveryDiagnostic("store-unavailable")).toBe(false);
    expect(isDiscoveryDiagnostic("store-shapes:lists=#0:-:1(nav=1 forbidden=0 other=0) cards=")).toBe(true);
    expect(isDiscoveryDiagnostic("route:/chat/agentstore: main=yes")).toBe(true);
    expect(isDiscoveryDiagnostic("description-details:stage=dialog title=exact dialog=unlabelled")).toBe(
      true
    );
    expect(isDiscoveryDiagnostic("description-details-failed:dialog")).toBe(false);
  });
});

describe("summarizeDiscoveryCompleteness", () => {
  it("reports a clean run as not partial with nothing failed", () => {
    expect(
      summarizeDiscoveryCompleteness([
        "sidebar:2/2 link:1/0 scroll:0 store:route:/chat/agentstore",
        "store-catalog:items=6 attr=1 nav=3 dialog=1 open=1 forbidden-only=0 skipped=0 none=0 errors=0 off-host=0 more=1 retried=0 recovered=0 scroll=0"
      ])
    ).toEqual({ partial: false, failedCount: 0, failedCountKnown: true });
  });

  it("sums none and errors across the store-catalog line into an exact failedCount and marks the run partial", () => {
    expect(
      summarizeDiscoveryCompleteness([
        "store-catalog:items=10 attr=1 nav=4 dialog=0 open=0 forbidden-only=1 skipped=0 none=2 errors=1 off-host=0 more=2 retried=2 recovered=0 scroll=0"
      ])
    ).toEqual({ partial: true, failedCount: 3, failedCountKnown: true });
  });

  it("a card that stayed unresolved even after its retry counts as a known loss, not an unknown one", () => {
    // retried=1 alone (the card's one bounded retry) never implies a loss; only the card's final
    // outcome -- folded into none/errors -- does. See the "recovered" case below for the retry
    // that resolved the card instead.
    expect(
      summarizeDiscoveryCompleteness([
        "store-catalog:items=8 attr=0 nav=6 dialog=0 open=0 forbidden-only=0 skipped=0 none=1 errors=0 off-host=0 more=0 retried=1 recovered=0 scroll=0"
      ])
    ).toEqual({ partial: true, failedCount: 1, failedCountKnown: true });
  });

  it("a retry that recovered the card is not itself a loss", () => {
    expect(
      summarizeDiscoveryCompleteness([
        "store-catalog:items=8 attr=0 nav=7 dialog=0 open=0 forbidden-only=0 skipped=0 none=0 errors=0 off-host=0 more=0 retried=1 recovered=1 scroll=0"
      ])
    ).toEqual({ partial: false, failedCount: 0, failedCountKnown: true });
  });

  it("treats the store-catalog line's own trailing partial flag, with nothing in none/errors, as an unknown-count loss", () => {
    // The store pass can end itself partial (out of its own budget with cards left unprocessed, or
    // a genuine expansion failure while items were still arriving) without any card individually
    // failing. That is still a plausible loss -- ISSUE-2026-09-14-01 -- so failedCount floors to 1
    // and failedCountKnown says the 1 is not a real tally, rather than reporting a self-contradicting
    // "partial but 0 lost".
    expect(
      summarizeDiscoveryCompleteness([
        "store-catalog:items=500 attr=0 nav=10 dialog=0 open=0 forbidden-only=0 skipped=0 none=0 errors=0 off-host=0 more=10 retried=0 recovered=0 scroll=0 partial"
      ])
    ).toEqual({ partial: true, failedCount: 1, failedCountKnown: false });
  });

  it("marks a run partial on a bare failure tag with no attached count, flooring failedCount to 1", () => {
    for (const tag of [
      "store-expansion-failed:TimeoutError:locator.click",
      "store-catalog-failed:TimeoutError:page.click",
      "store-return-failed",
      "store-scroll-failed",
      "sidebar-scroll-failed",
      "sidebar-scan-failed",
      "link-scan-failed"
    ]) {
      expect(summarizeDiscoveryCompleteness([tag])).toEqual({
        partial: true,
        failedCount: 1,
        failedCountKnown: false
      });
    }
  });

  it("does not treat an unrelated warning or diagnostic as partial", () => {
    expect(
      summarizeDiscoveryCompleteness([
        "no-sidebar",
        "landing-not-rendered:unknown",
        "landing: rendered=yes main=yes",
        "description-retry:attempted=2 recovered=2"
      ])
    ).toEqual({ partial: false, failedCount: 0, failedCountKnown: true });
  });

  /**
   * ISSUE-2026-09-14-01 (docs/validation-log-2026-09-14-windows.md, T3): two consecutive real-tenant
   * discoveries each returned the same 10 candidates with `retried=2 errors=0 none=0`, yet both were
   * reported `partial: true, failedCount: 0` -- a self-contradicting verdict -- because a
   * `store-expansion-failed` warning fired from a "load more" click that timed out at the true end of
   * the list (see agent-discovery.ts's `expandStore`), and the old `summarizeDiscoveryCompleteness`
   * both (a) treated that bare tag as an unconditional loss and (b) never gave a tag-only loss any
   * count of its own, defaulting it to 0. This is the exact warning set from that run (reconstructed
   * from the log's documented fields; fields the log did not spell out are zeroed, which does not
   * change either verdict below).
   */
  describe("the ISSUE-2026-09-14-01 real-tenant warning set (retried=2 errors=0 none=0 + store-expansion-failed)", () => {
    const realTenantWarnings = [
      "store-catalog:items=210 attr=0 nav=10 dialog=0 open=0 forbidden-only=0 skipped=200 none=0 errors=0 off-host=0 more=2 retried=2 scroll=0 partial",
      "store-expansion-failed:TimeoutError:locator.click"
    ];

    /** The pre-fix algorithm (see git history of src/domain/discovery-warnings.ts before this
     * change): any bare failure tag, or the store-catalog line's own trailing `partial`, set
     * `partial` with no effect on `failedCount` beyond the line's own `none + errors`. */
    function summarizeBeforeFix(warnings: readonly string[]): { partial: boolean; failedCount: number } {
      const PARTIAL_FAILURE_TAGS =
        /^(?:store-expansion-failed|store-catalog-failed|store-return-failed|store-scroll-failed|sidebar-scroll-failed|sidebar-scan-failed|link-scan-failed):?/;
      let partial = false;
      let failedCount = 0;
      for (const line of warnings) {
        if (line.startsWith("store-catalog:")) {
          const none = Number(/(?:^|\s)none=(\d+)/.exec(line)?.[1] ?? 0);
          const errors = Number(/(?:^|\s)errors=(\d+)/.exec(line)?.[1] ?? 0);
          failedCount += none + errors;
          if (none + errors > 0 || / partial$/.test(line)) partial = true;
        } else if (PARTIAL_FAILURE_TAGS.test(line)) {
          partial = true;
        }
      }
      return { partial, failedCount };
    }

    it("before the fix: reported partial with a failedCount of 0 (the reported bug)", () => {
      expect(summarizeBeforeFix(realTenantWarnings)).toEqual({ partial: true, failedCount: 0 });
    });

    it("after the fix: still reports partial, but failedCount floors to 1 and is marked unknown", () => {
      expect(summarizeDiscoveryCompleteness(realTenantWarnings)).toEqual({
        partial: true,
        failedCount: 1,
        failedCountKnown: false
      });
    });
  });
});
