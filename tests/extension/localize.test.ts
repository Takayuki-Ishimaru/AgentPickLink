import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../src/domain/errors.js";
import {
  describeDiscoverySummary,
  describeErrorCode,
  pickLocale,
  translate
} from "../../src/extension/localize.js";

/** The codes whose remediation the panel shows in the user's language (I3). */
const LOCALIZED_REMEDIATION_CODES = [
  "AUTH_REQUIRED",
  "WORKSPACE_APPROVAL_REQUIRED",
  "UI_CHANGED",
  "RESPONSE_TIMEOUT",
  "BROWSER_PROFILE_LOCKED"
] as const;

describe("describeErrorCode", () => {
  it("has a Japanese and an English one-liner for every ErrorCode", () => {
    const missing = ERROR_CODES.filter(
      (code) => !describeErrorCode("ja", code)?.summary || !describeErrorCode("en", code)?.summary
    );
    expect(missing).toEqual([]);
  });

  it("keeps the two locales distinct and free of leftover placeholders", () => {
    for (const code of ERROR_CODES) {
      const ja = describeErrorCode("ja", code);
      const en = describeErrorCode("en", code);
      expect(ja?.summary, code).not.toBe(en?.summary);
      // A one-liner, not a paragraph: the original English text is rendered separately below it.
      expect(en?.summary.length, code).toBeLessThan(140);
      expect(ja?.summary, code).not.toMatch(/^TODO/);
    }
  });

  it("localizes the remediation for exactly the five most common codes", () => {
    const withRemediation = ERROR_CODES.filter((code) => describeErrorCode("ja", code)?.remediation);
    expect([...withRemediation].sort()).toEqual([...LOCALIZED_REMEDIATION_CODES].sort());
    expect(describeErrorCode("ja", "AUTH_REQUIRED")?.remediation).toContain("サインイン");
    expect(describeErrorCode("en", "AUTH_REQUIRED")?.remediation).toContain("Sign in");
  });

  it("returns nothing for a string that is not an error code", () => {
    expect(describeErrorCode("en", "NOT_A_CODE")).toBeUndefined();
    expect(describeErrorCode("ja", "")).toBeUndefined();
  });
});

describe("locale selection", () => {
  it("uses Japanese only for a ja* VS Code display language", () => {
    expect(pickLocale("ja")).toBe("ja");
    expect(pickLocale("ja-jp")).toBe("ja");
    expect(pickLocale("en-US")).toBe("en");
    expect(pickLocale(undefined)).toBe("en");
  });

  it("translates the host-side messages in both locales", () => {
    expect(translate("ja", "reload")).toBe("再読み込み");
    expect(translate("en", "reload")).toBe("Reload");
  });
});

describe("describeDiscoverySummary (WP-D)", () => {
  it("renders the count-bearing partial notice in both locales", () => {
    expect(describeDiscoverySummary({ partial: true, failedCount: 3 }, "ja")).toBe(
      "一部の候補を取得できませんでした（3 件）。再実行すると増えることがあります。"
    );
    expect(describeDiscoverySummary({ partial: true, failedCount: 3 }, "en")).toBe(
      "Some candidates could not be retrieved (3). Re-running discovery may find more."
    );
  });

  it("defaults the count to 0 when the summary carries none, and renders nothing when not partial", () => {
    expect(describeDiscoverySummary({ partial: true }, "en")).toContain("(0)");
    expect(describeDiscoverySummary({ partial: false }, "en")).toBeUndefined();
  });
});
