import { spawn } from "node:child_process";
import { lstat, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import type { BrowserContextLike, PageLike } from "../../src/transports/browser/types.js";
import { fakeProcessListing, formatProcessListing } from "../helpers/platform.js";

/** Real, disposable child processes for the round4 U2 tests below -- mirrors
 * tests/services/broker-staleness.test.ts's own `spawnDisposableProcess`: unlike a fake pid, these
 * give the post-close exit wait a liveness signal that genuinely changes when killed. Swept up in
 * `afterEach` as a safety net beyond each test's own cleanup. */
const spawnedPids: number[] = [];
function spawnDisposableProcess(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  spawnedPids.push(child.pid!);
  return child.pid!;
}
afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone -- the point of this sweep */
    }
  }
});

const PROFILE_OWNER_MARKER_CONTENT = "AgentPickLink for Microsoft 365 dedicated browser profile v1\n";

/** A profile directory that already carries the ownership marker `ProfileManager.prepare()`
 * requires, so a test can pre-seed a `SingletonLock` symlink without tripping the
 * "non-empty and not AgentPickLink-owned" guard. */
async function ownedProfile(prefix: string): Promise<string> {
  const profilePath = await mkdtemp(path.join(os.tmpdir(), prefix));
  await writeFile(path.join(profilePath, ".agentpicklink-profile"), PROFILE_OWNER_MARKER_CONTENT);
  return profilePath;
}

/** A process id this machine will not have: high, and immediately probed as absent. */
function deadPid(): number {
  for (let candidate = 999_999; candidate > 100_000; candidate -= 7919) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no dead pid available");
}

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
        // Every scenario below reaches `launchContext()`'s pre-launch process-listing snapshot
        // regardless of how it fails; without this, an uninjected default shells out for real (real
        // PowerShell on Windows), which is what made this loop of four scenarios time out under CPU
        // load there -- see ISSUE-2026-09-14-13.
        processExec: async () => ({ stdout: "" }),
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

  it("self-heals a retained context whose browser process died without a close event", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-dead-context-"));
    let launches = 0;
    let crashed = 0;
    let connected = true;
    const manager = new BrowserManager({
      profilePath,
      onCrash: () => {
        crashed++;
      },
      launcher: {
        launchPersistentContext: async () => {
          launches++;
          connected = true;
          return {
            pages: () => [],
            close: async () => undefined,
            on: () => undefined,
            browser: () => ({ isConnected: () => connected })
          } satisfies BrowserContextLike;
        }
      }
    });

    await manager.start();
    expect(launches).toBe(1);
    expect(manager.isRunning()).toBe(true);

    // The underlying browser process died (e.g. an external cleanup killed msedge.exe) without
    // this manager ever observing a "close" event on the context it retained.
    connected = false;

    await manager.start();
    expect(launches).toBe(2);
    expect(crashed).toBe(1);
    expect(manager.isRunning()).toBe(true);
    await manager.close();
  });

  it("stops refusing to relaunch once a retained failed-close context is confirmed dead", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-dead-close-failed-"));
    let closeCalls = 0;
    let launches = 0;
    let connected = true;
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          launches++;
          connected = true;
          return {
            pages: () => [],
            close: async () => {
              closeCalls++;
              if (closeCalls === 1) throw new Error("automation context close failed");
            },
            on: () => undefined,
            browser: () => ({ isConnected: () => connected })
          } satisfies BrowserContextLike;
        }
      }
    });

    await manager.start();
    await expect(manager.close()).rejects.toThrow("automation context close failed");
    expect(closeCalls).toBe(1);

    // The failed close is still against a live process at this point: start() must keep refusing.
    await expect(manager.start()).rejects.toMatchObject({ code: "BROWSER_PROFILE_LOCKED" });
    expect(launches).toBe(1);

    // The process now confirmed gone -- start() must self-heal instead of blocking forever.
    connected = false;
    await manager.start();
    expect(launches).toBe(2);
    await manager.close();
  });

  it("removes a stale SingletonLock discovered mid-retry, pointing at a dead PID", async () => {
    if (process.platform === "win32") return; // POSIX-only symlink lock, matches ProfileManager.
    const profilePath = await ownedProfile("apl-stale-lock-");
    const lockPath = path.join(profilePath, "SingletonLock");
    const staleTarget = `${os.hostname()}-${deadPid()}`;
    let attempts = 0;
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          attempts++;
          if (attempts === 1) {
            // ProfileManager.prepare()'s own one-shot cleanup already ran and saw nothing to
            // remove; model a lock that only appears once this (unmodeled) prior browser process
            // has actually exited, holding the profile through this first failed attempt.
            await symlink(staleTarget, lockPath);
            throw new Error("Failed to launch: user data directory is already in use (SingletonLock)");
          }
          return { pages: () => [], close: async () => undefined, on: () => undefined };
        }
      }
    });

    await expect(manager.start()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await manager.close();
  });

  it("keeps a live SingletonLock untouched and still fails once the retry schedule is spent", async () => {
    if (process.platform === "win32") return; // POSIX-only symlink lock, matches ProfileManager.
    const profilePath = await ownedProfile("apl-live-lock-");
    const lockPath = path.join(profilePath, "SingletonLock");
    await symlink(`${os.hostname()}-${process.pid}`, lockPath);
    let attempts = 0;
    const manager = new BrowserManager({
      profilePath,
      startupTimeoutMs: 700,
      launcher: {
        launchPersistentContext: async () => {
          attempts++;
          throw new Error("Failed to launch: user data directory is already in use (SingletonLock)");
        }
      }
    });

    await expect(manager.start()).rejects.toMatchObject({ code: "BROWSER_PROFILE_LOCKED" });
    expect(attempts).toBeGreaterThan(1);
    // A lock this host can prove is live (this very test process) must never be touched.
    await expect(lstat(lockPath)).resolves.toBeDefined();
  });
});

