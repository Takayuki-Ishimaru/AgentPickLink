import { describe, expect, it } from "vitest";
import {
  classifyStatus,
  isDevMode,
  isWorkspaceSetUp,
  shouldNotifySignIn,
  showsUiDriftBanner
} from "../../src/extension/status.js";

describe("panel status classification", () => {
  it("treats sign-in failures as sign-in problems, not UI drift", () => {
    expect(classifyStatus({ errorCode: "AUTH_REQUIRED", incidentCodes: [], brokerLive: true })).toBe(
      "sign-in"
    );
    expect(classifyStatus({ errorCode: "AUTH_FAILED", incidentCodes: [], brokerLive: true })).toBe("sign-in");
  });

  it("shows UI drift only for page-structure codes", () => {
    expect(classifyStatus({ errorCode: "UI_CHANGED", incidentCodes: [], brokerLive: true })).toBe(
      "ui-changed"
    );
    expect(classifyStatus({ errorCode: "CHAT_INPUT_NOT_FOUND", incidentCodes: [], brokerLive: true })).toBe(
      "ui-changed"
    );
    expect(classifyStatus({ errorCode: "BROWSER_CRASHED", incidentCodes: [], brokerLive: true })).toBe(
      "error"
    );
    expect(classifyStatus({ errorCode: "BROWSER_PROFILE_LOCKED", incidentCodes: [], brokerLive: true })).toBe(
      "error"
    );
  });

  it("derives the idle status from broker liveness and authentication", () => {
    expect(classifyStatus({ incidentCodes: [], brokerLive: false })).toBe("stopped");
    expect(classifyStatus({ incidentCodes: [], brokerLive: true, authState: "authenticated" })).toBe("ready");
    expect(classifyStatus({ incidentCodes: [], brokerLive: true, authState: "sign-in-required" })).toBe(
      "sign-in"
    );
    expect(
      classifyStatus({ incidentCodes: ["AUTH_REQUIRED"], brokerLive: true, authState: "authenticated" })
    ).toBe("ready");
    expect(
      classifyStatus({
        incidentCodes: ["AGENT_IDENTITY_MISMATCH"],
        brokerLive: true,
        authState: "authenticated"
      })
    ).toBe("ui-changed");
  });

  it("raises the developer banner for UI drift incidents but not for operational ones", () => {
    expect(showsUiDriftBanner({ incidentCodes: ["BROWSER_CRASHED", "AUTH_REQUIRED"] })).toBe(false);
    expect(showsUiDriftBanner({ incidentCodes: ["RESPONSE_EXTRACTION_FAILED"] })).toBe(true);
    expect(showsUiDriftBanner({ errorCode: "UNSUPPORTED_UI", incidentCodes: [] })).toBe(true);
  });
});

describe("shouldNotifySignIn", () => {
  it("notifies once on the poll where the auth state transitions into sign-in-required", () => {
    const first = { authState: "authenticated", incidents: [] };
    const second = { authState: "sign-in-required", incidents: [] };
    expect(shouldNotifySignIn(first, second)).toBe(true);
    // The next poll compares to `second` (already sign-in-required): no repeat.
    expect(shouldNotifySignIn(second, second)).toBe(false);
  });

  it("notifies on a fresh transition into access-denied too, and treats the two sign-in states as equivalent for repeat suppression", () => {
    expect(shouldNotifySignIn(undefined, { authState: "access-denied", incidents: [] })).toBe(true);
    expect(
      shouldNotifySignIn(
        { authState: "sign-in-required", incidents: [] },
        { authState: "access-denied", incidents: [] }
      )
    ).toBe(false);
  });

  it("notifies again after the user signs in and is later signed out again", () => {
    const signedOut = { authState: "sign-in-required", incidents: [] };
    const signedIn = { authState: "authenticated", incidents: [] };
    expect(shouldNotifySignIn(undefined, signedOut)).toBe(true);
    expect(shouldNotifySignIn(signedOut, signedIn)).toBe(false);
    expect(shouldNotifySignIn(signedIn, signedOut)).toBe(true);
  });

  it("notifies once for a new AUTH_REQUIRED/AUTH_FAILED incident, tracked by `at`, even without an auth-state transition", () => {
    const previous = { authState: "authenticated", incidents: [] };
    const withIncident = {
      authState: "authenticated",
      incidents: [{ at: "2026-09-05T00:00:00.000Z", code: "AUTH_REQUIRED" as const }]
    };
    expect(shouldNotifySignIn(previous, withIncident)).toBe(true);
    // Same incident (same `at`) on the next poll: no repeat.
    expect(shouldNotifySignIn(withIncident, withIncident)).toBe(false);
  });

  it("ignores incidents unrelated to sign-in, and never notifies once with no previous poll and nothing wrong", () => {
    const withUnrelatedIncident = {
      authState: "authenticated",
      incidents: [{ at: "2026-09-05T00:00:00.000Z", code: "UI_CHANGED" as const }]
    };
    expect(shouldNotifySignIn(undefined, withUnrelatedIncident)).toBe(false);
    expect(shouldNotifySignIn(undefined, { authState: "authenticated", incidents: [] })).toBe(false);
  });
});

describe("isDevMode", () => {
  it("is true when either dev-mode flag is set, false otherwise", () => {
    expect(isDevMode({ devMode: { insecureLoopback: true, devAppUrl: false } })).toBe(true);
    expect(isDevMode({ devMode: { insecureLoopback: false, devAppUrl: true } })).toBe(true);
    expect(isDevMode({ devMode: { insecureLoopback: false, devAppUrl: false } })).toBe(false);
    expect(isDevMode({})).toBe(false);
    expect(isDevMode(undefined)).toBe(false);
  });
});

describe("isWorkspaceSetUp", () => {
  it("is true only for a configured workspace whose local approval is current", () => {
    expect(isWorkspaceSetUp({ configured: true, approvalStatus: "approved" })).toBe(true);
    for (const approvalStatus of ["approval-required", "binding-mismatch", "invalid", "not-configured"])
      expect(isWorkspaceSetUp({ configured: true, approvalStatus })).toBe(false);
    expect(isWorkspaceSetUp({ configured: false, approvalStatus: "approved" })).toBe(false);
  });
});
