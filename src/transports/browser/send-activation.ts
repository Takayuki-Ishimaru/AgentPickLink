import { randomUUID } from "node:crypto";
import { BrowserTransportError, type LocatorLike, type PageLike } from "./types.js";

/** How long a unique, enabled send control may stay unconfirmed as clickable (covered, moving,
 * disabled again, or not rendering) before the request fails as not sent. */
export const SEND_CLICKABLE_TIMEOUT_MS = 10_000;
/** Budget of the first trial click, doubled after each one that times out, up to the maximum. A
 * trial runs every actionability check of a real click (visible, enabled, stable, not covered) and
 * Playwright swallows its press in a window capture listener, before it reaches the document or any
 * element, so nothing is left pending when a slice ends at the next cancellation check. One slice
 * must hold a complete check, and its stability part alone spans two animation frames: hundredths
 * of a second on a visible page, but about half a second in the hidden Windows browser
 * (docs/windows-description-verification-2026-09-08.md measured five frames in 1.2 s). A slice that
 * is too short never succeeds there, while a long one only delays a cancellation's return until the
 * current check ends; it can never cause a click. */
const SEND_TRIAL_FIRST_SLICE_MS = 1_000;
const SEND_TRIAL_MAX_SLICE_MS = 2_000;
/** The real click follows a successful trial, so it normally completes within a few frames. The
 * margin is for slow machines: a click that times out is reported `unknown`, and a cancellation
 * while it runs is handled by the gate, not by this bound. */
const SEND_CLICK_TIMEOUT_MS = 5_000;
/** Each gate call is one small page script; a renderer that cannot answer it is treated as giving
 * no evidence. */
const SEND_GATE_CALL_TIMEOUT_MS = 2_000;
/** A gate whose finish call never arrived (a lost page or broker) removes itself after this. */
const SEND_GATE_EXPIRY_MS = 30_000;
/** Press events of a click, as Playwright's own hit-target interceptor lists them. */
const SEND_GATE_EVENTS = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu"
];

export function cancelledBeforeSubmission(): BrowserTransportError {
  return new BrowserTransportError(
    "SUBMIT_FAILED",
    "The request was cancelled before submission.",
    undefined,
    { submissionState: "not-sent" }
  );
}

export type SendActivationOptions = {
  /** Overrides SEND_CLICKABLE_TIMEOUT_MS. */
  clickableTimeoutMs?: number;
  /** Metadata-only description of the controls around the composer, for a not-clickable failure. */
  diagnostics(): Promise<unknown>;
};

/**
 * Clicks the send control at most once, so that a cancellation never turns into a later press.
 *
 * Waiting happens only through trial clicks: Playwright performs the full actionability check and
 * blocks the trial's press before it reaches the page's UI, so a covered, animating, re-rendered or
 * disabled control is waited for in bounded slices that end at a cancellation check, with no click
 * pending in between. Only after a trial succeeds, and after a last cancellation check, does the
 * real click start. During that click a page-side gate watches the presses: a cancellation closes
 * it, and from then on it swallows the press before the document or any element sees it, so a
 * press that arrives late cannot submit. The gate's count then tells the press that reached the
 * page apart from the one that was swallowed. A real click that fails leaves its press unaccounted
 * for, so it reports `unknown` and is never repeated.
 */
export async function activateSendControl(
  page: PageLike,
  send: LocatorLike,
  signal: AbortSignal | undefined,
  options: SendActivationOptions
): Promise<void> {
  const click = send.click?.bind(send);
  if (!click) throw new Error("The send control cannot be clicked.");
  await waitUntilClickable(click, signal, options);
  if (signal?.aborted) throw cancelledBeforeSubmission();
  const key = randomUUID();
  const gated = (await callSendGate(page, key, "install")) === true;
  let closing: Promise<unknown> | undefined;
  const close = () => {
    closing ??= gated ? callSendGate(page, key, "close") : Promise.resolve();
  };
  signal?.addEventListener("abort", close, { once: true });
  let attempted = false;
  let clicked = false;
  try {
    // The final cancellation check: from here on a cancellation closes the gate instead.
    if (!signal?.aborted) {
      attempted = true;
      await click({ timeout: SEND_CLICK_TIMEOUT_MS });
      clicked = true;
    }
  } catch {
    // Classified below. Playwright's message can describe page content; it is never surfaced.
  } finally {
    signal?.removeEventListener("abort", close);
  }
  await closing;
  const record = gated ? asGateRecord(await callSendGate(page, key, "finish")) : undefined;
  if (!attempted) throw cancelledBeforeSubmission();
  if (!clicked)
    throw new BrowserTransportError(
      "SUBMIT_STATE_UNKNOWN",
      "The send control was activated, but submission acknowledgement could not be established.",
      "Inspect the existing conversation before deciding whether to send again.",
      { submissionState: "unknown" }
    );
  // A resolved click has had its press dispatched, so the record is complete. Swallowed and none
  // delivered means the page never saw it; anything else counts as activated, and the
  // acknowledgement wait decides between sent and unknown.
  if (record && record.passed === 0 && record.blocked > 0) throw cancelledBeforeSubmission();
}

