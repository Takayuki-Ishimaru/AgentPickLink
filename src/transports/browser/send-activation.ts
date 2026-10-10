import { randomUUID } from "node:crypto";
import { composerTextMatches, normalizeComposerText, readDomPlainText } from "./composer-text.js";
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
/** Arming the gate for a checked press finds the composer and reads it and the page context. A
 * renderer that cannot do that in this time gets no press at all, since nothing would check it. */
const SEND_GATE_ARM_TIMEOUT_MS = 5_000;
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

/** What changed after the message and its recipient were verified: the composer, or the page
 * context that names the agent and the conversation. */
export type SendPressChange = "composer" | "context";

/** The not-sent failure for a press that was refused because something it depends on changed. */
export function changedBeforePress(change: SendPressChange): BrowserTransportError {
  return change === "composer"
    ? new BrowserTransportError(
        "UI_CHANGED",
        "The composer changed after the message was verified, before the send control was pressed, so the message was not sent.",
        undefined,
        { submissionState: "not-sent" }
      )
    : new BrowserTransportError(
        "AGENT_CONTEXT_CHANGED",
        "The agent, the conversation or the page address changed after the message was verified, before the send control was pressed, so the message was not sent.",
        undefined,
        { submissionState: "not-sent" }
      );
}

/** The not-sent failure for a checked press whose gate could not be armed: nothing would have
 * checked the press, so it is not made. */
function gateUnavailable(): BrowserTransportError {
  return new BrowserTransportError(
    "UI_CHANGED",
    "The page could not be prepared to check the press, so the send control was not pressed and the message was not sent.",
    undefined,
    { submissionState: "not-sent" }
  );
}

/** Where the page context that a press is compared against is read (see sendGateScript). */
export type SendPressContextScope = {
  /** Finds a composer the page re-rendered: the single visible, enabled match. */
  composerSelector: string;
  /** Attributes that name the agent or the conversation. */
  contextAttributes: readonly string[];
  /** The page's main region; context attributes count inside it and on the composer's ancestors. */
  mainSelector: string;
  /** Regions inside it that are not the page's own context, such as messages: ignored. */
  ignoredSelector: string;
};

/** What the page-side gate requires at every press. */
export type SendPressCheck = SendPressContextScope & {
  /** The requested message, which the composer must still hold, compared the way the broker's own
   * verification compares it. */
  message: string;
  /** The page context when the message was verified (capturePressContext). Without it, the context
   * when the gate was armed is the reference. */
  context?: string;
};

export type SendActivationOptions = {
  /** Overrides SEND_CLICKABLE_TIMEOUT_MS. */
  clickableTimeoutMs?: number;
  /** Overrides SEND_GATE_ARM_TIMEOUT_MS. */
  gateArmTimeoutMs?: number;
  /** Metadata-only description of the controls around the composer, for a not-clickable failure. */
  diagnostics(): Promise<unknown>;
  /** The message and recipient verified before submission, which must still hold when the control
   * is pressed. Without it, only cancellation is guarded. */
  press?: {
    /** The composer, found the way the adapter found it for the verification. */
    composer(): Promise<LocatorLike>;
    /** Verifies everything again in the broker once the control is clickable and the gate is armed;
     * rejects when anything changed. */
    verify(): Promise<void>;
    /** Checked by the gate at the press itself, which closes the window after `verify`. */
    check: SendPressCheck;
  };
};

