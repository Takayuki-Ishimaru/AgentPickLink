import { BrowserTransportError } from "./types.js";

/**
 * The neutral landing target that every hidden-context probe, the visible sign-in window, and agent
 * discovery open: the chat route of the first configured application host, or the development
 * override (`neutralAppUrl`, the mock application).
 *
 * The chat route, never the host root, on purpose. Signed out, `https://<host>/` does not redirect
 * to the login host: Microsoft 365 renders a marketing splash with a "サインイン" button *on the
 * application host* (observed in a real tenant on 2026-09-06). Landing there means a session kept
 * alive on the login host ("Stay signed in") is never picked up by silent SSO after the hidden
 * browser relaunches, and the auth detector then reports a sign-in page that "settled on" the
 * application host, which reads as "the page never rendered" rather than "the profile is signed
 * out". `/chat` sends a signed-out profile to the login host instead, where silent SSO completes
 * when it can and a genuinely signed-out profile is recognizable as such.
 */
export function neutralLandingUrl(appHosts: readonly string[], neutralAppUrl?: string): string {
  if (neutralAppUrl) return neutralAppUrl;
  const host = appHosts[0];
  if (!host)
    throw new BrowserTransportError(
      "POLICY_BLOCKED",
      "No exact Microsoft 365 application hosts are configured.",
      "Add validated navigation.appHosts entries to config.yaml."
    );
  return `https://${host}/chat`;
}
