import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appPaths } from "../config/paths.js";
import { initializeLocalState } from "../config/init.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { BrowserTransport } from "../transports/browser/browser-transport.js";
import { browserLocalStatePreparer } from "../transports/browser/local-state.js";
import { TransportRouter } from "../transports/transport-router.js";
import { BrokerServer } from "./broker-server.js";
import { userScopedPipeName } from "./broker-descriptor.js";

async function main(): Promise<void> {
  const paths = await initializeLocalState(appPaths(), browserLocalStatePreparer);
  const config = await loadGlobalConfig(paths);
  const resolvedProfile = path.resolve(config.browser.profilePath);
  const profileIdentity =
    process.platform === "win32" ? resolvedProfile.toLocaleLowerCase() : resolvedProfile;
  const profileId = createHash("sha256").update(profileIdentity).digest("hex").slice(0, 12);
  const transport = new BrowserTransport({
    profilePath: config.browser.profilePath,
    channel: config.browser.channel,
    // Background operation is a product invariant, including profiles with a legacy visible setting.
    headless: true,
    // Conversation quota plus a small, bounded budget for auth/discovery/registration pages.
    maxPages: config.conversations.maxTotal + 4,
    allowInsecureLoopback: process.env.M365_AGENT_DEV_INSECURE_LOOPBACK === "1",
    neutralAppUrl: process.env.M365_AGENT_DEV_APP_URL || undefined,
    // Reported through broker.health so the panel/CLI can say out loud that this broker is not
    // running in its production configuration.
    devMode: {
      insecureLoopback: process.env.M365_AGENT_DEV_INSECURE_LOOPBACK === "1",
      devAppUrl: !!process.env.M365_AGENT_DEV_APP_URL
    },
    appHosts: config.navigation.appHosts,
    authHosts: config.navigation.authHosts,
    startupTimeoutMs: config.browser.startupTimeoutMs,
    navigationTimeoutMs: config.browser.navigationTimeoutMs,
    responseTimeoutMs: config.browser.responseTimeoutMs,
    ackTimeoutMs: config.browser.ackTimeoutMs,
    responseStartTimeoutMs: config.browser.responseStartTimeoutMs,
    typingDelayMs: config.browser.typingDelayMs,
    attachmentSettleMs: config.browser.attachmentSettleMs,
    stabilityWindowMs: config.browser.stabilityWindowMs,
    pollIntervalMs: config.browser.pollIntervalMs,
    acceptDownloads: config.browser.acceptDownloads,
    userAgent: config.browser.userAgent,
    args: config.browser.args,
    viewport: config.browser.viewport,
    locale: config.browser.locale,
    timezoneId: config.browser.timezoneId,
    attachmentsPath: paths.attachments,
    downloadHosts: config.navigation.downloadHosts,
    maxAttachments: config.browser.maxAttachments,
    maxAttachmentBytes: config.browser.maxAttachmentBytes,
    maxTotalAttachmentBytes: config.browser.maxTotalAttachmentBytes,
    allowedCapabilityClasses: config.security.allowedCapabilityClasses
  });
  // v0.1 registers only "browser"; a future WorkIqTransport/CopilotStudioSdkTransport is added
  // here with its own .register(...) call, without touching BrokerServer, services, or the
  // frontend (see TransportRouter and design doc §45).
  const router = new TransportRouter().register("browser", transport);
  const entry = fileURLToPath(import.meta.url);
  const build = { entry, mtimeMs: (await stat(entry)).mtimeMs };
  const server = new BrokerServer({
    paths,
    pipeName: userScopedPipeName(profileId),
    packageVersion: "0.1.2",
    router,
    build
  });
  await server.start();
  const shutdown = () => {
    void server.stop().then(
      () => process.exit(0),
      (error) => {
        // Keep the broker alive with its stopping descriptor when a browser context refuses to
        // close. A later signal/shutdown request retries disposal; exiting here could leave the
        // profile locked while a successor removes the dead descriptor.
        process.stderr.write(
          `AgentPickLink broker shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`
        );
        process.exitCode = 1;
      }
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  process.stderr.write(
    `AgentPickLink broker failed: ${error instanceof Error ? error.message : "unknown error"}\n`
  );
  process.exitCode = 1;
});
