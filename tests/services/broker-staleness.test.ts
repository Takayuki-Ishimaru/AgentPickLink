/**
 * `restartBrokerIfStale`'s §4.7 C13 `expected` field: staleness-by-build judged against
 * `install.json`'s own `packageVersion`/`build`, not against a `stat()` of the caller's own copy
 * of `brokerEntry`. `tests/extension/stale-broker.test.ts` keeps covering the original
 * `context.brokerEntry`-`stat()` path (every extension call site) unchanged; these tests cover the
 * new `context.expected` path (`src/frontend/lazy-broker-port.ts`, which may have no locally
 * resolvable broker entry file to `stat()` at all).
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDescriptor, writeDescriptor } from "../../src/broker/broker-descriptor.js";
import { appPaths, type AppPaths } from "../../src/config/paths.js";
import { defaultGlobalConfig, saveGlobalConfig } from "../../src/config/global-config.js";
import { restartBrokerIfStale, stopBroker } from "../../src/services/broker-staleness.js";
import { fakeProcessListing } from "../helpers/platform.js";

const {
  connectExistingBrokerMock,
  waitForDescriptorGoneMock,
  isExpectedBrokerProcessMock,
  killProcessTreeMock
} = vi.hoisted(() => ({
  connectExistingBrokerMock: vi.fn(),
  waitForDescriptorGoneMock: vi.fn(),
  // Defaults to "not confirmed" -- every scenario in this file that never overrides it uses
  // `process.pid` or another pid that is emphatically not a real broker, so the decisive
  // force-kill phase (src/services/broker-staleness.ts) must never treat it as one.
  isExpectedBrokerProcessMock: vi.fn().mockResolvedValue(false),
  killProcessTreeMock: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../../src/broker/broker-lifecycle.js", () => ({
  connectExistingBroker: connectExistingBrokerMock,
  connectOrStartBroker: vi.fn(),
  waitForDescriptorGone: waitForDescriptorGoneMock,
  isExpectedBrokerProcess: isExpectedBrokerProcessMock
}));
// The real implementation shells out to taskkill/SIGKILL a real pid -- never real in this suite.
vi.mock("../../src/broker/process-kill.js", () => ({ killProcessTree: killProcessTreeMock }));
// A faithful-enough stand-in for the real `waitForDescriptorGone` (broker-lifecycle.ts): polls the
// real descriptor file every 5ms until it is gone or `timeoutMs` runs out. Every scenario below that
// removes the descriptor synchronously inside its `broker.shutdown` mock sees this resolve `true` on
// the very first check; ISSUE-06's own "lingers then disappears"/timeout tests rely on the real
// polling behaviour instead of a canned answer.
waitForDescriptorGoneMock.mockImplementation(
  async (paths: AppPaths, _instanceId?: string, timeoutMs = 15_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await readDescriptor(paths).catch(() => undefined))) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
);

/** ISSUE-06: every scenario below reaches `stopBroker` with a real, currently-running pid
 * (`process.pid`, for a real descriptor), which never looks "gone" to `isBrokerPidAlive` -- a
 * tiny override keeps the new post-shutdown wait from actually blocking for its 15s default. */
const fastReleaseWait = { timeoutMs: 20, pollMs: 5 };

/** Not a real process on any machine this suite runs on (and never will be, per the platform's own
 * cap on pid reuse ordering); `isBrokerPidAlive` (src/services/broker-staleness.ts) always reports
 * this as gone on the very first check. */
const DEAD_PID = 999_999;

/** Real, disposable child processes for the decisive-force-kill tests below (round 3's S2): unlike
 * `process.pid` (this test worker, which must never actually be killed) or `DEAD_PID` (never
 * alive), these give `waitForBrokerFullyReleased`'s post-kill recheck a pid whose liveness genuinely
 * changes when `killProcessTree` (mocked to really SIGKILL it) runs -- the same thing a real broker
 * or browser process would do. Tracked and swept up in `afterEach` as a safety net beyond each
 * test's own cleanup. */
const spawnedPids: number[] = [];
function spawnDisposableProcess(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  spawnedPids.push(child.pid!);
  return child.pid!;
}