/**
 * docs/validation-log-2026-09-14-windows-round3.md S2: a broker's own shutdown must never hang
 * forever on a half-dead browser (bounded close + force-kill), and a launch that fails because
 * another live instance already owns the profile (Chromium exit code 21) gets a specific
 * remediation and, on POSIX, one recovery attempt against the live pid the profile's own lock
 * file already names.
 */
describe("BrowserManager round 3 S2: bounded close and owned-profile recovery", () => {
  it("force-kills the browser process and does not hang when the automation context's close() never settles", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-hung-close-"));
    const killed: number[] = [];
    const manager = new BrowserManager({
      profilePath,
      closeTimeoutMs: 20,
      killProcessTree: async (pid) => {
        killed.push(pid);
      },
      launcher: {
        launchPersistentContext: async () =>
          ({
            pages: () => [],
            // Never settles -- models a browser process Playwright's own close() protocol can no
            // longer get an answer from (its child processes already killed out from under it).
            close: () => new Promise<void>(() => undefined),
            on: () => undefined,
            browser: () => ({ isConnected: () => true, process: () => ({ pid: 424_242 }) })
          }) satisfies BrowserContextLike
      }
    });

    await manager.start();
    expect(manager.isRunning()).toBe(true);
    // The whole point: this resolves at all (within the 20ms closeTimeoutMs, not the default 5s),
    // rather than hanging on the close() above that never settles.
    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(killed).toEqual([424_242]);
    expect(manager.isRunning()).toBe(false);
    // Force-killed and moved on -- not treated as a "failed close" that would block a relaunch.
    await expect(manager.start()).resolves.toBeUndefined();
    await manager.close();
  });

  it("force-kills the sign-in window's browser process when its close() never settles", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-hung-headed-close-"));
    const killed: number[] = [];
    const manager = new BrowserManager({
      profilePath,
      closeTimeoutMs: 20,
      killProcessTree: async (pid) => {
        killed.push(pid);
      },
      launcher: {
        launchPersistentContext: async () =>
          ({
            pages: () => [],
            close: () => new Promise<void>(() => undefined),
            on: () => undefined,
            browser: () => ({ isConnected: () => true, process: () => ({ pid: 555 }) })
          }) satisfies BrowserContextLike
      }
    });

    // Mirrors the existing "cancels a running sign-in..." test above: the body registers its abort
    // listener and only *then* does the test cancel from the outside. Cancelling from inside the
    // body itself, before that registration, would abort the signal before the listener exists.
    let markRunning: (() => void) | undefined;
    const running = new Promise<void>((resolve) => (markRunning = resolve));
    let sawSignal = false;
    const login = manager.runInteractiveLogin(async (_context, signal) => {
      markRunning?.();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      sawSignal = true;
      return "never-completed";
    });
    await running;
    expect(manager.cancelInteractiveLogin()).toBe(true);
    await expect(login).rejects.toMatchObject({ code: "AUTH_FAILED", details: { cancelled: true } });
    expect(sawSignal).toBe(true);
    expect(killed).toEqual([555]);
    expect(manager.isRunning()).toBe(false);
  });

  it("keeps a settling close's existing behavior unchanged and never force-kills it", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-fast-close-"));
    let killCalls = 0;
    const manager = new BrowserManager({
      profilePath,
      closeTimeoutMs: 500,
      killProcessTree: async () => {
        killCalls++;
      },
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          close: async () => undefined,
          on: () => undefined
        })
      }
    });

    await manager.start();
    await expect(manager.close()).resolves.toBeUndefined();
    expect(killCalls).toBe(0);
  });

  it("classifies a Chromium exit-code-21 launch failure with a specific, actionable remediation", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-owned-profile-"));
    const manager = new BrowserManager({
      profilePath,
      launcher: {
        launchPersistentContext: async () => {
          throw new Error(
            "browserType.launchPersistentContext: Target page, context or browser has been closed\n" +
              "Call log:\n" +
              "  - [pid=24092] <process did exit: exitCode=21, signal=null>"
          );
        }
      }
    });

    await expect(manager.start()).rejects.toMatchObject({
      code: "BROWSER_START_FAILED",
      remediation: expect.stringMatching(/owns the profile/)
    });
  });

  it("recovers once from an exit-code-21 failure when the profile lock names a live, verified-owner pid, then retries the launch", async () => {
    if (process.platform === "win32") return; // POSIX-only symlink lock, matches ProfileManager.
    const profilePath = await ownedProfile("apl-owned-profile-recover-");
    const lockPath = path.join(profilePath, "SingletonLock");
    // `process.pid` is genuinely alive (this test worker), so `tryRecoverFromOwnedProfile`'s own
    // liveness check needs no fake -- only the ownership/kill steps are stubbed, so nothing ever
    // touches a real process.
    await symlink(`${os.hostname()}-${process.pid}`, lockPath);
    const ownerChecks: Array<{ pid: number; profilePath: string }> = [];
    const killed: number[] = [];
    let attempts = 0;
    const manager = new BrowserManager({
      profilePath,
      isProfileOwnerProcess: async (pid, checkedPath) => {
        ownerChecks.push({ pid, profilePath: checkedPath });
        return true;
      },
      killProcessTree: async (pid) => {
        killed.push(pid);
      },
      launcher: {
        launchPersistentContext: async () => {
          attempts++;
          if (attempts === 1)
            throw new Error(
              "browserType.launchPersistentContext: Target page, context or browser has been closed\n" +
                "  - [pid=24092] <process did exit: exitCode=21, signal=null>"
            );
          return { pages: () => [], close: async () => undefined, on: () => undefined };
        }
      }
    });

    await expect(manager.start()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(ownerChecks).toEqual([{ pid: process.pid, profilePath }]);
    expect(killed).toEqual([process.pid]);
    await manager.close();
  });

  it("never repeats the owned-profile recovery attempt within one launchContext() call", async () => {
    if (process.platform === "win32") return; // POSIX-only symlink lock, matches ProfileManager.
    const profilePath = await ownedProfile("apl-owned-profile-once-");
    const lockPath = path.join(profilePath, "SingletonLock");
    await symlink(`${os.hostname()}-${process.pid}`, lockPath);
    let ownerCheckCalls = 0;
    let killCalls = 0;
    let attempts = 0;
    const manager = new BrowserManager({
      profilePath,
      startupTimeoutMs: 8_000,
      isProfileOwnerProcess: async () => {
        ownerCheckCalls++;
        return true;
      },
      killProcessTree: async () => {
        killCalls++;
      },
      launcher: {
        launchPersistentContext: async () => {
          attempts++;
          // Keeps failing the same way even after the "recovery" above -- a real dead pid would
          // never come back, so a second recovery attempt must never be tried.
          throw new Error(
            "browserType.launchPersistentContext: Target page, context or browser has been closed\n" +
              "  - [pid=24092] <process did exit: exitCode=21, signal=null>"
          );
        }
      }
    });

    await expect(manager.start()).rejects.toMatchObject({ code: "BROWSER_START_FAILED" });
    expect(ownerCheckCalls).toBe(1);
    expect(killCalls).toBe(1);
    // The one retry the recovery bought it, plus the original attempt -- never more.
    expect(attempts).toBe(2);
  });
});

