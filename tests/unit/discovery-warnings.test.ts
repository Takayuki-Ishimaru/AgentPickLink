import { describe, expect, it } from "vitest";
import { isDiscoveryDiagnostic, splitDiscoveryWarnings } from "../../src/domain/discovery-warnings.js";

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