/** ISSUE-2026-09-14-13 (docs/validation-log-2026-09-14-windows-round5.md): `waitForBrokerFullyReleased`'s
 * browser-tree phase reads `process.platform` (via src/broker/profile-processes.ts) to decide
 * whether `releaseWait.exec`'s fixture is POSIX `ps` lines or Windows CIM JSON -- a test whose
 * fixture is one specific format must pin the platform for its duration, or the real host running
 * this suite decides which branch parses it instead. Restored in the shared `afterEach` below. */
let platformSpy: ReturnType<typeof vi.spyOn> | undefined;
function pinPlatform(platform: NodeJS.Platform): void {
  platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone -- the point of this sweep */
    }
  }
  // Call history, not just queued `...Once` implementations -- otherwise a later test's
  // `not.toHaveBeenCalled()` would see an earlier test's calls too.
  isExpectedBrokerProcessMock.mockClear();
  killProcessTreeMock.mockClear();
  platformSpy?.mockRestore();
  platformSpy = undefined;
});

async function makeStaleness(version = "1.0.0", pid = process.pid) {
  const base = await mkdtemp(path.join(os.tmpdir(), "apl-staleness-expected-"));
  const paths = appPaths(base);
  await saveGlobalConfig(paths, defaultGlobalConfig(path.join(base, "profile")));
  await writeDescriptor(paths, {
    pid,
    pipeName: path.join(base, "broker.sock"),
    protocolMajor: 1,
    protocolMinor: 1,
    packageVersion: version,
    instanceId: "expected-field-broker",
    authSecret: "test-secret"
  });
  return { base, paths };
}

