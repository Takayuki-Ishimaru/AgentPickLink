import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { mcpHandshake } from "../../src/services/mcp-handshake.js";

const execFileAsync = promisify(execFile);

type FakeServerBehavior =
  | "ok"
  | "noisy"
  | "silent"
  | "exit-early"
  | "pid-file"
  | "crlf"
  | "split"
  | "exit-after-initialize"
  | "ignore-sigterm"
  | "flood-stdout"
  | "flood-stderr";

/** A tiny, dependency-free fake MCP server: NDJSON JSON-RPC over stdio, matching the framing
 * `@modelcontextprotocol/server`'s stdio transport uses (see mcp-handshake.ts's header comment).
 * `behavior` selects a canned response shape for the test that needs it. */
function fakeServerScript(behavior: FakeServerBehavior, extra = ""): string {
  if (behavior === "exit-early") return "process.exit(1);\n";
  if (behavior === "silent") return "setInterval(() => {}, 1000);\n";
  // Never emits a newline: exercises mcp-handshake.ts's line-buffer/stderr size caps directly.
  if (behavior === "flood-stdout") return 'setInterval(() => process.stdout.write("x".repeat(65536)), 5);\n';
  if (behavior === "flood-stderr")
    return 'setInterval(() => process.stderr.write("x".repeat(65536) + "\\n"), 5);\n';

  const preamble = behavior === "noisy" ? 'process.stdout.write("not json at all\\n");\n' : "";
  const pidWrite =
    behavior === "pid-file" || behavior === "ignore-sigterm"
      ? `require("node:fs").writeFileSync(${JSON.stringify(extra)}, String(process.pid));\n`
      : "";
  const ignoreSigterm = behavior === "ignore-sigterm" ? 'process.on("SIGTERM", () => {});\n' : "";
  const lineEnding = behavior === "crlf" ? "\\r\\n" : "\\n";
  // Exits right after answering `initialize`, before `tools/list` ever arrives.
  const exitAfterInitialize = behavior === "exit-after-initialize" ? "      process.exit(0);" : "";
  const writeFn =
    behavior === "split"
      ? [
          "function write(message) {",
          "  const text = JSON.stringify(message);",
          "  const mid = Math.floor(text.length / 2);",
          "  process.stdout.write(text.slice(0, mid));",
          '  setTimeout(() => process.stdout.write(text.slice(mid) + "\\n"), 20);',
          "}"
        ].join("\n")
      : [
          "function write(message) {",
          preamble,
          `  process.stdout.write(JSON.stringify(message) + "${lineEnding}");`,
          "}"
        ].join("\n");
  return [
    pidWrite,
    ignoreSigterm,
    'process.stdin.setEncoding("utf8");',
    'let buffer = "";',
    writeFn,
    'process.stdin.on("data", (chunk) => {',
    "  buffer += chunk;",
    "  let index;",
    '  while ((index = buffer.indexOf("\\n")) !== -1) {',
    "    const line = buffer.slice(0, index);",
    "    buffer = buffer.slice(index + 1);",
    "    if (!line.trim()) continue;",
    "    const message = JSON.parse(line);",
    '    if (message.method === "initialize") {',
    "      write({",
    '        jsonrpc: "2.0",',
    "        id: message.id,",
    "        result: {",
    '          protocolVersion: "2025-06-18",',
    "          capabilities: {},",
    '          serverInfo: { name: "fake-mcp-server", version: "9.9.9" },',
    '          instructions: "fake instructions"',
    "        }",
    "      });",
    exitAfterInitialize,
    '    } else if (message.method === "tools/list") {',
    "      write({",
    '        jsonrpc: "2.0",',
    "        id: message.id,",
    '        result: { tools: [{ name: "fake_tool_a" }, { name: "fake_tool_b" }] }',
    "      });",
    "    }",
    "  }",
    "});"
  ].join("\n");
}

