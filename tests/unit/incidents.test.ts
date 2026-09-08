import { describe, expect, it } from "vitest";
import {
  attachDiagnostics,
  diagnosticsOf,
  IncidentLog,
  isIncidentCode,
  isUiDriftCode
} from "../../src/observability/incidents.js";

describe("IncidentLog.record", () => {
  it("clamps hosts to 8 entries", () => {
    const log = new IncidentLog();
    const hosts = Array.from({ length: 12 }, (_, index) => `host-${index}.example.test`);
    log.record({ code: "AUTH_REQUIRED", message: "sign-in required", hosts });
    expect(log.list()[0]!.hosts).toEqual(hosts.slice(0, 8));
  });

  it("strips anything that is not a plain hostname before it ever reaches the log", () => {
    const log = new IncidentLog();
    log.record({
      code: "AUTH_REQUIRED",
      message: "sign-in required",
      hosts: [
        "login.example.test",
        "https://evil.example/path", // a full URL, not a bare hostname
        "host/with-slash.example",
        "host?query=1",
        "another.example.test"
      ]
    });
    expect(log.list()[0]!.hosts).toEqual(["login.example.test", "another.example.test"]);
  });

  it("omits the hosts field entirely when no incident carries one", () => {
    const log = new IncidentLog();
    log.record({ code: "BROWSER_CRASHED", message: "crashed" });
    expect(log.list()[0]).not.toHaveProperty("hosts");
  });

  it("keeps the ring-buffer bound (oldest dropped first) alongside the hosts clamp", () => {
    const log = new IncidentLog(2);
    log.record({ code: "BROWSER_CRASHED", message: "one" });
    log.record({ code: "BROWSER_CRASHED", message: "two" });
    log.record({ code: "BROWSER_CRASHED", message: "three" });
    expect(log.list().map((item) => item.message)).toEqual(["two", "three"]);
  });
});

describe("attachDiagnostics / diagnosticsOf", () => {
  it("reads back whatever was attached to the exact error instance", () => {
    const error = new Error("boom");
    attachDiagnostics(error, { hosts: ["m365.example.test"] });
    expect(diagnosticsOf(error)).toEqual({ hosts: ["m365.example.test"] });
  });

  it("merges repeated attachments onto the same error instead of overwriting", () => {
    const error = new Error("boom");
    attachDiagnostics(error, { hosts: ["m365.example.test"] });
    attachDiagnostics(error, {
      completion: { reason: "timeout", sawStreamingSignal: false, finalChars: 3 }
    });
    expect(diagnosticsOf(error)).toEqual({
      hosts: ["m365.example.test"],
      completion: { reason: "timeout", sawStreamingSignal: false, finalChars: 3 }
    });
  });

  it("never conflates diagnostics attached to a different error instance", () => {
    const errorA = new Error("a");
    const errorB = new Error("b");
    attachDiagnostics(errorA, { hosts: ["a.example.test"] });
    expect(diagnosticsOf(errorB)).toBeUndefined();
  });

  it("returns undefined for a non-object, and is a no-op for an empty diagnostics bag", () => {
    expect(diagnosticsOf("not-an-object")).toBeUndefined();
    expect(diagnosticsOf(undefined)).toBeUndefined();
    const error = new Error("boom");
    attachDiagnostics(error, {});
    expect(diagnosticsOf(error)).toBeUndefined();
  });
});

describe("isIncidentCode / isUiDriftCode", () => {
  it("treats RESPONSE_TIMEOUT as incident-worthy but not as UI drift", () => {
    expect(isIncidentCode("RESPONSE_TIMEOUT")).toBe(true);
    expect(isUiDriftCode("RESPONSE_TIMEOUT")).toBe(false);
  });

  it("never treats a routine, expected outcome as an incident", () => {
    expect(isIncidentCode("CONVERSATION_EXPIRED")).toBe(false);
    expect(isIncidentCode("RATE_LIMITED")).toBe(false);
  });
});