describe("restartBrokerIfStale with context.expected (§4.7 C13)", () => {
  it("is stale when the descriptor's packageVersion differs from expected.packageVersion, without stat()-ing brokerEntry", async () => {
    const { base, paths } = await makeStaleness("0.1.0");
    // brokerEntry deliberately points at a file that does not exist: the version comparison must
    // never need to read it.
    const missingEntry = path.join(base, "does-not-exist", "process.js");
    const call = vi.fn(async (method: string) => {
      if (method === "broker.shutdown") await rm(paths.descriptor, { force: true });
      return {};
    });
    const close = vi.fn();
    connectExistingBrokerMock.mockResolvedValue({ call, close });
    const logs: string[] = [];
    try {
      const result = await restartBrokerIfStale({
        paths,
        brokerEntry: missingEntry,
        log: (line) => logs.push(line),
        expected: { packageVersion: "0.2.0" },
        releaseWait: fastReleaseWait
      });
      expect(result).toBe(true);
      expect(call).toHaveBeenCalledWith("broker.shutdown", {});
      expect(call).not.toHaveBeenCalledWith("broker.health", expect.anything());
      expect(logs.some((line) => line.includes("older build"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  it("is not stale-by-build when packageVersion matches (falls through to the browser-configuration check)", async () => {
    const { base, paths } = await makeStaleness("0.2.0");
    const call = vi.fn().mockResolvedValue({ browser: { channel: "msedge", headless: true } });
    const close = vi.fn();
    connectExistingBrokerMock.mockResolvedValue({ call, close });
    try {
      const result = await restartBrokerIfStale({
        paths,
        brokerEntry: path.join(base, "does-not-exist", "process.js"),
        log: vi.fn(),
        expected: { packageVersion: "0.2.0" }
      });
      expect(result).toBe(false);
      expect(call).toHaveBeenCalledWith("broker.health", {}, undefined, expect.any(AbortSignal));
      expect(call).not.toHaveBeenCalledWith("broker.shutdown", {});
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  it("is stale when packageVersion matches but expected.build differs (entry or mtime)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-staleness-expected-"));
    const paths = appPaths(base);
    await saveGlobalConfig(paths, defaultGlobalConfig(path.join(base, "profile")));
    const entry = path.join(base, "app", "0.2.0", "dist", "broker", "process.js");
    await writeDescriptor(paths, {
      pid: process.pid,
      pipeName: path.join(base, "broker.sock"),
      protocolMajor: 1,
      protocolMinor: 1,
      packageVersion: "0.2.0",
      instanceId: "expected-build-broker",
      authSecret: "test-secret",
      build: { entry, mtimeMs: 1000 }
    });
    const call = vi.fn(async (method: string) => {
      if (method === "broker.shutdown") await rm(paths.descriptor, { force: true });
      return {};
    });
    const close = vi.fn();
    connectExistingBrokerMock.mockResolvedValue({ call, close });
    try {
      const result = await restartBrokerIfStale({
        paths,
        brokerEntry: entry,
        log: vi.fn(),
        expected: { packageVersion: "0.2.0", build: { entry, mtimeMs: 2000 } },
        releaseWait: fastReleaseWait
      });
      expect(result).toBe(true);
      expect(call).toHaveBeenCalledWith("broker.shutdown", {});
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });
});

/**
 * ISSUE-06 (docs/validation-log-2026-09-14-windows.md): a fresh home whose shared
 * `M365_AGENT_APP_DATA` still has the previous home's broker running hits `BROWSER_START_FAILED`
 * right after the staleness guard stops that old broker -- the new broker launches its own browser
 * on the same profile directory while the old one is still exiting. `waitForBrokerFullyReleased`
 * (private to src/services/broker-staleness.ts) is what `stopBroker` now waits on before returning;
 * these three scenarios exercise it end to end through the public `restartBrokerIfStale`.
 */
describe("restartBrokerIfStale waits for the old broker to fully release (ISSUE-06)", () => {
  it("waits for a descriptor that lingers briefly before disappearing", async () => {
    const { base, paths } = await makeStaleness("0.1.0", DEAD_PID);
    // Unlike the other scenarios above, `broker.shutdown` here does *not* remove the descriptor --
    // something else (standing in for the old broker actually exiting) does, a little later.
    const call = vi.fn().mockResolvedValue({});
    connectExistingBrokerMock.mockResolvedValue({ call, close: vi.fn() });
    const lingering = setTimeout(() => {
      void rm(paths.descriptor, { force: true });
    }, 15);
    const logs: string[] = [];
    try {
      const result = await restartBrokerIfStale({
        paths,
        brokerEntry: path.join(base, "does-not-exist", "process.js"),
        log: (line) => logs.push(line),
        expected: { packageVersion: "0.2.0" },
        // All three release conditions clear here, so this reaches `ensureBrowserTreeGone()`
        // (ISSUE-2026-09-14-13): an uninjected `exec` would otherwise shell out for real.
        releaseWait: { timeoutMs: 2_000, pollMs: 5, exec: fakeProcessListing([]) }
      });
      expect(result).toBe(true);
      expect(logs.some((line) => line.includes("fully released"))).toBe(true);
      expect(logs.some((line) => line.includes("gave up"))).toBe(false);
    } finally {
      clearTimeout(lingering);
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  it("waits for the browser profile lock file to be released before returning", async () => {
    const { base, paths } = await makeStaleness("0.1.0", DEAD_PID);
    await mkdir(paths.profile, { recursive: true });
    // `lockfile` (rather than a POSIX `SingletonLock` symlink) since a plain file is the simplest
    // fixture that is meaningful on every platform this suite runs on.
    const lockPath = path.join(paths.profile, "lockfile");
    await writeFile(lockPath, "");
    const call = vi.fn(async (method: string) => {
      if (method === "broker.shutdown") await rm(paths.descriptor, { force: true });
      return {};
    });
    connectExistingBrokerMock.mockResolvedValue({ call, close: vi.fn() });
    const lingering = setTimeout(() => {
      void rm(lockPath, { force: true });
    }, 15);
    const logs: string[] = [];
    try {
      const result = await restartBrokerIfStale({
        paths,
        brokerEntry: path.join(base, "does-not-exist", "process.js"),
        log: (line) => logs.push(line),
        expected: { packageVersion: "0.2.0" },
        // Same as the descriptor test above: this reaches `ensureBrowserTreeGone()` once the lock
        // clears (ISSUE-2026-09-14-13).
        releaseWait: { timeoutMs: 2_000, pollMs: 5, exec: fakeProcessListing([]) }
      });
      expect(result).toBe(true);
      expect(logs.some((line) => line.includes("fully released"))).toBe(true);
    } finally {
      clearTimeout(lingering);
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  it("gives up after the bound and still lets the caller proceed when nothing is ever released", async () => {
    // `process.pid` (never dies here) and a `broker.shutdown` that never removes the descriptor:
    // none of the three conditions is ever met, so this always exercises the timeout branch.
    const { base, paths } = await makeStaleness("0.1.0");
    const call = vi.fn().mockResolvedValue({});
    connectExistingBrokerMock.mockResolvedValue({ call, close: vi.fn() });
    const logs: string[] = [];
    try {
      const result = await restartBrokerIfStale({
        paths,
        brokerEntry: path.join(base, "does-not-exist", "process.js"),
        log: (line) => logs.push(line),
        expected: { packageVersion: "0.2.0" },
        releaseWait: { timeoutMs: 30, pollMs: 5 }
      });
      // Still proceeds -- the caller's own next connect-or-start (browser-manager's launch retry)
      // handles the rest from here.
      expect(result).toBe(true);
      const gaveUp = logs.find((line) => line.includes("gave up"));
      expect(gaveUp).toBeTruthy();
      expect(gaveUp).toContain("descriptor present");
      expect(gaveUp).toContain("pid alive");
      expect(gaveUp).toContain("profile lock released"); // no profile directory was ever created
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });
});

/**
 * docs/validation-log-2026-09-14-windows-round3.md S2: the decisive phase `waitForBrokerFullyReleased`
 * now runs once the polite wait above is spent -- exercised directly through the exported
 * `stopBroker` so each test controls exactly which pid is confirmed as "ours" without going through
 * `restartBrokerIfStale`'s own staleness judgment.
 */
describe("stopBroker's decisive force-kill phase (round 3 S2)", () => {
  function fakeShutdownClient() {
    return { call: vi.fn().mockResolvedValue({}), close: vi.fn() };
  }

  it("force-kills the old broker's own pid once isExpectedBrokerProcess confirms it, and reports release once it's gone", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-staleness-force-"));
    const paths = appPaths(base);
    const oldBrokerPid = spawnDisposableProcess();
    isExpectedBrokerProcessMock.mockResolvedValueOnce(true);
    killProcessTreeMock.mockImplementationOnce(async (pid: number) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    });
    const logs: string[] = [];
    try {
      const result = await stopBroker(fakeShutdownClient(), paths, oldBrokerPid, (line) => logs.push(line), {
        timeoutMs: 20,
        pollMs: 5,
        forceKillGraceMs: 2_000,
        // The forced kill above clears both release conditions, so this reaches
        // `ensureBrowserTreeGone()` (ISSUE-2026-09-14-13): an uninjected `exec` would otherwise
        // shell out for real.
        exec: fakeProcessListing([])
      });
      expect(result).toBe(true);
      expect(isExpectedBrokerProcessMock).toHaveBeenCalledWith(oldBrokerPid);
      expect(killProcessTreeMock).toHaveBeenCalledWith(oldBrokerPid);
      expect(
        logs.some((line) => line.includes("force-killing it") && line.includes(String(oldBrokerPid)))
      ).toBe(true);
      expect(logs.some((line) => line.includes("released after a forced stop"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("also force-kills the descriptor's browserPid tree when it is still alive after the old broker pid is already gone", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-staleness-force-"));
    const paths = appPaths(base);
    await mkdir(paths.profile, { recursive: true });
    const lockPath = path.join(paths.profile, "lockfile");
    // Kept present through the whole polite wait -- the point is to force this test into the
    // decisive phase, the same way a browser that has not yet let go of the profile would.
    await writeFile(lockPath, "");
    const browserPid = spawnDisposableProcess();
    killProcessTreeMock.mockImplementationOnce(async (pid: number) => {
      expect(pid).toBe(browserPid); // the old broker pid (DEAD_PID) must never reach this
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await rm(lockPath, { force: true });
    });
    const logs: string[] = [];
    try {
      const result = await stopBroker(
        fakeShutdownClient(),
        paths,
        DEAD_PID,
        (line) => logs.push(line),
        // Same as the previous test: the forced kill clears the lock, so this reaches
        // `ensureBrowserTreeGone()` (ISSUE-2026-09-14-13).
        { timeoutMs: 20, pollMs: 5, forceKillGraceMs: 2_000, exec: fakeProcessListing([]) },
        browserPid
      );
      expect(result).toBe(true);
      // DEAD_PID was never alive, so the broker-pid branch never even asks; only the browser branch
      // (which found it alive) should ever call isExpectedBrokerProcess/killProcessTree.
      expect(isExpectedBrokerProcessMock).not.toHaveBeenCalled();
      expect(killProcessTreeMock).toHaveBeenCalledWith(browserPid);
      expect(killProcessTreeMock).not.toHaveBeenCalledWith(DEAD_PID);
      expect(logs.some((line) => line.includes("browser process") && line.includes(String(browserPid)))).toBe(
        true
      );
      expect(logs.some((line) => line.includes("released after a forced stop"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("never kills a pid that isn't confirmed as the broker's own process", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-staleness-force-"));
    const paths = appPaths(base);
    const notABroker = spawnDisposableProcess();
    isExpectedBrokerProcessMock.mockResolvedValueOnce(false);
    const logs: string[] = [];
    try {
      const result = await stopBroker(fakeShutdownClient(), paths, notABroker, (line) => logs.push(line), {
        timeoutMs: 20,
        pollMs: 5,
        forceKillGraceMs: 20
      });
      expect(result).toBe(true);
      expect(isExpectedBrokerProcessMock).toHaveBeenCalledWith(notABroker);
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      // Still genuinely alive -- proof nothing was actually killed, not just that the mock wasn't
      // called.
      expect(() => process.kill(notABroker, 0)).not.toThrow();
      const gaveUp = logs.find((line) => line.includes("gave up"));
      expect(gaveUp).toBeTruthy();
      expect(gaveUp).toContain("pid alive");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

/**
 * docs/validation-log-2026-09-14-windows-round4.md U2: neither the descriptor disappearing, the old
 * broker's own pid exiting, nor even its `SingletonLock`/`lockfile` symlink disappearing (all
 * already covered above) actually proves the browser process tree that broker launched is gone --
 * on Windows the `lockfile` path is never removed on exit, only its handle released. Once the old
 * broker's own pid is confirmed gone, `waitForBrokerFullyReleased` now also waits (via
 * src/broker/profile-processes.js) for no browser process of the profile to remain, force-killing
 * whatever is left once that bound elapses. `releaseWait.exec` injects a fake process-listing
 * primitive so these never have to shell out for real.
 */
describe("waitForBrokerFullyReleased's browser-tree phase (round 4 U2)", () => {
  it("logs the browser-tree-gone line once the old broker's pid is already gone and nothing of the profile is found", async () => {
    const { base, paths } = await makeStaleness("0.1.0", DEAD_PID);
    const call = vi.fn(async (method: string) => {
      if (method === "broker.shutdown") await rm(paths.descriptor, { force: true });
      return {};
    });
    connectExistingBrokerMock.mockResolvedValue({ call, close: vi.fn() });
    const logs: string[] = [];
    try {
      const result = await restartBrokerIfStale({
        paths,
        brokerEntry: path.join(base, "does-not-exist", "process.js"),
        log: (line) => logs.push(line),
        expected: { packageVersion: "0.2.0" },
        releaseWait: {
          timeoutMs: 2_000,
          pollMs: 5,
          browserTreeTimeoutMs: 2_000,
          browserTreePollMs: 5,
          exec: async () => ({ stdout: "" })
        }
      });
      expect(result).toBe(true);
      expect(logs.some((line) => /^broker: browser tree for profile gone after \d+ms$/.test(line))).toBe(
        true
      );
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  it("force-kills and logs a count when a browser process naming the profile outlives the bound", async () => {
    // ISSUE-2026-09-14-13: deliberately NOT pinned. `paths.profile` (below) is this real host's own
    // native temp path -- pinning `process.platform` to a POSIX value here, on a real Windows host,
    // would make `normalizeProfilePathForMatch` resolve that native Windows path with `path.posix`
    // instead, which does not round-trip it (see this module's own doc comment and the task log this
    // fix belongs to). `fakeProcessListing` below formats for whichever platform is actually live,
    // so this test passes on either host without that mismatch; the dedicated Windows-format
    // counterpart right after this one pins "win32" deliberately, and is unaffected because it never
    // pins away from the real platform on a real Windows host.
    const { base, paths } = await makeStaleness("0.1.0", DEAD_PID);
    const call = vi.fn(async (method: string) => {
      if (method === "broker.shutdown") await rm(paths.descriptor, { force: true });
      return {};
    });
    connectExistingBrokerMock.mockResolvedValue({ call, close: vi.fn() });
    const stuckPid = 314_159;
    const logs: string[] = [];
    try {
      const result = await restartBrokerIfStale({
        paths,
        brokerEntry: path.join(base, "does-not-exist", "process.js"),
        log: (line) => logs.push(line),
        expected: { packageVersion: "0.2.0" },
        releaseWait: {
          timeoutMs: 2_000,
          pollMs: 5,
          browserTreeTimeoutMs: 20,
          browserTreePollMs: 5,
          exec: fakeProcessListing([
            { pid: stuckPid, ppid: 1, command: `/usr/bin/fake-msedge --user-data-dir=${paths.profile}` }
          ])
        }
      });
      expect(result).toBe(true);
      expect(killProcessTreeMock).toHaveBeenCalledWith(stuckPid);
      expect(logs).toContain("broker: force-killed 1 browser processes of the profile");
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  // Windows-format counterpart (ISSUE-2026-09-14-13): the same scenario through the CIM JSON
  // `exec` shape src/broker/profile-processes.ts's win32 branch actually parses, so this phase's
  // Windows path is covered by this suite too, not only the POSIX `ps`-line fixture above.
  it("force-kills and logs a count when a browser process naming the profile outlives the bound, on Windows (CIM JSON fixture)", async () => {
    // Pinned only around the call below, not this whole test: `makeStaleness()` -> `saveGlobalConfig`
    // itself reads `process.platform` (src/config/storage.ts's `ensurePrivateDirectories`) to decide
    // between a real `chmod` and a real PowerShell ACL step -- pinning "win32" for that setup too
    // would make it actually shell out to PowerShell, which this (non-Windows) suite host does not
    // have.
    const { base, paths } = await makeStaleness("0.1.0", DEAD_PID);
    const call = vi.fn(async (method: string) => {
      if (method === "broker.shutdown") await rm(paths.descriptor, { force: true });
      return {};
    });
    connectExistingBrokerMock.mockResolvedValue({ call, close: vi.fn() });
    const stuckPid = 314_159;
    const logs: string[] = [];
    try {
      pinPlatform("win32");
      const result = await restartBrokerIfStale({
        paths,
        brokerEntry: path.join(base, "does-not-exist", "process.js"),
        log: (line) => logs.push(line),
        expected: { packageVersion: "0.2.0" },
        releaseWait: {
          timeoutMs: 2_000,
          pollMs: 5,
          browserTreeTimeoutMs: 20,
          browserTreePollMs: 5,
          exec: async () => ({
            stdout: JSON.stringify([
              {
                ProcessId: stuckPid,
                ParentProcessId: 1,
                CommandLine: `msedge.exe --user-data-dir=${paths.profile}`
              }
            ])
          })
        }
      });
      expect(result).toBe(true);
      expect(killProcessTreeMock).toHaveBeenCalledWith(stuckPid);
      expect(logs).toContain("broker: force-killed 1 browser processes of the profile");
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });

  it("never runs the browser-tree phase while the old broker's own pid is still alive (the give-up branch)", async () => {
    // process.pid never looks "gone" to isBrokerPidAlive -- the give-up branch this exercises.
    const { base, paths } = await makeStaleness("0.1.0");
    const call = vi.fn().mockResolvedValue({});
    connectExistingBrokerMock.mockResolvedValue({ call, close: vi.fn() });
    let execCalls = 0;
    const logs: string[] = [];
    try {
      const result = await restartBrokerIfStale({
        paths,
        brokerEntry: path.join(base, "does-not-exist", "process.js"),
        log: (line) => logs.push(line),
        expected: { packageVersion: "0.2.0" },
        releaseWait: {
          timeoutMs: 30,
          pollMs: 5,
          exec: async () => {
            execCalls++;
            return { stdout: "" };
          }
        }
      });
      expect(result).toBe(true);
      expect(logs.some((line) => line.includes("gave up"))).toBe(true);
      expect(logs.some((line) => line.includes("browser tree"))).toBe(false);
      expect(execCalls).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
      connectExistingBrokerMock.mockReset();
    }
  });
});