/**
 * Clicks the send control at most once, so that a cancellation never turns into a later press,
 * and only while the message and its recipient are still the ones verified before submission.
 *
 * Waiting happens only through trial clicks: Playwright performs the full actionability check and
 * blocks the trial's press before it reaches the page's UI, so a covered, animating, re-rendered or
 * disabled control is waited for in bounded slices that end at a cancellation check, with no click
 * pending in between. Once a trial succeeds a page-side gate is armed on the composer element
 * itself, and the caller's verification runs again: the wait can last seconds, long enough for the
 * composer to change or the page to show another agent or conversation, and anything verified before
 * submission that no longer holds ends the request without a press. A checked press whose gate
 * cannot be armed is not made either. After a last cancellation check the real click starts. The
 * gate watches its presses: a cancellation closes it, and so does a press that finds the composer no
 * longer holding the message or the page context changed since the verification. A closed gate
 * swallows the press before the document or any element sees it, so neither a late press nor a press
 * of changed content can submit, and its count then tells the press that reached the page apart from
 * the one that was swallowed. A real click that fails leaves its press unaccounted for, so it
 * reports `unknown` and is never repeated.
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
  let gated: boolean;
  if (options.press) {
    const arming = asGateArming(
      await armOnComposer(options.press, key, options.gateArmTimeoutMs ?? SEND_GATE_ARM_TIMEOUT_MS)
    );
    if (arming?.armed !== true) {
      // Nothing is pressed. An arming that is still running in a slow renderer runs before this
      // removal does, so its gate cannot outlive the activation.
      await callSendGate(page, key, "finish");
      throw arming ? changedBeforePress(arming.change) : gateUnavailable();
    }
    gated = true;
  } else gated = asGateArming(await callSendGate(page, key, "install"))?.armed === true;
  let closing: Promise<unknown> | undefined;
  const close = () => {
    closing ??= gated ? callSendGate(page, key, "close") : Promise.resolve();
  };
  signal?.addEventListener("abort", close, { once: true });
  let refusal: { error: unknown } | undefined;
  let attempted = false;
  let clicked = false;
  try {
    if (options.press) {
      try {
        await options.press.verify();
      } catch (error) {
        refusal = { error };
      }
    }
    // The final cancellation check: from here on a cancellation closes the gate instead.
    if (!refusal && !signal?.aborted) {
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
  // Always, so that a gate whose install answer was lost in a slow renderer is removed too.
  const finished = await callSendGate(page, key, "finish");
  const record = gated ? asGateRecord(finished) : undefined;
  if (refusal) throw refusal.error;
  if (!attempted) throw cancelledBeforeSubmission();
  if (!clicked)
    throw new BrowserTransportError(
      "SUBMIT_STATE_UNKNOWN",
      "The send control was activated, but submission acknowledgement could not be established.",
      undefined,
      { submissionState: "unknown" }
    );
  // A resolved click has had its press dispatched, so the record is complete. Swallowed and none
  // delivered means the page never saw it; anything else counts as activated, and the
  // acknowledgement wait decides between sent and unknown.
  if (record && record.passed === 0 && record.blocked > 0)
    throw record.change ? changedBeforePress(record.change) : cancelledBeforeSubmission();
}

/** The page context a press will be compared against, read for the composer the adapter found,
 * when the message is verified. Undefined when the page cannot report it. */
