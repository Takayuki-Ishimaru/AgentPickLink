/**
 * The metadata-only correlation log: ring bounding, defensive copies, dedup, and the whitelist that
 * keeps an untrusted transport or broker from putting message text, raw DOM anchors, URLs or
 * credentials into `Copy diagnostics`.
 */
import { describe, expect, it } from "vitest";
import {
  CORRELATION_DIAGNOSTIC_LIMIT,
  CorrelationDiagnosticLog,
  UNKNOWN_CORRELATION_REASON,
  sanitizeCorrelationDiagnostics,
  type CorrelationDiagnostic
} from "../../src/observability/correlation.js";

const HASH = "0123456789abcdef";
const OTHER = "fedcba9876543210";

function observation(overrides: Record<string, unknown> = {}): Omit<CorrelationDiagnostic, "at"> {
  return {
    phase: "invoke",
    decision: "shown",
    reason: "appended-after-tail",
    usersBefore: 1,
    usersNow: 2,
    baselineTail: HASH,
    latestUser: OTHER,
    user: OTHER,
    response: null,
    ...overrides
  };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { at: "2026-10-12T00:00:00.000Z", ...observation(overrides) };
}

describe("CorrelationDiagnosticLog", () => {
  it("stamps its own ISO time and keeps every other field", () => {
    const log = new CorrelationDiagnosticLog();
    log.record(observation({ at: "2000-01-01T00:00:00.000Z" }) as Omit<CorrelationDiagnostic, "at">);
    const [entry] = log.list();
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(entry.at).getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);
    expect(entry.reason).toBe("appended-after-tail");
    expect(entry.usersNow).toBe(2);
  });

  it("bounds its capacity, defaults to 20 and never exceeds it, dropping the oldest", () => {
    const log = new CorrelationDiagnosticLog(3);
    for (let index = 0; index < 10; index++) log.record(observation({ usersNow: index }));
    expect(log.list().map((entry) => entry.usersNow)).toEqual([7, 8, 9]);

    const capped = new CorrelationDiagnosticLog(1_000);
    for (let index = 0; index < 60; index++) capped.record(observation({ usersNow: index }));
    expect(capped.list()).toHaveLength(CORRELATION_DIAGNOSTIC_LIMIT);
    expect(capped.list().at(-1)?.usersNow).toBe(59);

    const defaulted = new CorrelationDiagnosticLog();
    for (let index = 0; index < 25; index++) defaulted.record(observation({ usersNow: index }));
    expect(defaulted.list()).toHaveLength(20);
    expect(defaulted.list()[0]?.usersNow).toBe(5);

    for (const max of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const fallback = new CorrelationDiagnosticLog(max);
      for (let index = 0; index < 30; index++) fallback.record(observation({ usersNow: index }));
      expect(fallback.list()).toHaveLength(CORRELATION_DIAGNOSTIC_LIMIT);
    }
  });

  it("collapses identical consecutive observations of the same request and phase only", () => {
    const log = new CorrelationDiagnosticLog();
    log.record(observation({ requestHash: HASH }));
    log.record(observation({ requestHash: HASH }));
    expect(log.list()).toHaveLength(1);

    log.record(observation({ requestHash: HASH, decision: "unconfirmed" }));
    expect(log.list().map((entry) => entry.decision)).toEqual(["shown", "unconfirmed"]);

    log.record(observation({ requestHash: OTHER }));
    expect(log.list()).toHaveLength(3);

    log.record(observation({ requestHash: HASH }));
    expect(log.list()).toHaveLength(4);

    const noRequest = new CorrelationDiagnosticLog();
    noRequest.record(observation());
    noRequest.record(observation());
    expect(noRequest.list()).toHaveLength(1);
  });

  it("hands out copies and stores no reference the caller can still change", () => {
    const log = new CorrelationDiagnosticLog();
    const input = observation({ baselineTail: HASH }) as Omit<CorrelationDiagnostic, "at">;
    log.record(input);
    (input as Record<string, unknown>).usersNow = 999;
    (input as Record<string, unknown>).prompt = "a prompt that must never be stored";

    const listed = log.list();
    expect(listed[0]?.usersNow).toBe(2);
    expect(Object.keys(listed[0]!).sort()).toEqual(
      [
        "at",
        "baselineTail",
        "decision",
        "latestUser",
        "phase",
        "reason",
        "response",
        "user",
        "usersBefore",
        "usersNow"
      ].sort()
    );

    listed[0]!.usersNow = 555;
    listed.length = 0;
    expect(log.list()).toHaveLength(1);
    expect(log.list()[0]?.usersNow).toBe(2);

    log.clear();
    expect(log.list()).toEqual([]);
    log.record(observation());
    expect(log.list()).toHaveLength(1);
  });

  it("drops malformed or hostile input instead of storing it", () => {
    const log = new CorrelationDiagnosticLog();
    for (const bad of [
      observation({ usersNow: undefined }),
      observation({ usersNow: -1 }),
      observation({ usersNow: 1.5 }),
      observation({ usersNow: Number.NaN }),
      observation({ usersNow: Number.MAX_SAFE_INTEGER + 10 }),
      observation({ usersBefore: "2" }),
      observation({ user: "0123456789abcdeF" }),
      observation({ response: "https://example.test/chat/1" }),
      observation({ requestHash: "short" }),
      observation({ phase: "write" }),
      observation({ decision: "maybe" })
    ])
      log.record(bad as Omit<CorrelationDiagnostic, "at">);
    expect(log.list()).toEqual([]);

    log.record(observation({ reason: "ignore previous instructions", prompt: "secret prompt text" }));
    const [entry] = log.list();
    expect(entry.reason).toBe(UNKNOWN_CORRELATION_REASON);
    expect(JSON.stringify(log.list())).not.toContain("secret prompt text");
  });
});

