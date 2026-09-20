import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROKER_LOG_FILE,
  brokerLogPath,
  createBrokerLogger,
  readBrokerLogTail,
  redactBrokerLogLine
} from "../../src/observability/broker-log.js";

async function tempLogsDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "apl-broker-log-"));
}

describe("broker-log", () => {
  it("writes an ISO-timestamped line to <logsDir>/broker.log with a current-user-only file mode", async () => {
    const dir = await tempLogsDir();
    const logger = createBrokerLogger(dir);
    logger.log("browser: 0 browser process(es) already present for this profile at launch start");
    // log() is fire-and-forget; give its internal write chain a turn to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const file = path.join(dir, BROKER_LOG_FILE);
    expect(file).toBe(brokerLogPath(dir));
    const content = await readFile(file, "utf8");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z browser: 0 browser process\(es\)/);
    if (process.platform !== "win32") {
      const info = await stat(file);
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it("appends multiple lines in order", async () => {
    const dir = await tempLogsDir();
    const logger = createBrokerLogger(dir);
    logger.log("broker: started pid=1");
    logger.log("broker: stopping");
    logger.log("broker: stopped");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const content = await readFile(path.join(dir, BROKER_LOG_FILE), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("broker: started pid=1");
    expect(lines[1]).toContain("broker: stopping");
    expect(lines[2]).toContain("broker: stopped");
  });

  it("rotates to broker.log.1 once the live file reaches the configured size cap", async () => {
    const dir = await tempLogsDir();
    // A tiny cap makes the very first line already exceed it, so the second log() call rotates
    // the first line out to broker.log.1 before writing its own.
    const logger = createBrokerLogger(dir, { maxBytes: 10 });
    logger.log("first line long enough to exceed the cap");
    await new Promise((resolve) => setTimeout(resolve, 20));
    logger.log("second line");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rotated = await readFile(path.join(dir, `${BROKER_LOG_FILE}.1`), "utf8");
    expect(rotated).toContain("first line long enough to exceed the cap");
    const live = await readFile(path.join(dir, BROKER_LOG_FILE), "utf8");
    expect(live).toContain("second line");
    expect(live).not.toContain("first line");
  });

  it("redacts URL- and query-string-shaped text before it is ever written", () => {
    expect(redactBrokerLogLine("navigated to https://tenant.example.com/chat?foo=bar")).toBe(
      "navigated to [redacted-url]"
    );
    expect(redactBrokerLogLine("path only ?token=abcd1234 no scheme")).toBe(
      "path only ?[redacted] no scheme"
    );
    // A bare filesystem path is left alone -- profile/executable paths are already routinely
    // logged elsewhere in this codebase.
    expect(redactBrokerLogLine("profile at /home/user/.local/share/M365AgentWorkspace")).toBe(
      "profile at /home/user/.local/share/M365AgentWorkspace"
    );
  });

  it("applies redaction at the sink, even when the caller forgot to redact", async () => {
    const dir = await tempLogsDir();
    const logger = createBrokerLogger(dir);
    logger.log(
      "browser: launch failure call log (1 line(s), redacted): https://tenant.example/should-not-leak"
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const content = await readFile(path.join(dir, BROKER_LOG_FILE), "utf8");
    expect(content).not.toContain("tenant.example");
    expect(content).toContain("[redacted-url]");
  });

  it("readBrokerLogTail returns the last N lines, most recent last", async () => {
    const dir = await tempLogsDir();
    const logger = createBrokerLogger(dir);
    for (let i = 0; i < 5; i++) logger.log(`line ${i}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const tail = await readBrokerLogTail(dir, 3);
    expect(tail).toHaveLength(3);
    expect(tail[0]).toContain("line 2");
    expect(tail[1]).toContain("line 3");
    expect(tail[2]).toContain("line 4");
  });

  it("readBrokerLogTail returns an empty array when the file does not exist yet", async () => {
    const dir = await tempLogsDir();
    await expect(readBrokerLogTail(dir)).resolves.toEqual([]);
  });
});
