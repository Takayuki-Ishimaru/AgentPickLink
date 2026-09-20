import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerLogger, brokerLogPath } from "../../src/observability/broker-log.js";
import { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import type { BrowserContextLike } from "../../src/transports/browser/types.js";

/**
 * Item 1: before this wiring existed, `BrowserManager.log()`/`onLog` reached no file in
 * production -- both broker spawn sites use `stdio: "ignore"`, and nothing ever passed an `onLog`
 * into `BrowserManager`. This exercises the fix's actual sink (a real `createBrokerLogger` writing
 * to a temp `paths.logs`) against `BrowserManager`'s own diagnostic lines, the same lines
 * `src/broker/process.ts`'s composition root now wires end to end.
 */
describe("broker log receives BrowserManager diagnostics", () => {
  it("writes BrowserManager's pre-launch staleness line to <paths.logs>/broker.log", async () => {
    const logsDir = await mkdtemp(path.join(os.tmpdir(), "apl-broker-log-logs-"));
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-broker-log-profile-"));
    const logger = createBrokerLogger(logsDir);
    const context: BrowserContextLike = {
      pages: () => [],
      newPage: async () => ({ url: () => "about:blank", close: async () => undefined }),
      close: async () => undefined,
      on: () => undefined
    };
    const manager = new BrowserManager({
      profilePath,
      onLog: (line) => logger.log(line),
      // ISSUE-2026-09-14-13: without this, launchContext()'s pre-launch process-listing snapshot
      // shells out for real (real PowerShell on Windows) instead of staying hermetic.
      processExec: async () => ({ stdout: "" }),
      launcher: {
        launchPersistentContext: async () => context
      }
    });

    await manager.start();
    expect(manager.isRunning()).toBe(true);
    // log() is fire-and-forget; give its internal write chain a turn to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = await readFile(brokerLogPath(logsDir), "utf8");
    expect(content).toContain(
      "browser: 0 browser process(es) already present for this profile at launch start"
    );
    // ISO-timestamped, one entry per line -- see createBrokerLogger's own doc comment.
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z browser:/m);

    await manager.close();
  });

  it("also captures a launch failure's redacted call-log lines", async () => {
    const logsDir = await mkdtemp(path.join(os.tmpdir(), "apl-broker-log-fail-logs-"));
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-broker-log-fail-profile-"));
    const logger = createBrokerLogger(logsDir);
    const manager = new BrowserManager({
      profilePath,
      onLog: (line) => logger.log(line),
      startupTimeoutMs: 2_000,
      // ISSUE-2026-09-14-13: see the previous test -- keeps the pre-launch snapshot hermetic.
      processExec: async () => ({ stdout: "" }),
      launcher: {
        launchPersistentContext: async () => {
          throw new Error(
            "browserType.launchPersistentContext: Timeout 2000ms exceeded.\n" +
              "Call log:\n" +
              '  - <launching> "https://tenant.example.com/should-be-redacted?token=abc123"\n' +
              "  - <launched> pid=4242"
          );
        }
      }
    });

    await expect(manager.start()).rejects.toMatchObject({ code: "BROWSER_START_FAILED" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = await readFile(brokerLogPath(logsDir), "utf8");
    expect(content).toContain("browser: launch failure call log");
    expect(content).toContain("<launched> pid=4242");
    // Belt-and-braces redaction at the sink (docs/security.md "Data handling"): even though the
    // call log is already redacted before it reaches log(), nothing URL-shaped ever survives.
    expect(content).not.toContain("tenant.example.com");
    expect(content).not.toContain("token=abc123");
  });
});