/**
 * docs/validation-log-2026-09-14-windows-round4.md U2: a `close()` that itself settles (resolves,
 * never hitting `closeTimeoutMs`) does not by itself prove the browser's OS process -- let alone its
 * child tree -- has actually exited. `ensureBrowserProcessGone` (browser-manager.ts) now waits for
 * both, bounded, force-killing whatever is left once each bound elapses.
 */
describe("BrowserManager round 4 U2: waits for the browser process (and its profile's tree) after a settled close()", () => {
  it("waits for the browser's main process to exit on its own after close() settles, without force-killing it", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-exit-wait-"));
    const pid = spawnDisposableProcess();
    setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, 60);
    const killed: number[] = [];
    const manager = new BrowserManager({
      profilePath,
      browserExitTimeoutMs: 3_000,
      processExec: async () => ({ stdout: "" }),
      killProcessTree: async (killedPid) => {
        killed.push(killedPid);
      },
      launcher: {
        launchPersistentContext: async () =>
          ({
            pages: () => [],
            close: async () => undefined,
            on: () => undefined,
            browser: () => ({ isConnected: () => true, process: () => ({ pid }) })
          }) satisfies BrowserContextLike
      }
    });

    await manager.start();
    await expect(manager.close()).resolves.toBeUndefined();
    expect(killed).toEqual([]);
    // Genuinely gone (killed by the test's own timer above, not by this manager) -- proof this
    // actually waited for the real exit rather than racing ahead of it.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("force-kills the main process and logs it when it does not exit within browserExitTimeoutMs", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-exit-force-"));
    const pid = spawnDisposableProcess();
    const killed: number[] = [];
    const logs: string[] = [];
    const manager = new BrowserManager({
      profilePath,
      browserExitTimeoutMs: 30,
      processExec: async () => ({ stdout: "" }),
      killProcessTree: async (killedPid) => {
        killed.push(killedPid);
      },
      onLog: (line) => logs.push(line),
      launcher: {
        launchPersistentContext: async () =>
          ({
            pages: () => [],
            close: async () => undefined,
            on: () => undefined,
            browser: () => ({ isConnected: () => true, process: () => ({ pid }) })
          }) satisfies BrowserContextLike
      }
    });

    await manager.start();
    await expect(manager.close()).resolves.toBeUndefined();
    expect(killed).toEqual([pid]);
    expect(logs.some((line) => line.includes(`main process (pid ${pid}) did not exit within`))).toBe(true);
  });

  it("waits for the profile's remaining browser-tree processes once the main process is already gone, force-killing whatever is left once that bound elapses too", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-tree-force-"));
    const deadMainPid = deadPid(); // already gone -- skips straight to the tree phase
    const stuckPid = 424_242;
    const killed: number[] = [];
    const logs: string[] = [];
    const manager = new BrowserManager({
      profilePath,
      browserExitTimeoutMs: 3_000,
      browserTreeTimeoutMs: 30,
      // ISSUE-2026-09-14-13: formatted for whichever platform actually runs this suite (real
      // `process.platform`, unpinned) so the fixture's shape always matches the branch
      // `listCandidateProcesses` takes, on a real Windows host as much as on macOS/Linux --
      // `profilePath` above is likewise this host's own native temp path either way.
      processExec: fakeProcessListing([
        { pid: stuckPid, ppid: 1, command: `/usr/bin/fake-msedge --user-data-dir=${profilePath}` }
      ]),
      killProcessTree: async (killedPid) => {
        killed.push(killedPid);
      },
      onLog: (line) => logs.push(line),
      launcher: {
        launchPersistentContext: async () =>
          ({
            pages: () => [],
            close: async () => undefined,
            on: () => undefined,
            browser: () => ({ isConnected: () => true, process: () => ({ pid: deadMainPid }) })
          }) satisfies BrowserContextLike
      }
    });

    await manager.start();
    await expect(manager.close()).resolves.toBeUndefined();
    expect(killed).toEqual([stuckPid]);
    expect(logs).toContain("broker: force-killed 1 browser processes of the profile");
  });

  it("never runs the exit/tree wait when the context reports no browser pid", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-no-pid-"));
    let execCalls = 0;
    const manager = new BrowserManager({
      profilePath,
      processExec: async () => {
        execCalls++;
        return { stdout: "" };
      },
      launcher: {
        launchPersistentContext: async () => ({
          pages: () => [],
          close: async () => undefined,
          on: () => undefined
          // No `browser()` at all -- browserPidOf() returns undefined, matching most launcher
          // fixtures elsewhere in this file (and the real launcher, when Playwright's own probe is
          // unavailable).
        })
      }
    });

    await manager.start();
    // launchContext() itself already called processExec once for its own pre-launch pid-list
    // snapshot (docs/validation-log-2026-09-14-windows-round5.md V2, item 1 -- see that log line's
    // own doc comment in browser-manager.ts). This test is about the *close* path's exit/tree wait,
    // so only calls made from here on are relevant.
    const execCallsAfterStart = execCalls;
    await expect(manager.close()).resolves.toBeUndefined();
    expect(execCalls).toBe(execCallsAfterStart);
  });
});