export async function capturePressContext(
  composer: LocatorLike,
  scope: SendPressContextScope
): Promise<string | undefined> {
  if (!composer.evaluate) return undefined;
  const context = await withinTimeout(
    composer.evaluate(sendGateOnComposer, gateArgs("", "context", { ...scope, message: "" }), {
      timeout: SEND_GATE_CALL_TIMEOUT_MS
    }),
    SEND_GATE_CALL_TIMEOUT_MS
  );
  return typeof context === "string" ? context : undefined;
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

/** Presses the gate let through and swallowed, and the change that closed it, if one did. */
type SendGateRecord = { passed: number; blocked: number; change?: SendPressChange };
type SendGateArming = { armed: true } | { armed: false; change: SendPressChange };
type SendGateArgs = {
  key: string;
  op: "context" | "install" | "close" | "finish";
  events: string[];
  expiryMs: number;
  press?: SendPressCheck;
};
type SendGateText = {
  read(element: Element): string | undefined;
  matches(observed: string, requested: string): boolean;
};

function gateArgs(key: string, op: SendGateArgs["op"], press?: SendPressCheck): SendGateArgs {
  return { key, op, events: SEND_GATE_EVENTS, expiryMs: SEND_GATE_EXPIRY_MS, ...(press ? { press } : {}) };
}

/** Arms the gate on the composer the adapter finds, so the gate watches exactly the element that was
 * verified (Playwright's lookup reaches into shadow roots and knows its own visibility rules; a
 * page-side query would not). A composer that can no longer be found is a changed composer. */
async function armOnComposer(
  press: NonNullable<SendActivationOptions["press"]>,
  key: string,
  timeoutMs: number
): Promise<unknown> {
  let composer: LocatorLike;
  try {
    composer = await press.composer();
  } catch {
    return { armed: false, change: "composer" };
  }
  if (!composer.evaluate) return undefined;
  return withinTimeout(
    composer.evaluate(sendGateOnComposer, gateArgs(key, "install", press.check), { timeout: timeoutMs }),
    timeoutMs
  );
}

async function callSendGate(
  page: PageLike,
  key: string,
  op: "install" | "close" | "finish"
): Promise<unknown> {
  if (!page.evaluate) return undefined;
  return withinTimeout(page.evaluate<unknown>(sendGateScript, gateArgs(key, op)), SEND_GATE_CALL_TIMEOUT_MS);
}

/** The page call's answer, or undefined when it failed or did not arrive in time. */
async function withinTimeout(call: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  call.catch(() => undefined);
  try {
    return await Promise.race([
      call,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
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
  const { passed, blocked, change } = value as Record<string, unknown>;
  if (typeof passed !== "number" || typeof blocked !== "number") return undefined;
  return change === "composer" || change === "context" ? { passed, blocked, change } : { passed, blocked };
}

function asGateArming(value: unknown): SendGateArming | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { armed, change } = value as Record<string, unknown>;
  if (armed === true) return { armed: true };
  return change === "composer" || change === "context" ? { armed: false, change } : undefined;
}

/** sendGateScript run on the composer element, with the composer reader and comparison of the
 * broker's own verification (composer-text.ts), so the gate judges the composer exactly as the
 * verification did. Page code cannot import: the three sources are composed into the one function
 * text Playwright sends to the page, where it is compiled like any page function. Nothing is
 * compiled in the broker; calling this function here only throws. */
const sendGateOnComposer = Object.assign(
  (_composer: Element, _args: SendGateArgs): unknown => {
    throw new Error("sendGateOnComposer runs in the page only.");
  },
  {
    toString: () =>
      [
        "function sendGateOnComposer(composer, args) {",
        `const normalizeComposerText = ${normalizeComposerText.toString()};`,
        `const composerTextMatches = ${composerTextMatches.toString()};`,
        `const readDomPlainText = ${readDomPlainText.toString()};`,
        `return (${sendGateScript.toString()})(args, composer, { read: readDomPlainText, matches: composerTextMatches });`,
        "}"
      ].join("\n")
  }
);

/** Page-side and self-contained (Playwright serialises it; see sendGateOnComposer for the composer
 * reader it is given). One send activation's gate: a capture listener on window, which runs before
 * any listener on the document or an element, counts trusted presses while the gate is open and
 * swallows them once it is closed. `close` closes it (a cancellation); `finish` closes it, removes it
 * and returns its counts, and a key once finished can never be armed afterwards, so an install that
 * reaches the page late cannot leave a gate behind. Arming removes any gate a lost activation left
 * behind as well: a page has one send activation at a time.
 *
 * Armed on the composer with `press`, the gate also requires, at every press, the composer to still
 * hold the requested message (as the reader reads it and the comparison accepts it) and the page
 * context to be the one captured when the message was verified: the address without query or
 * fragment, the composer's own labels, and the agent and conversation attributes inside the main
 * region outside messages and on the composer's ancestors. A composer the page re-rendered is
 * replaced by the single visible, enabled composer the page then shows. Arming already fails when
 * either no longer holds. Each press is judged as it starts, at pointerdown, before any of the page's
 * own handlers for it run, and the rest of that press follows the decision; a judgment that throws
 * counts as a change. A press that finds a change closes the gate and is swallowed with the rest.
 * `context` reports the context for the composer it runs on. Exported for tests. */
export function sendGateScript(
  args: SendGateArgs,
  composer?: Element,
  text?: SendGateText
): SendGateRecord | SendGateArming | string | boolean {
  type Gate = { record: SendGateRecord; closed: boolean; pressing: boolean; remove: () => void };
  const host = window as unknown as Record<symbol, Map<string, Gate> | Set<string> | undefined>;
  const gates = (host[Symbol.for("agentpicklink.send-gate")] ??= new Map<string, Gate>()) as Map<
    string,
    Gate
  >;
  // Activations already finished: an install that reaches the page after its activation gave up
  // on it (a slow renderer, an install whose lookup took several round trips) must not arm.
  const finished = (host[Symbol.for("agentpicklink.send-gate.finished")] ??=
    new Set<string>()) as Set<string>;
  const press = args.press;
  const contextOf = (element: Element | undefined): string => {
    if (!press) return "";
    const named = press.contextAttributes.map((name) => `[${name}]`).join(", ");
    const found = new Set<Element>();
    for (const main of document.querySelectorAll(press.mainSelector)) {
      if (main.matches(named)) found.add(main);
      for (const node of main.querySelectorAll(named))
        if (!node.parentElement?.closest(press.ignoredSelector)) found.add(node);
    }
    for (let node = element?.parentElement; node; node = node.parentElement)
      if (node.matches(named)) found.add(node);
    return JSON.stringify([
      location.origin + location.pathname,
      ["aria-label", "placeholder", "title"].map((name) => element?.getAttribute(name) ?? null),
      [...found].map((node) => press.contextAttributes.map((name) => node.getAttribute(name)))
    ]);
  };
  if (args.op === "context") return contextOf(composer);
  if (args.op === "install") {
    if (finished.has(args.key)) return false;
    for (const stale of [...gates.values()]) stale.remove();
    let changed: (() => SendPressChange | undefined) | undefined;
    if (press && composer && text) {
      const usable = (element: Element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility === "visible" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0 &&
          !(element as HTMLTextAreaElement).disabled &&
          element.getAttribute("aria-disabled") !== "true"
        );
      };
      const reference = press.context ?? contextOf(composer);
      let current = composer;
      const judge = (): SendPressChange | undefined => {
        if (!current.isConnected) {
          const found = [...document.querySelectorAll(press.composerSelector)].filter(usable);
          if (found.length !== 1) return "composer";
          current = found[0]!;
        }
        if (!text.matches(text.read(current) ?? "", press.message)) return "composer";
        return contextOf(current) === reference ? undefined : "context";
      };
      const change = judge();
      if (change) return { armed: false, change };
      changed = () => {
        try {
          return judge();
        } catch {
          return "composer";
        }
      };
    }
    const gate: Gate = {
      record: { passed: 0, blocked: 0 },
      closed: false,
      pressing: false,
      remove: () => undefined
    };
    const listener = (event: Event) => {
      if (!event.isTrusted) return;
      if (changed && !gate.closed && (event.type === "pointerdown" || !gate.pressing)) {
        const change = changed();
        if (change) {
          gate.closed = true;
          gate.record.change = change;
        } else gate.pressing = true;
      }
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
    return { armed: true };
  }
  if (args.op === "finish") {
    finished.add(args.key);
    // Bounded: only an install still on its way to the page needs its key.
    for (const old of finished) if (finished.size > 32) finished.delete(old);
  }
  const gate = gates.get(args.key);
  if (!gate) return false;
  gate.closed = true;
  if (args.op === "close") return true;
  gate.remove();
  return { ...gate.record };
}
