import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, BrowserType, CDPSession, Page } from "playwright-core";
import { ensurePrivateDirectory } from "../../config/storage.js";
import type { PersistentContextLauncher } from "./browser-manager.js";
import { BrowserTransportError, type BrowserContextLike } from "./types.js";
import { backgroundWindowFailure, hideBrowserWindows } from "./windows-background.js";

/** Windows can keep the signed-in browser process and hide just its windows. Other platforms
 * retain the existing profile-restart handoff. Tests inject a native-window controller so the
 * same-process session/download behavior can also be exercised with real macOS Chromium. */
export function createBrowserLauncher(
  browserType: BrowserType,
  hideWindows: ((browserPid: number) => Promise<void>) | undefined = process.platform === "win32"
    ? hideBrowserWindows
    : undefined
): PersistentContextLauncher {
  return {
    launchPersistentContext: (profilePath, options) =>
      browserType.launchPersistentContext(profilePath, options) as Promise<BrowserContextLike>,
    ...(hideWindows
      ? {
          launchInteractiveContext: async (
            profilePath: string,
            options: Record<string, unknown>,
            automation: { headless: boolean; acceptDownloads: boolean }
          ): Promise<BrowserContextLike> => {
            const downloadsPath = await mkdtemp(path.join(profilePath, ".apl-downloads-"));
            await ensurePrivateDirectory(downloadsPath);
            let context: BrowserContext | undefined;
            try {
              // Launch on a blank page. Before any sign-in navigation is handed to the caller, the
              // protocol denies downloads. Playwright needs the eventual automation setting up front
              // to make Download.path() usable after handoff; it has no runtime setter for this option.
              context = await browserType.launchPersistentContext(profilePath, {
                ...options,
                headless: false,
                // The previous background session may have persisted an off-desktop placement.
                // Explicit sign-in must always start on the primary display.
                args: [...((options.args as string[] | undefined) ?? []), "--window-position=0,0"],
                acceptDownloads: automation.acceptDownloads,
                permissions: [],
                downloadsPath
              });
              const browser = context.browser();
              if (!browser) throw backgroundWindowFailure();
              const cdp = await browser.newBrowserCDPSession();
              await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
              return retainSession(context, cdp, downloadsPath, automation, hideWindows);
            } catch (error) {
              if (context) {
                // Do not erase a live browser's staging directory if its close fails.
                await context.close();
              }
              await rm(downloadsPath, { recursive: true, force: true });
              throw error;
            }
          }
        }
      : {})
  };
}

function retainSession(
  context: BrowserContext,
  cdp: CDPSession,
  downloadsPath: string,
  automation: { headless: boolean; acceptDownloads: boolean },
  hideWindows: (browserPid: number) => Promise<void>
): BrowserContextLike {
  let background = false;
  let closed = false;
  let hideFailure: unknown;
  let hideFlight: Promise<void> | undefined;
  let hideGeneration = 0;
  const originalNewPage = context.newPage.bind(context);
  const originalClose = context.close.bind(context);
  const hide = () => {
    // Batch concurrent page events into one update, then repeat if a page arrived while the
    // native call was pending. Every caller waits until the latest generation has been hidden.
    hideGeneration++;
    if (hideFlight) return hideFlight;
    const flight = (async () => {
      let generation: number;
      do {
        generation = hideGeneration;
        if (!background || closed) return;
        const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
        const browsers = processInfo.filter((item) => item.type === "browser");
        if (browsers.length !== 1) throw backgroundWindowFailure();
        await hideWindows(browsers[0].id);
      } while (generation !== hideGeneration);
    })();
    hideFlight = flight;
    void flight.then(
      () => {
        if (hideFlight === flight) hideFlight = undefined;
      },
      (error) => {
        hideFailure = error;
        if (hideFlight === flight) hideFlight = undefined;
      }
    );
    return flight;
  };
  context.on("close", () => {
    closed = true;
  });
  context.on("page", () => {
    if (background)
      void hide().catch(() => {
        // Fail closed if a new window cannot be hidden. BrowserManager observes the context close
        // and invalidates conversations; no operation silently continues in a visible browser.
        void context.close().catch(() => undefined);
      });
  });
  // Attachment saving also calls page.context().newPage(). Keep the real context identity and
  // adapt its public newPage method so those short-lived SSO/preview pages stay in background too.
  context.newPage = async () => {
    if (hideFailure) throw backgroundWindowFailure();
    const page = background ? await newBackgroundPage(context, cdp) : await originalNewPage();
    if (background) await hideFlight;
    if (hideFailure) throw backgroundWindowFailure();
    return page;
  };
  context.close = async (options) => {
    await originalClose(options);
    closed = true;
    await rm(downloadsPath, { recursive: true, force: true });
  };
  const retained = context as BrowserContext & BrowserContextLike;
  retained.completeInteractiveLogin = async () => {
    if (closed) throw new BrowserTransportError("AUTH_FAILED", "The sign-in window was closed.");
    // Hide the completed sign-in BEFORE replacing its tabs, so users never see the blank
    // anchor or the subsequent automation. Legacy visible settings cannot expose this handoff.
    background = true;
    await hide();
    // Keep an empty hidden window alive for background targets and close all login tabs.
    const anchor = await newBackgroundPage(context, cdp);
    await Promise.all(
      context
        .pages()
        .filter((page) => page !== anchor)
        .map((page) => page.close())
    );
    await context.clearPermissions();
    await hide();
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: automation.acceptDownloads ? "allowAndName" : "deny",
      downloadPath: downloadsPath,
      eventsEnabled: true
    });
    if (closed || hideFailure) throw backgroundWindowFailure();
  };
  return retained;
}

async function newBackgroundPage(context: BrowserContext, cdp: CDPSession): Promise<Page> {
  // A unique local blank URL correlates the page event without inspecting any tenant page or
  // using Playwright internals. Concurrent operations and user-created popups cannot take it.
  const url = `about:blank#apl-${randomUUID()}`;
  const pagePromise = context.waitForEvent("page", {
    predicate: (page) => page.url() === url,
    timeout: 15_000
  });
  void pagePromise.catch(() => undefined);
  const { targetId } = await cdp.send("Target.createTarget", { url, background: true });
  try {
    return await pagePromise;
  } catch (error) {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    throw error;
  }
}