async function waitUntilClickable(
  click: NonNullable<LocatorLike["click"]>,
  signal: AbortSignal | undefined,
  options: SendActivationOptions
): Promise<void> {
  const budgetMs = options.clickableTimeoutMs ?? SEND_CLICKABLE_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  let slice = SEND_TRIAL_FIRST_SLICE_MS;
  for (;;) {
    if (signal?.aborted) throw cancelledBeforeSubmission();
    let failure: unknown;
    try {
      await click({ trial: true, timeout: Math.max(1, Math.min(slice, deadline - Date.now())) });
      return;
    } catch (error) {
      failure = error;
    }
    if (signal?.aborted) throw cancelledBeforeSubmission();
    const timedOut = failure instanceof Error && failure.name === "TimeoutError";
    if (timedOut && Date.now() < deadline) {
      slice = Math.min(slice * 2, SEND_TRIAL_MAX_SLICE_MS);
      continue;
    }
    const sendDiagnostics = await options.diagnostics();
    throw new BrowserTransportError(
      "UI_CHANGED",
      `${
        timedOut
          ? `The send control could not be confirmed clickable within ${Math.round(budgetMs / 100) / 10} s (covered, moving, disabled or not rendering)`
          : "The send control changed before it could be clicked"
      }, so the message was not sent. Visible nearby controls=${JSON.stringify(sendDiagnostics)}.`,
      undefined,
      { submissionState: "not-sent", sendDiagnostics }
    );
  }
}

type SendGateRecord = { passed: number; blocked: number };

async function callSendGate(
  page: PageLike,
  key: string,
  op: "install" | "close" | "finish"
): Promise<unknown> {
  if (!page.evaluate) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = page.evaluate<unknown>(sendGateScript, {
      key,
      op,
      events: SEND_GATE_EVENTS,
      expiryMs: SEND_GATE_EXPIRY_MS
    });
    call.catch(() => undefined);
    return await Promise.race([
      call,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), SEND_GATE_CALL_TIMEOUT_MS);
      })
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function asGateRecord(value: unknown): SendGateRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { passed, blocked } = value as Record<string, unknown>;
  return typeof passed === "number" && typeof blocked === "number" ? { passed, blocked } : undefined;
}

/** Page-side and self-contained (Playwright serialises it). One send activation's gate: a capture
 * listener on window, which runs before any listener on the document or an element, counts trusted
 * presses while the gate is open and swallows them once it is closed. `finish` closes the gate,
 * removes it and returns its counts. Exported for tests. */
export function sendGateScript(args: {
  key: string;
  op: "install" | "close" | "finish";
  events: string[];
  expiryMs: number;
}): SendGateRecord | boolean {
  type Gate = { record: SendGateRecord; closed: boolean; remove: () => void };
  const host = window as unknown as Record<symbol, Map<string, Gate> | undefined>;
  const slot = Symbol.for("agentpicklink.send-gate");
  const gates = (host[slot] ??= new Map<string, Gate>());
  if (args.op === "install") {
    const gate: Gate = { record: { passed: 0, blocked: 0 }, closed: false, remove: () => undefined };
    const listener = (event: Event) => {
      if (!event.isTrusted) return;
      if (!gate.closed) {
        gate.record.passed++;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      gate.record.blocked++;
    };
    for (const type of args.events)
      window.addEventListener(type, listener, { capture: true, passive: false });
    const expiry = setTimeout(() => gate.remove(), args.expiryMs);
    gate.remove = () => {
      clearTimeout(expiry);
      for (const type of args.events) window.removeEventListener(type, listener, { capture: true });
      gates.delete(args.key);
    };
    gates.set(args.key, gate);
    return true;
  }
  const gate = gates.get(args.key);
  if (!gate) return false;
  gate.closed = true;
  if (args.op === "close") return true;
  gate.remove();
  return { passed: gate.record.passed, blocked: gate.record.blocked };
}