async function withScript(
  behavior: Parameters<typeof fakeServerScript>[0],
  fn: (scriptPath: string, dir: string) => Promise<void>,
  extra = ""
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "apl-mcp-handshake-"));
  try {
    const scriptPath = path.join(dir, "fake-server.js");
    await writeFile(scriptPath, fakeServerScript(behavior, extra), "utf8");
    await fn(scriptPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("mcpHandshake", () => {
  it("performs initialize -> notifications/initialized -> tools/list against a fake server", async () => {
    await withScript("ok", async (scriptPath) => {
      const result = await mcpHandshake({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 });
      expect(result).toEqual({
        serverName: "fake-mcp-server",
        serverVersion: "9.9.9",
        tools: ["fake_tool_a", "fake_tool_b"],
        instructionsPresent: true,
        stderr: ""
      });
    });
  });

  it("ignores stdout lines that are not parsable JSON-RPC", async () => {
    await withScript("noisy", async (scriptPath) => {
      const result = await mcpHandshake({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 });
      expect(result.serverName).toBe("fake-mcp-server");
      expect(result.tools).toEqual(["fake_tool_a", "fake_tool_b"]);
    });
  });

  it("rejects when the server never responds within timeoutMs", async () => {
    await withScript("silent", async (scriptPath) => {
      await expect(
        mcpHandshake({ command: process.execPath, args: [scriptPath], timeoutMs: 200 })
      ).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });
    });
  });

  it("rejects when the server exits before completing the handshake", async () => {
    await withScript("exit-early", async (scriptPath) => {
      await expect(
        mcpHandshake({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 })
      ).rejects.toMatchObject({ code: "BROKER_START_FAILED" });
    });
  });

  it("rejects when the command itself cannot be spawned", async () => {
    await expect(
      mcpHandshake({
        command: path.join(os.tmpdir(), "apl-definitely-not-a-real-binary"),
        args: [],
        timeoutMs: 5_000
      })
    ).rejects.toMatchObject({ code: "BROKER_START_FAILED" });
  });

  it("kills the child once the handshake completes", async () => {
    const pidFile = path.join(os.tmpdir(), `apl-mcp-handshake-pid-${process.pid}-${Date.now()}.txt`);
    try {
      await withScript(
        "pid-file",
        async (scriptPath) => {
          await mcpHandshake({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 });
        },
        pidFile
      );
      const pidText = await import("node:fs/promises").then((fsp) => fsp.readFile(pidFile, "utf8"));
      const pid = Number(pidText.trim());
      expect(Number.isInteger(pid)).toBe(true);
      // Give the OS a moment to finish reaping the killed child, then confirm it is gone.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(pidFile, { force: true });
    }
  });

  it("parses a response that uses \\r\\n line endings", async () => {
    await withScript("crlf", async (scriptPath) => {
      const result = await mcpHandshake({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 });
      expect(result.serverName).toBe("fake-mcp-server");
      expect(result.tools).toEqual(["fake_tool_a", "fake_tool_b"]);
    });
  });

  it("reassembles a JSON-RPC message split across two stdout chunks", async () => {
    await withScript("split", async (scriptPath) => {
      const result = await mcpHandshake({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 });
      expect(result.serverName).toBe("fake-mcp-server");
      expect(result.tools).toEqual(["fake_tool_a", "fake_tool_b"]);
    });
  });

  it("rejects with the exited-early DomainError (not an uncaught EPIPE) when the server exits between initialize and tools/list", async () => {
    await withScript("exit-after-initialize", async (scriptPath) => {
      await expect(
        mcpHandshake({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 })
      ).rejects.toMatchObject({ code: "BROKER_START_FAILED" });
    });
  });

  it("fails with a framing error when the server floods stdout without a newline", async () => {
    await withScript("flood-stdout", async (scriptPath) => {
      await expect(
        mcpHandshake({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 })
      ).rejects.toMatchObject({ code: "BROKER_PROTOCOL_ERROR" });
    });
  });

  it("fails with a framing error when the server floods stderr", async () => {
    await withScript("flood-stderr", async (scriptPath) => {
      await expect(
        mcpHandshake({ command: process.execPath, args: [scriptPath], timeoutMs: 5_000 })
      ).rejects.toMatchObject({ code: "BROKER_PROTOCOL_ERROR" });
    });
  });

  // Windows has no real POSIX signal delivery: `child.kill("SIGTERM")` there unconditionally calls
  // TerminateProcess (a hard, immediate kill) regardless of any `process.on("SIGTERM", ...)`
  // handler registered in the child, so the fake server's "ignore-sigterm" behavior cannot survive
  // the first kill() call to exercise the SIGKILL escalation path at all -- the child is simply
  // gone immediately, and the "still alive right after the handshake" assertion below would fail
  // for a reason that has nothing to do with a real product bug.
  it.skipIf(process.platform === "win32")(
    "escalates from SIGTERM to SIGKILL within ~3s when the server ignores SIGTERM",
    async () => {
      const pidFile = path.join(
        os.tmpdir(),
        `apl-mcp-handshake-sigterm-pid-${process.pid}-${Date.now()}.txt`
      );
      try {
        await withScript(
          "ignore-sigterm",
          async (scriptPath) => {
            const result = await mcpHandshake({
              command: process.execPath,
              args: [scriptPath],
              timeoutMs: 5_000
            });
            expect(result.serverName).toBe("fake-mcp-server");
          },
          pidFile
        );
        const pidText = await import("node:fs/promises").then((fsp) => fsp.readFile(pidFile, "utf8"));
        const pid = Number(pidText.trim());
        expect(Number.isInteger(pid)).toBe(true);
        // Still alive immediately after the handshake: it ignores SIGTERM.
        expect(() => process.kill(pid, 0)).not.toThrow();
        // Gone once the ~2s grace period elapses and SIGKILL lands.
        await new Promise((resolve) => setTimeout(resolve, 2_800));
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await rm(pidFile, { force: true });
      }
    },
    8_000
  );
});

const distEntry = path.resolve(process.cwd(), "dist/cli/index.js");

describe.skipIf(!existsSync(distEntry))("mcpHandshake against the real serve command", () => {
  it("reports the three m365_agent_* tools from a real broker-less serve", async () => {
    const appData = await mkdtemp(path.join(os.tmpdir(), "apl-mcp-handshake-appdata-"));
    try {
      const result = await mcpHandshake({
        command: process.execPath,
        args: [distEntry, "serve"],
        cwd: appData,
        env: { ...process.env, M365_AGENT_APP_DATA: appData },
        timeoutMs: 15_000
      });
      expect(result.serverName).toBe("agent-pick-link");
      expect(result.tools.sort()).toEqual(["m365_agent_ask", "m365_agent_list", "m365_agent_session"]);

      const { stdout } = await execFileAsync("pgrep", ["-fl", "dist/broker/process.js"]).catch(() => ({
        stdout: ""
      }));
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(appData, { recursive: true, force: true });
    }
  });
});
