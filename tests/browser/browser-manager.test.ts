import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import type { BrowserContextLike, PageLike } from "../../src/transports/browser/types.js";

describe("BrowserManager", () => {
  it("adopts the signed-in context without relaunching and still observes crashes", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-retained-manager-"));
    let launches = 0;
    let closes = 0;
    let handedOff = false;
    let crashed = 0;
    let closeListener: (() => void) | undefined;
    const context: BrowserContextLike = {
      pages: () => [],
      newPage: async () => ({ url: () => "about:blank", close: async () => undefined }),
      close: async () => {
        closes++;
        closeListener?.();
      },
      completeInteractiveLogin: async () => {
        handedOff = true;
      },
      on: (event, callback) => {
        if (event === "close") closeListener = callback;
      }
    };
    const manager = new BrowserManager({
      profilePath,
      onCrash: () => {
        crashed++;
      },
      launcher: {
        launchPersistentContext: async () => {
          throw new Error("must not relaunch");
        },
        launchInteractiveContext: async (_path, options, automation) => {
          launches++;
          expect(options.acceptDownloads).toBe(false);
          expect(automation.headless).toBe(true);
          return context;
        }
      }
    });
    await manager.runInteractiveLogin(async () => "signed-in");
    expect(handedOff).toBe(true);
    expect(manager.isRunning()).toBe(true);
    expect(manager.keepsSignedInProcess()).toBe(true);
    await manager.createConversationPage("probe");
    expect(launches).toBe(1);
    expect(closes).toBe(0);
    closeListener?.();
    expect(crashed).toBe(1);
    expect(manager.isRunning()).toBe(false);
  });

  it("closes rather than adopting when cancellation arrives during background handoff", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-retained-cancel-"));
    let beginHandoff: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      beginHandoff = resolve;
    });
    let releaseHandoff: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    let closes = 0;
    const context: BrowserContextLike = {
      pages: () => [],
      close: async () => {
        closes++;
      },
      completeInteractiveLogin: async () => {
        beginHandoff?.();
        await released;
      }
    };
    const manager = new BrowserManager({
      profilePath,
      launcher: { launchPersistentContext: async () => context }
    });
    const login = manager.runInteractiveLogin(async () => undefined);
    void login.catch(() => undefined);
    await began;
    expect(manager.cancelInteractiveLogin()).toBe(true);
    releaseHandoff?.();
    await expect(login).rejects.toMatchObject({ code: "AUTH_FAILED", details: { cancelled: true } });
    expect(manager.isRunning()).toBe(false);
    expect(closes).toBe(1);
  });

  it("closes a retained context exactly once on normal shutdown", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-retained-dispose-"));
    let closes = 0;
    const context: BrowserContextLike = {
      pages: () => [],
      close: async () => {
        closes++;
      },
      completeInteractiveLogin: async () => undefined
    };
    const manager = new BrowserManager({
      profilePath,
      launcher: { launchPersistentContext: async () => context }
    });
    await manager.runInteractiveLogin(async () => undefined);
    await manager.dispose();
    await manager.dispose();
    expect(closes).toBe(1);
    expect(manager.isRunning()).toBe(false);
  });

  it("serializes concurrent startup into one persistent context", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let launches = 0;
    let pages = 0;
    let closeListener: (() => void) | undefined;
    const context: BrowserContextLike = {
      pages: () => [],
      newPage: async () => ({ url: () => "about:blank", close: async () => undefined }) satisfies PageLike,
      close: async () => {
        closeListener?.();
      },
      on: (event, listener) => {
        if (event === "close") closeListener = listener;
      }
    };
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          launches++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            ...context,
            newPage: async () => {
              pages++;
              return { url: () => "about:blank", close: async () => undefined };
            }
          };
        }
      }
    });
    await Promise.all([manager.createConversationPage("one"), manager.createConversationPage("two")]);
    expect(launches).toBe(1);
    expect(pages).toBe(2);
    await manager.close();
  });

  it("shares an in-flight page creation for the same key and leaves no duplicate page behind", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let pages = 0;
    let releasePage: (() => void) | undefined;
    let markPageStarted: (() => void) | undefined;
    const pageStarted = new Promise<void>((resolve) => {
      markPageStarted = resolve;
    });
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => {
            pages++;
            markPageStarted?.();
            await new Promise<void>((resolve) => {
              releasePage = resolve;
            });
            return { url: () => "about:blank", close: async () => undefined };
          },
          close: async () => undefined,
          on: () => undefined
        })
      }
    });

    const first = manager.createConversationPage("shared");
    const second = manager.createConversationPage("shared");
    await pageStarted;
    expect(pages).toBe(1);
    releasePage?.();
    const [a, b] = await Promise.all([first, second]);
    expect(a.page).toBe(b.page);
    await manager.close();
  });

  it("bounds managed pages and frees the slot when a conversation closes", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let pages = 0;
    const manager = new BrowserManager({
      profilePath,
      maxPages: 1,
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => ({ url: () => `about:blank/${++pages}`, close: async () => undefined }),
          close: async () => undefined,
          on: () => undefined
        })
      }
    });

    await manager.createConversationPage("first");
    await expect(manager.createConversationPage("second")).rejects.toMatchObject({
      code: "CONCURRENT_REQUEST"
    });
    await manager.closePage("first");
    await expect(manager.createConversationPage("second")).resolves.toMatchObject({ key: "second" });
    await manager.close();
  });

  it("keeps a page in the budget until its asynchronous close has settled", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let releaseClose: (() => void) | undefined;
    let markCloseStarted: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let pages = 0;
    let closeCalls = 0;
    const manager = new BrowserManager({
      profilePath,
      maxPages: 1,
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => ({
            url: () => `about:blank/${++pages}`,
            close: async () => {
              closeCalls++;
              markCloseStarted?.();
              await closeGate;
            }
          }),
          close: async () => undefined,
          on: () => undefined
        })
      }
    });

    await manager.createConversationPage("first");
    const firstClose = manager.closePage("first");
    await closeStarted;
    await expect(manager.createConversationPage("second")).rejects.toMatchObject({
      code: "CONCURRENT_REQUEST"
    });
    // Repeated close requests join the first close rather than invoking page.close twice.
    const duplicateClose = manager.closePage("first");
    expect(closeCalls).toBe(1);
    releaseClose?.();
    await Promise.all([firstClose, duplicateClose]);
    await expect(manager.createConversationPage("second")).resolves.toMatchObject({ key: "second" });
    await manager.close();
  });

  it("reclaims a page the browser closed outside the manager before enforcing the cap", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let externallyClosed = false;
    let pages = 0;
    const manager = new BrowserManager({
      profilePath,
      maxPages: 1,
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => ({
            url: () => `about:blank/${++pages}`,
            isClosed: () => externallyClosed,
            close: async () => undefined
          }),
          close: async () => undefined,
          on: () => undefined
        })
      }
    });

    await manager.createConversationPage("first");
    externallyClosed = true;
    await expect(manager.createConversationPage("second")).resolves.toMatchObject({ key: "second" });
    await manager.close();
  });

  it("does not let an old in-flight page creation consume a new context's page budget", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let launches = 0;
    let releaseOldPage: (() => void) | undefined;
    let oldPageClosed = 0;
    let markOldPageStarted: (() => void) | undefined;
    const oldPageStarted = new Promise<void>((resolve) => {
      markOldPageStarted = resolve;
    });
    const manager = new BrowserManager({
      profilePath,
      maxPages: 1,
      launcher: {
        launchPersistentContext: async () => {
          launches++;
          const oldContext = launches === 1;
          return {
            pages: () => [],
            newPage: async () => {
              if (!oldContext) return { url: () => "about:blank/new", close: async () => undefined };
              markOldPageStarted?.();
              await new Promise<void>((resolve) => {
                releaseOldPage = resolve;
              });
              return {
                url: () => "about:blank/old",
                close: async () => {
                  oldPageClosed++;
                }
              };
            },
            close: async () => undefined,
            on: () => undefined
          };
        }
      }
    });

    const stale = manager.createConversationPage("old");
    await oldPageStarted;
    await manager.close();
    await expect(manager.createConversationPage("new")).resolves.toMatchObject({ key: "new" });
    releaseOldPage?.();
    await expect(stale).rejects.toMatchObject({ code: "BROWSER_CRASHED" });
    expect(oldPageClosed).toBe(1);
    await manager.close();
  });

  it("does not let a close waiting on an old creation close a fresh same-key page after reset", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let launches = 0;
    let releaseOldPage: (() => void) | undefined;
    let markOldPageStarted: (() => void) | undefined;
    const oldPageStarted = new Promise<void>((resolve) => {
      markOldPageStarted = resolve;
    });
    const freshPage: PageLike = { url: () => "about:blank/fresh", close: async () => undefined };
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          launches++;
          return {
            pages: () => [],
            newPage: async () => {
              if (launches > 1) return freshPage;
              markOldPageStarted?.();
              await new Promise<void>((resolve) => {
                releaseOldPage = resolve;
              });
              return { url: () => "about:blank/old", close: async () => undefined };
            },
            close: async () => undefined,
            on: () => undefined
          };
        }
      }
    });

    const staleCreation = manager.createConversationPage("same");
    await oldPageStarted;
    const staleClose = manager.closePage("same");
    await manager.close();
    await manager.createConversationPage("same");
    releaseOldPage?.();
    await expect(staleCreation).rejects.toMatchObject({ code: "BROWSER_CRASHED" });
    await staleClose;
    expect((await manager.createConversationPage("same")).page).toBe(freshPage);
    await manager.close();
  });

  it("keeps a failed close in the budget and allows a later close retry", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let attempts = 0;
    let closed = false;
    const manager = new BrowserManager({
      profilePath,
      maxPages: 1,
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => ({
            url: () => "about:blank",
            isClosed: () => closed,
            close: async () => {
              attempts++;
              if (attempts === 1) throw new Error("temporary close failure");
              closed = true;
            }
          }),
          close: async () => undefined,
          on: () => undefined
        })
      }
    });

    await manager.createConversationPage("first");
    await expect(manager.closePage("first")).rejects.toThrow("temporary close failure");
    await expect(manager.createConversationPage("second")).rejects.toMatchObject({
      code: "CONCURRENT_REQUEST"
    });
    await expect(manager.closePage("first")).resolves.toBeUndefined();
    await expect(manager.createConversationPage("second")).resolves.toMatchObject({ key: "second" });
    expect(attempts).toBe(2);
    await manager.close();
  });

  it("reports an unexpected context close to the broker integration hook", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let listener: (() => void) | undefined;
    let crashed = 0;
    const manager = new BrowserManager({
      profilePath,
      onCrash: () => {
        crashed++;
      },
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => ({ url: () => "about:blank" }),
          close: async () => undefined,
          on: (event, callback) => {
            if (event === "close") listener = callback;
          }
        })
      }
    });
    await manager.start();
    listener?.();
    expect(crashed).toBe(1);
    expect(manager.isRunning()).toBe(false);
  });

  it("does not report an intentional context close as a crash", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let listener: (() => void) | undefined;
    let crashed = 0;
    const manager = new BrowserManager({
      profilePath,
      onCrash: () => {
        crashed++;
      },
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          close: async () => {
            listener?.();
          },
          on: (event, callback) => {
            if (event === "close") listener = callback;
          }
        })
      }
    });
    await manager.start();
    await manager.close();
    expect(crashed).toBe(0);
  });

  it("waits for an automation context close before relaunching the profile", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let launches = 0;
    let closeCalls = 0;
    let releaseClose: (() => void) | undefined;
    let closeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (closeStarted = resolve));
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          launches++;
          let closeListener: (() => void) | undefined;
          return {
            pages: () => [],
            close: async () => {
              closeCalls++;
              if (closeCalls > 1) return;
              closeStarted?.();
              await new Promise<void>((resolve) => (releaseClose = resolve));
              closeListener?.();
            },
            on: (event, listener) => {
              if (event === "close") closeListener = listener;
            }
          } satisfies BrowserContextLike;
        }
      }
    });

    await manager.start();
    const closing = manager.close();
    await started;
    const relaunch = manager.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(launches).toBe(1);
    releaseClose?.();
    await Promise.all([closing, relaunch]);
    expect(launches).toBe(2);
    await manager.close();
  });

  it("retains a failed automation close and retries it before allowing a relaunch", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let closeCalls = 0;
    let launches = 0;
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          launches++;
          return {
            pages: () => [],
            close: async () => {
              closeCalls++;
              if (closeCalls === 1) throw new Error("automation context close failed");
            },
            on: () => undefined
          } satisfies BrowserContextLike;
        }
      }
    });

    await manager.start();
    await expect(manager.close()).rejects.toThrow("automation context close failed");
    await expect(manager.start()).rejects.toMatchObject({ code: "BROWSER_PROFILE_LOCKED" });
    expect(launches).toBe(1);
    await expect(manager.close()).resolves.toBeUndefined();
    await manager.start();
    expect(launches).toBe(2);
    await manager.close();
  });

  it("waits for an in-flight hidden launch before disposing the browser", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let releaseLaunch: (() => void) | undefined;
    let launchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (launchStarted = resolve));
    let closeCalls = 0;
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          launchStarted?.();
          await new Promise<void>((resolve) => (releaseLaunch = resolve));
          return {
            pages: () => [],
            close: async () => {
              closeCalls++;
            },
            on: () => undefined
          } satisfies BrowserContextLike;
        }
      }
    });

    const starting = manager.start();
    await started;
    const disposing = manager.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeCalls).toBe(0);
    releaseLaunch?.();
    await Promise.all([starting, disposing]);
    expect(closeCalls).toBe(1);
    expect(manager.isRunning()).toBe(false);
  });

  it("does not return a page whose context is already closing", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let releasePage: (() => void) | undefined;
    let pageStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (pageStarted = resolve));
    let releaseContext: (() => void) | undefined;
    let contextCloseStarted: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => (contextCloseStarted = resolve));
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => {
            pageStarted?.();
            await new Promise<void>((resolve) => (releasePage = resolve));
            return { url: () => "about:blank", close: async () => undefined };
          },
          close: async () => {
            contextCloseStarted?.();
            await new Promise<void>((resolve) => (releaseContext = resolve));
          },
          on: () => undefined
        })
      }
    });

    const opening = manager.createConversationPage("closing");
    await started;
    const closing = manager.close();
    await closeStarted;
    releasePage?.();
    await expect(opening).rejects.toMatchObject({ code: "BROWSER_CRASHED" });
    releaseContext?.();
    await closing;
  });

  it("serializes profile reset with a concurrent startup", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let launches = 0;
    let releaseReset: (() => void) | undefined;
    let resetStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (resetStarted = resolve));
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          launches++;
          return { pages: () => [], close: async () => undefined, on: () => undefined };
        }
      }
    });
    const internals = manager as unknown as { profile: { reset(): Promise<void> } };
    internals.profile.reset = async () => {
      resetStarted?.();
      await new Promise<void>((resolve) => (releaseReset = resolve));
    };

    await manager.start();
    const resetting = manager.resetProfile();
    await started;
    const starting = manager.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(launches).toBe(1);
    releaseReset?.();
    await Promise.all([resetting, starting]);
    expect(launches).toBe(2);
    await manager.close();
  });

  it("does not leave a headed context orphaned when dispose interrupts its launch", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let releaseHeadedLaunch: (() => void) | undefined;
    let headedLaunchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (headedLaunchStarted = resolve));
    let headedCloseCalls = 0;
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async (_dir, options) => {
          if (options.headless === false) {
            headedLaunchStarted?.();
            await new Promise<void>((resolve) => (releaseHeadedLaunch = resolve));
          }
          return {
            pages: () => [],
            close: async () => {
              if (options.headless === false) headedCloseCalls++;
            },
            on: () => undefined
          };
        }
      }
    });

    const login = manager.runInteractiveLogin(async (_context, signal) => {
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      throw new Error("login body observed cancellation");
    });
    await started;
    const disposing = manager.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(headedCloseCalls).toBe(0);
    releaseHeadedLaunch?.();
    await expect(login).rejects.toThrow("login body observed cancellation");
    await disposing;
    expect(headedCloseCalls).toBe(1);
    expect(manager.isRunning()).toBe(false);
  });

  it("hands the dedicated profile to a headed sign-in window and relaunches hidden afterwards", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    const launched: Array<Record<string, unknown>> = [];
    const closedContexts: number[] = [];
    let resets = 0;
    let crashes = 0;
    const manager = new BrowserManager({
      profilePath,
      onCrash: () => {
        crashes++;
      },
      onContextReset: () => {
        resets++;
      },
      launcher: {
        launchPersistentContext: async (_dir, options) => {
          const index = launched.push(options) - 1;
          let closeListener: (() => void) | undefined;
          return {
            pages: () => [],
            newPage: async () => ({ url: () => "about:blank", close: async () => undefined }),
            close: async () => {
              closedContexts.push(index);
              closeListener?.();
            },
            on: (event, callback) => {
              if (event === "close") closeListener = callback;
            }
          } satisfies BrowserContextLike;
        }
      }
    });

    await manager.createConversationPage("conversation");
    expect(launched[0].headless).toBe(true);
    expect(launched[0].chromiumSandbox).toBe(true);

    let runningDuringLogin: boolean | undefined;
    const seen = await manager.runInteractiveLogin(async (context) => {
      runningDuringLogin = manager.isRunning();
      return context.pages().length;
    });

    expect(seen).toBe(0);
    expect(runningDuringLogin).toBe(false);
    expect(resets).toBe(1);
    expect(crashes).toBe(0);
    expect(launched[1].headless).toBe(false);
    expect(String(launched[1].args)).toContain("--window-size");
    expect(closedContexts).toEqual([0, 1]);
    expect(manager.isRunning()).toBe(false);

    await manager.start();
    expect(launched).toHaveLength(3);
    expect(launched[2].headless).toBe(true);
    await manager.close();
  });

  it("does not relaunch against a visible profile when closing the sign-in window fails", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let headedCloseCalls = 0;
    let launches = 0;
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async (_dir, options) => {
          launches++;
          const headed = options.headless === false;
          return {
            pages: () => [],
            close: async () => {
              if (headed && headedCloseCalls++ === 0) throw new Error("sign-in window close failed");
            },
            on: () => undefined
          } satisfies BrowserContextLike;
        }
      }
    });

    await expect(manager.runInteractiveLogin(async () => undefined)).rejects.toThrow(
      "sign-in window close failed"
    );
    // The failed close retains ownership of the profile; a hidden launch must never race the
    // still-visible sign-in Edge process and turn the failure into a confusing profile lock.
    await expect(manager.start()).rejects.toMatchObject({ code: "BROWSER_PROFILE_LOCKED" });
    expect(launches).toBe(1);

    // Shutdown/retry can close the retained headed context, after which a hidden context is safe.
    await manager.dispose();
    await expect(manager.start()).resolves.toBeUndefined();
    expect(launches).toBe(2);
    await manager.close();
  });

  it("passes the configured browser knobs to both the hidden and the headed context", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    const launched: Array<Record<string, unknown>> = [];
    const manager = new BrowserManager({
      profilePath,
      channel: "chrome",
      userAgent: "Mozilla/5.0 (test)",
      args: ["--disable-blink-features=AutomationControlled"],
      viewport: { width: 1280, height: 1024 },
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      launcher: {
        launchPersistentContext: async (_dir, options) => {
          launched.push(options);
          return { pages: () => [], close: async () => undefined, on: () => undefined };
        }
      }
    });

    await manager.start();
    await manager.runInteractiveLogin(async () => undefined);

    expect(launched[0]).toMatchObject({
      channel: "chrome",
      headless: true,
      userAgent: "Mozilla/5.0 (test)",
      args: ["--disable-blink-features=AutomationControlled"],
      viewport: { width: 1280, height: 1024 },
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo"
    });
    // The visible window keeps the same knobs, and its size follows the configured viewport.
    expect(launched[1]).toMatchObject({ headless: false, viewport: null, userAgent: "Mozilla/5.0 (test)" });
    expect(launched[1].args).toEqual([
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,1024"
    ]);
    expect(manager.describe()).toMatchObject({
      channel: "chrome",
      headless: true,
      viewport: { width: 1280, height: 1024 }
    });
  });

  it("adds no Chromium switch of its own", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    const launched: Array<Record<string, unknown>> = [];
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async (_dir, options) => {
          launched.push(options);
          return { pages: () => [], close: async () => undefined, on: () => undefined };
        }
      }
    });

    await manager.start();

    expect(launched[0].args).toEqual([]);
    await manager.close();
  });

  it("maps a profile lock, a missing executable, and a startup timeout to actionable codes", async () => {
    const cases: Array<{ failure: Error | "timeout"; code: string; remediation: RegExp }> = [
      {
        failure: new Error("Failed to launch: user data directory is already in use (SingletonLock)"),
        code: "BROWSER_PROFILE_LOCKED",
        remediation: /broker restart/
      },
      {
        failure: new Error("Chromium distribution 'msedge' is not found. Executable doesn't exist"),
        code: "BROWSER_START_FAILED",
        remediation: /msedge/
      },
      {
        // Playwright's actual wording when the branded channel is absent on macOS.
        failure: new Error(
          "browserType.launchPersistentContext: Chromium distribution 'msedge' is not found at /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge Run \"npx playwright install msedge\""
        ),
        code: "BROWSER_START_FAILED",
        remediation: /Advanced settings/
      },
      { failure: "timeout", code: "BROWSER_START_FAILED", remediation: /broker restart/ }
    ];
    for (const scenario of cases) {
      const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
      const manager = new BrowserManager({
        profilePath,
        startupTimeoutMs: 10,
        launcher: {
          launchPersistentContext: async () => {
            if (scenario.failure === "timeout") await new Promise((resolve) => setTimeout(resolve, 200));
            else throw scenario.failure;
            return { pages: () => [], close: async () => undefined, on: () => undefined };
          }
        }
      });
      await expect(manager.start()).rejects.toMatchObject({
        code: scenario.code,
        remediation: expect.stringMatching(scenario.remediation)
      });
    }
  });

  it("retries a transient profile lock without terminating the owning browser", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let attempts = 0;
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          attempts++;
          if (attempts < 3)
            throw new Error("Failed to launch: user data directory is already in use (SingletonLock)");
          return { pages: () => [], close: async () => undefined, on: () => undefined };
        }
      }
    });

    await expect(manager.start()).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    await manager.close();
  });

  it("keeps profile-lock retries inside the configured startup budget", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let attempts = 0;
    const manager = new BrowserManager({
      profilePath,
      startupTimeoutMs: 50,
      launcher: {
        launchPersistentContext: async () => {
          attempts++;
          throw new Error("Failed to launch: user data directory is already in use (SingletonLock)");
        }
      }
    });

    await expect(manager.start()).rejects.toMatchObject({ code: "BROWSER_PROFILE_LOCKED" });
    // The second retry delay is longer than the remaining startup budget, so it must not start a
    // fresh full timeout window (or turn a live external owner into a multi-minute wait).
    expect(attempts).toBe(1);
  });

  it("reports a missing context, an invalid page key, and an unavailable page with domain codes", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => ({
          // No newPage and no spare page: the context cannot serve a conversation.
          pages: () => [],
          close: async () => undefined,
          on: () => undefined
        })
      }
    });

    expect(() => manager.getContext()).toThrow(expect.objectContaining({ code: "BROWSER_START_FAILED" }));
    await expect(manager.createConversationPage("not a valid key!")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT"
    });
    await expect(manager.createConversationPage("conversation")).rejects.toMatchObject({
      code: "AGENT_PAGE_UNAVAILABLE"
    });
    await manager.close();
  });

  it("refuses to close or reset the profile while a sign-in window is open, but disposes it", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let headedClosed = 0;
    let release: (() => void) | undefined;
    let markRunning: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => (release = resolve));
    const running = new Promise<void>((resolve) => (markRunning = resolve));
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async (_dir, options) => ({
          pages: () => [],
          newPage: async () => ({ url: () => "about:blank", close: async () => undefined }),
          close: async () => {
            if (options.headless === false) headedClosed++;
          },
          on: () => undefined
        })
      }
    });

    const login = manager.runInteractiveLogin(async () => {
      markRunning?.();
      await finished;
    });
    await running;

    // Closing or wiping the profile underneath a sign-in would destroy the sign-in in progress.
    await expect(manager.close()).rejects.toMatchObject({
      code: "CONCURRENT_REQUEST",
      message: expect.stringContaining("interactive sign-in is in progress")
    });
    await expect(manager.resetProfile()).rejects.toMatchObject({ code: "CONCURRENT_REQUEST" });
    // Shutdown is different: it closes the visible window instead of leaving it orphaned.
    await manager.dispose();
    expect(headedClosed).toBe(1);

    release?.();
    await login;
  });

  it("cancels a running sign-in, closes the visible window, and can start hidden again", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    const launched: Array<Record<string, unknown>> = [];
    let headedClosed = 0;
    let markRunning: (() => void) | undefined;
    const running = new Promise<void>((resolve) => (markRunning = resolve));
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async (_dir, options) => {
          launched.push(options);
          return {
            pages: () => [],
            newPage: async () => ({ url: () => "about:blank", close: async () => undefined }),
            close: async () => {
              if (options.headless === false) headedClosed++;
            },
            on: () => undefined
          } satisfies BrowserContextLike;
        }
      }
    });

    // A sign-in body that would otherwise poll forever, exactly like the real one waiting for a user.
    let sawSignal = false;
    const login = manager.runInteractiveLogin(async (_context, signal) => {
      markRunning?.();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      sawSignal = true;
      return "never-completed";
    });
    await running;

    expect(manager.cancelInteractiveLogin()).toBe(true);
    await expect(login).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "The sign-in was cancelled.",
      details: { cancelled: true }
    });
    // The body is told to stop too, and the visible window is closed exactly once.
    expect(sawSignal).toBe(true);
    expect(headedClosed).toBe(1);
    expect(manager.isRunning()).toBe(false);
    // Nothing is left in progress, so a second cancel reports that there was nothing to cancel and
    // the hidden context relaunches immediately.
    expect(manager.cancelInteractiveLogin()).toBe(false);
    await manager.start();
    expect(launched.at(-1)?.headless).toBe(true);
    expect(manager.isRunning()).toBe(true);
    await manager.close();
  });

  it("cancels through a caller-supplied signal, before the window is even opened", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let launches = 0;
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          launches++;
          return { pages: () => [], close: async () => undefined, on: () => undefined };
        }
      }
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      manager.runInteractiveLogin(async () => "unreachable", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "AUTH_FAILED", message: "The sign-in was cancelled." });
    expect(launches).toBe(0);
    // The manager is not left "busy": a normal sign-in can start right away.
    await expect(manager.runInteractiveLogin(async () => "ok")).resolves.toBe("ok");
  });

  it("refuses a second interactive sign-in while one is in progress", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-"));
    let release: (() => void) | undefined;
    let markRunning: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => (release = resolve));
    const running = new Promise<void>((resolve) => (markRunning = resolve));
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          close: async () => undefined,
          on: () => undefined
        })
      }
    });
    const first = manager.runInteractiveLogin(async () => {
      markRunning?.();
      await finished;
    });
    await running;
    await expect(manager.runInteractiveLogin(async () => undefined)).rejects.toMatchObject({
      code: "CONCURRENT_REQUEST"
    });
    // Chromium allows one process per profile directory, so the hidden context must not relaunch
    // underneath the visible sign-in window either.
    await expect(manager.createConversationPage("while-signing-in")).rejects.toMatchObject({
      code: "CONCURRENT_REQUEST"
    });
    release?.();
    await first;
    await expect(manager.runInteractiveLogin(async () => "ok")).resolves.toBe("ok");
  });
});