/**
 * docs/validation-log-2026-09-14-windows-round4.md U2 (item 3): a plain `BrowserStartTimeout` is
 * reclassified with a more actionable remediation when `src/broker/profile-processes.js` still
 * finds a browser process of this exact profile at the moment the timeout fires -- strong evidence
 * of contention (most often an old broker's browser still shutting down) rather than a plain slow
 * start.
 */
describe("BrowserManager round 4 U2: classifies a launch timeout as profile contention when another process is found", () => {
  it("kills the launched tree and retries once, still failing with the profile-contention classification when both attempts hang", async () => {
    // docs/validation-log-2026-09-14-windows-round5.md V2, "shorter penalty": the first launch
    // after broker start now gets a shorter budget and one kill-and-retry (see
    // browser-manager.ts's `launchWithFirstAttemptRetry`) instead of eating the full
    // `startupTimeoutMs` outright -- this is round4 U2's own scenario above, now exercised through
    // that retry: both the shorter first attempt and the full-budget retry hang the same way, so
    // the final classification is unchanged ("BROWSER_START_FAILED with the classification from
    // yesterday"), but the launcher is now called twice and the stuck tree is killed once in
    // between.
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-launch-timeout-contended-"));
    const otherPid = 99_991;
    const killed: number[] = [];
    let attempts = 0;
    const manager = new BrowserManager({
      profilePath,
      startupTimeoutMs: 30,
      firstLaunchTimeoutMs: 30,
      firstLaunchKillWaitTimeoutMs: 30,
      // ISSUE-2026-09-14-13: see the round4 U2 "waits for the browser process" describe above --
      // formatted for whichever platform actually runs this suite so it matches the branch
      // `listCandidateProcesses` takes on a real Windows host as much as on macOS/Linux.
      processExec: fakeProcessListing([
        { pid: otherPid, ppid: 1, command: `/usr/bin/fake-msedge --user-data-dir=${profilePath}` }
      ]),
      killProcessTree: async (pid) => {
        killed.push(pid);
      },
      launcher: {
        // Never resolves, on either attempt -- models the exact hang this classification targets.
        launchPersistentContext: () => {
          attempts++;
          return new Promise<BrowserContextLike>(() => undefined);
        }
      }
    });

    await expect(manager.start()).rejects.toMatchObject({
      code: "BROWSER_START_FAILED",
      remediation: expect.stringContaining("still running/shutting down")
    });
    expect(attempts).toBe(2);
    expect(killed).toEqual([otherPid]);
  });

  it("kills the launched tree and succeeds on the retried second attempt after the first launch after broker start times out", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-first-launch-retry-"));
    const stalePid = 88_881;
    const killed: number[] = [];
    let attempts = 0;
    const manager = new BrowserManager({
      profilePath,
      startupTimeoutMs: 5_000,
      firstLaunchTimeoutMs: 30,
      firstLaunchKillWaitTimeoutMs: 200,
      // Stops reporting the stale pid once it has been "killed" -- models a predecessor broker's
      // browser tree that is genuinely still shutting down and then actually goes away, unlike the
      // "both hang" scenario above. ISSUE-2026-09-14-13: formatted for whichever platform actually
      // runs this suite (real `process.platform`, unpinned), same as the fixed processExec above.
      processExec: async () =>
        formatProcessListing(
          killed.includes(stalePid)
            ? []
            : [{ pid: stalePid, ppid: 1, command: `/usr/bin/fake-msedge --user-data-dir=${profilePath}` }]
        ),
      killProcessTree: async (pid) => {
        killed.push(pid);
      },
      launcher: {
        launchPersistentContext: async () => {
          attempts++;
          // First attempt hangs (the shorter firstLaunchTimeoutMs budget above times it out);
          // the retry, with the full startupTimeoutMs budget, succeeds immediately.
          if (attempts === 1) return new Promise<BrowserContextLike>(() => undefined);
          return { pages: () => [], close: async () => undefined, on: () => undefined };
        }
      }
    });

    await expect(manager.start()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(killed).toEqual([stalePid]);
    await manager.close();
  });

  it("keeps the generic timeout message when no other profile process is found", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-launch-timeout-clean-"));
    const manager = new BrowserManager({
      profilePath,
      startupTimeoutMs: 30,
      processExec: async () => ({ stdout: "" }),
      launcher: {
        launchPersistentContext: () => new Promise<BrowserContextLike>(() => undefined)
      }
    });

    await expect(manager.start()).rejects.toMatchObject({
      code: "BROWSER_START_FAILED",
      remediation: "Run: m365-agent broker restart"
    });
  });
});
