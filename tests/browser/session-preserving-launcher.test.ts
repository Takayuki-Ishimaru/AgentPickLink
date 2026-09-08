import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext } from "playwright-core";
import { describe, expect, it } from "vitest";
import { createBrowserLauncher } from "../../src/transports/browser/session-preserving-launcher.js";
import type { BrowserContextLike } from "../../src/transports/browser/types.js";

const executable = [
  process.env.M365_AGENT_TEST_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome"
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

describe.skipIf(!executable || !!process.env.CI)("session-preserving launcher", () => {
  it.skipIf(process.platform !== "win32")(
    "hides only its own Windows browser and keeps new tabs hidden",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "apl-native-hide-"));
      const ownedProfile = path.join(root, "owned");
      const otherProfile = path.join(root, "other");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(ownedProfile);
      let owned: (BrowserContext & BrowserContextLike) | undefined;
      let other: BrowserContext | undefined;
      const visible = async (pid: number) => {
        const result = await promisify(execFile)(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById(${pid});$p.Refresh();if($p.MainWindowHandle -ne [IntPtr]::Zero){'VISIBLE'}else{'HIDDEN'}`
          ],
          { windowsHide: true, timeout: 15_000 }
        );
        return result.stdout.trim() === "VISIBLE";
      };
      const pidOf = async (context: BrowserContext) => {
        const cdp = await context.browser()!.newBrowserCDPSession();
        try {
          const result = await cdp.send("SystemInfo.getProcessInfo");
          return result.processInfo.find((info) => info.type === "browser")!.id;
        } finally {
          await cdp.detach();
        }
      };
      try {
        other = await chromium.launchPersistentContext(otherProfile, {
          executablePath: executable,
          headless: false,
          timeout: 30_000
        });
        owned = (await createBrowserLauncher(chromium).launchInteractiveContext!(
          ownedProfile,
          {
            executablePath: executable,
            timeout: 30_000
          },
          { headless: true, acceptDownloads: false }
        )) as BrowserContext & BrowserContextLike;
        const ownPid = await pidOf(owned);
        const otherPid = await pidOf(other);
        expect(ownPid).not.toBe(otherPid);
        expect(await visible(ownPid)).toBe(true);
        expect(await visible(otherPid)).toBe(true);
        await owned.completeInteractiveLogin!();
        expect(await visible(ownPid)).toBe(false);
        expect(await visible(otherPid)).toBe(true);
        const pages = await Promise.all([owned.newPage(), owned.newPage()]);
        expect(pages).toHaveLength(2);
        expect(await visible(ownPid)).toBe(false);
        expect(await visible(otherPid)).toBe(true);
      } finally {
        await owned?.close();
        await other?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000
  );

  it("denies sign-in downloads, then saves automation downloads and cleans staging on close", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "apl-retained-downloads-"));
    const server = http.createServer((req, res) => {
      if (req.url === "/download") {
        res.writeHead(200, {
          "Content-Disposition": 'attachment; filename="test.txt"',
          "Content-Type": "text/plain"
        });
        res.end("synthetic attachment bytes");
      } else {
        res.setHeader("Content-Type", "text/html");
        res.end('<a href="/download">Download</a>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture port missing");
    const origin = `http://127.0.0.1:${address.port}`;
    const hiddenPids: number[] = [];
    let loginPageClosedAtFirstHide: boolean | undefined;
    const launcher = createBrowserLauncher(chromium, async (pid) => {
      if (hiddenPids.length === 0) loginPageClosedAtFirstHide = context?.pages()[0]?.isClosed();
      hiddenPids.push(pid);
    });
    let context: (BrowserContext & BrowserContextLike) | undefined;
    try {
      context = (await launcher.launchInteractiveContext!(
        profile,
        {
          executablePath: executable,
          headless: false,
          timeout: 15_000
        },
        { headless: false, acceptDownloads: true }
      )) as BrowserContext & BrowserContextLike;
      const page = context.pages()[0];
      await page.goto(origin);
      const denied = page.waitForEvent("download", { timeout: 5_000 });
      await page.getByRole("link", { name: "Download" }).click();
      expect(await (await denied).failure()).toBeTruthy();
      const staging = (await readdir(profile)).filter((name) => name.startsWith(".apl-downloads-"));
      expect(staging).toHaveLength(1);
      expect(await readdir(path.join(profile, staging[0]))).toEqual([]);

      await context.completeInteractiveLogin!();
      expect(page.isClosed()).toBe(true);
      expect(loginPageClosedAtFirstHide).toBe(false);
      const work = await context.newPage();
      await work.goto(origin);
      const allowed = work.waitForEvent("download", { timeout: 5_000 });
      await work.getByRole("link", { name: "Download" }).click();
      const download = await allowed;
      expect(await download.failure()).toBeNull();
      const saved = await download.path();
      expect(saved).toBeTruthy();
      expect(await readFile(saved!, "utf8")).toBe("synthetic attachment bytes");
      expect(hiddenPids.length).toBeGreaterThan(1);
      expect(new Set(hiddenPids).size).toBe(1);
      await context.close();
      context = undefined;
      expect(existsSync(path.join(profile, staging[0]))).toBe(false);
    } finally {
      await context?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(profile, { recursive: true, force: true });
    }
  }, 45_000);

  it("rejects the handoff when native hiding fails", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "apl-hide-failed-"));
    const launcher = createBrowserLauncher(chromium, async () => {
      throw new Error("native hide failed");
    });
    let context: BrowserContextLike | undefined;
    try {
      context = await launcher.launchInteractiveContext!(
        profile,
        {
          executablePath: executable,
          timeout: 15_000
        },
        { headless: true, acceptDownloads: false }
      );
      await expect(context.completeInteractiveLogin!()).rejects.toThrow("native hide failed");
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  }, 30_000);
});