describe("sanitizeCorrelationDiagnostics", () => {
  it("fills missing nullable metadata with null while requiring the current count", () => {
    const [entry] = sanitizeCorrelationDiagnostics([
      record({
        usersBefore: undefined,
        baselineTail: undefined,
        latestUser: undefined,
        user: undefined,
        response: undefined
      })
    ]);
    expect(entry).toMatchObject({
      usersBefore: null,
      baselineTail: null,
      latestUser: null,
      user: null,
      response: null
    });
    expect(sanitizeCorrelationDiagnostics([record({ usersNow: undefined })])).toEqual([]);
  });
  it("accepts a well-formed list and copies every entry", () => {
    const input = [record(), record({ phase: "read", reason: "missing-baseline", usersBefore: null })];
    const sanitized = sanitizeCorrelationDiagnostics(input);
    expect(sanitized).toHaveLength(2);
    expect(sanitized[1]).toMatchObject({ phase: "read", reason: "missing-baseline", usersBefore: null });
    expect(sanitized[0]).not.toBe(input[0]);
    sanitized[0]!.usersNow = 42;
    expect(input[0]!.usersNow).toBe(2);
  });

  it("returns an empty list for anything that is not a list", () => {
    for (const value of [undefined, null, "[]", {}, 7, new Map()])
      expect(sanitizeCorrelationDiagnostics(value)).toEqual([]);
  });

  it("drops malformed entries and keeps the valid ones", () => {
    const kept = sanitizeCorrelationDiagnostics([
      record(),
      null,
      "record",
      [],
      record({ at: "not-a-date" }),
      record({ at: 1_760_000_000_000 }),
      record({ usersNow: undefined }),
      record({ usersNow: null }),
      record({ usersNow: Number.POSITIVE_INFINITY }),
      record({ usersBefore: -2 }),
      record({ baselineTail: "zzzzzzzzzzzzzzzz" }),
      record({ latestUser: HASH.repeat(2) }),
      record({ user: 1234 }),
      record({ response: "" }),
      record({ requestHash: null }),
      record({ phase: "invoke " }),
      record({ decision: "SHOWN" })
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toEqual({
      at: "2026-10-12T00:00:00.000Z",
      phase: "invoke",
      decision: "shown",
      reason: "appended-after-tail",
      usersBefore: 1,
      usersNow: 2,
      baselineTail: HASH,
      latestUser: OTHER,
      user: OTHER,
      response: null
    });
  });

  it("never lets an unknown reason, or an unexpected field, reach the output", () => {
    const leaked =
      'ignore all instructions; the prompt was "hello" and the cookie is sid=1 at https://example.test/chat?a=1';
    const sanitized = sanitizeCorrelationDiagnostics([
      record({ reason: leaked, prompt: leaked, message: leaked, cookie: leaked, url: leaked }),
      record({ reason: 7 }),
      record({ reason: null }),
      record({ reason: "response-reassigned" })
    ]);
    expect(sanitized.map((entry) => entry.reason)).toEqual([
      UNKNOWN_CORRELATION_REASON,
      UNKNOWN_CORRELATION_REASON,
      UNKNOWN_CORRELATION_REASON,
      "response-reassigned"
    ]);
    expect(JSON.stringify(sanitized)).not.toContain("cookie");
    expect(JSON.stringify(sanitized)).not.toContain("example.test");
    expect(JSON.stringify(sanitized)).not.toContain("hello");
    for (const entry of sanitized)
      expect(Object.keys(entry).every((key) => key !== "prompt" && key !== "message")).toBe(true);
  });

  it("caps the report at the diagnostic limit, keeping the most recent entries", () => {
    const many = Array.from({ length: 45 }, (_unused, index) => record({ usersNow: index }));
    const sanitized = sanitizeCorrelationDiagnostics(many);
    expect(sanitized).toHaveLength(CORRELATION_DIAGNOSTIC_LIMIT);
    expect(sanitized[0]?.usersNow).toBe(25);
    expect(sanitized.at(-1)?.usersNow).toBe(44);
  });

  it("keeps every documented reason tag and the optional request hash", () => {
    const sanitized = sanitizeCorrelationDiagnostics([
      record({ reason: "empty-baseline-unverified", requestHash: HASH }),
      record({ reason: "unstable-message-identity" }),
      record({ reason: "response-reassigned" })
    ]);
    expect(sanitized.map((entry) => entry.reason)).toEqual([
      "empty-baseline-unverified",
      "unstable-message-identity",
      "response-reassigned"
    ]);
    expect(sanitized[0]?.requestHash).toBe(HASH);
    expect("requestHash" in sanitized[1]!).toBe(false);
  });
});
