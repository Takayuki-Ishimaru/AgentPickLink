/**
 * Pure status classification for the status bar and the panel banner, kept free of `vscode` so
 * it can be unit-tested. The distinction matters for the user: a sign-in problem or a browser
 * process failure is operational ("sign in" / "restart"), whereas UI drift is the one case that
 * should send them to the developer.
 */
import type { ErrorCode } from "../domain/errors.js";
import { isUiDriftCode } from "../observability/incidents.js";
import type { Incident } from "../observability/incidents.js";

export type StatusKind = "ready" | "sign-in" | "stopped" | "ui-changed" | "error";

export type StatusInputs = {
  /** The panel's current error, if any. */
  errorCode?: string;
  /** Codes of the broker's recent incidents (metadata only). */
  incidentCodes: readonly string[];
  /** Whether the last health poll reached a live broker. */
  brokerLive: boolean;
  /** The broker's last known authentication state, when it reported one. */
  authState?: string;
};

const SIGN_IN_CODES: ReadonlySet<string> = new Set<ErrorCode>(["AUTH_REQUIRED", "AUTH_FAILED"]);

export function classifyStatus(inputs: StatusInputs): StatusKind {
  if (inputs.errorCode) {
    if (SIGN_IN_CODES.has(inputs.errorCode)) return "sign-in";
    if (isUiDriftCode(inputs.errorCode as ErrorCode)) return "ui-changed";
    return "error";
  }
  if (inputs.incidentCodes.some((code) => isUiDriftCode(code as ErrorCode))) return "ui-changed";
  if (!inputs.brokerLive) return "stopped";
  if (inputs.authState === "authenticated") return "ready";
  return "sign-in";
}

/** True when the banner asking the user to check with the developer should be shown. */
export function showsUiDriftBanner(inputs: Pick<StatusInputs, "errorCode" | "incidentCodes">): boolean {
  return classifyStatus({ ...inputs, brokerLive: true, authState: "authenticated" }) === "ui-changed";
}

/** The slice of a health poll `shouldNotifySignIn` compares snapshot to snapshot. */
export type SignInNotifyInputs = {
  /** The broker's last known authentication state, when it reported one. */
  authState?: string;
  /** The broker's recent incidents (metadata only). */
  incidents: readonly Pick<Incident, "at" | "code">[];
};

const SIGN_IN_AUTH_STATES: ReadonlySet<string> = new Set(["sign-in-required", "access-denied"]);
const SIGN_IN_INCIDENT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["AUTH_REQUIRED", "AUTH_FAILED"]);

/**
 * G2: true exactly on the poll where a proactive "sign in" notification should fire -- either the
 * auth state just transitioned *into* `sign-in-required`/`access-denied` from something else
 * (including "no previous poll yet"), or a new `AUTH_REQUIRED`/`AUTH_FAILED` incident appeared
 * (tracked by `at`, since incidents have no id). Comparing every poll only to the *immediately
 * preceding* one is what keeps this "at most once per transition": once the caller has folded a
 * `true` result into `previous` for the next call, an unchanged state/incident list on the
 * following poll compares equal and returns `false` -- it only flips back to `true` once the state
 * actually changes again (e.g. the user signs in and is later signed out again).
 */
export function shouldNotifySignIn(
  previous: SignInNotifyInputs | undefined,
  current: SignInNotifyInputs
): boolean {
  const wasSignIn = !!previous?.authState && SIGN_IN_AUTH_STATES.has(previous.authState);
  const isSignIn = !!current.authState && SIGN_IN_AUTH_STATES.has(current.authState);
  if (isSignIn && !wasSignIn) return true;

  const previousTimestamps = new Set((previous?.incidents ?? []).map((incident) => incident.at));
  return current.incidents.some(
    (incident) => SIGN_IN_INCIDENT_CODES.has(incident.code) && !previousTimestamps.has(incident.at)
  );
}

/** G6: true when the broker reports it is running against a development-only configuration
 * (insecure loopback navigation allowed, or a dev app URL override) -- see
 * `M365_AGENT_DEV_INSECURE_LOOPBACK`/`M365_AGENT_DEV_APP_URL` in docs/ux-redesign.md. Never true for
 * a production broker, and never throws on a health snapshot that predates this field. */
export function isDevMode(
  health: { devMode?: { insecureLoopback: boolean; devAppUrl: boolean } } | undefined
): boolean {
  return !!(health?.devMode?.insecureLoopback || health?.devMode?.devAppUrl);
}

/**
 * True when this workspace was set up from the panel before: `.m365-agents.json` is present *and*
 * this machine's local approval covers it (`approvalStatus === "approved"`). Auto-connect
 * (`SetupViewProvider.autoConnect`) resumes only such a workspace -- a repository can commit
 * `.m365-agents.json`, but only the user's own Save ever records the approval, so this is what "the
 * user set this folder up once" means under the security model (file = request, local approval =
 * authorization). `approval-required`/`binding-mismatch`/`invalid` all report false: those need the
 * user to look at the panel and Save again, which auto-connect must never do for them.
 */
export function isWorkspaceSetUp(workspace: { configured: boolean; approvalStatus: string }): boolean {
  return workspace.configured && workspace.approvalStatus === "approved";
}
