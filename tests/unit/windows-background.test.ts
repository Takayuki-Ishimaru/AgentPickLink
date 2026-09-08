import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(execFileMock, {
    [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        execFileMock(...args, (error: unknown, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      })
  })
}));
import { hideBrowserWindows } from "../../src/transports/browser/windows-background.js";

describe("Windows background window control", () => {
  afterEach(() => {
    execFileMock.mockReset();
  });

  it("targets only the validated browser PID with a bounded hidden PowerShell process", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, "APL_WINDOWS_HIDDEN", "");
    });
    await hideBrowserWindows(12345);
    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(options).toMatchObject({ windowsHide: true, timeout: 15_000 });
    expect(args[3]).toContain("owner == processId");
    expect(args[3]).toContain("::Hide([uint32]12345)");
    expect(args[3]).not.toMatch(/GetWindowText|Bypass|Get-Process/);
  });

  it.each([NaN, -1, 0, 1.1, 0x100000000])("rejects invalid process IDs (%s)", async (pid) => {
    await expect(hideBrowserWindows(pid)).rejects.toMatchObject({ code: "BROWSER_START_FAILED" });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not expose native errors or claim success when hiding is blocked", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(
        Object.assign(new Error("private machine details"), {
          stdout: "APL_HIDE_FAILED",
          stderr: "private path"
        })
      );
    });
    await expect(hideBrowserWindows(12345)).rejects.toMatchObject({
      code: "BROWSER_START_FAILED",
      message: expect.not.stringContaining("private")
    });
  });

  it.skipIf(!process.env.M365_AGENT_TEST_POWERSHELL)(
    "compiles the native helper using real PowerShell",
    async () => {
      execFileMock.mockImplementation((_file, _args, _options, callback) => {
        callback(null, "APL_WINDOWS_HIDDEN", "");
      });
      await hideBrowserWindows(12345);
      const script = String(execFileMock.mock.calls[0][1][3]).replace(
        "if (![AplWindowVisibility]::Hide([uint32]12345)) { throw 'APL_HIDE_FAILED' }",
        "# Compile only: no Windows API is invoked on this host."
      );
      const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const result = await promisify(execFile)(
        process.env.M365_AGENT_TEST_POWERSHELL!,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 15_000 }
      );
      expect(result.stdout).toContain("APL_WINDOWS_HIDDEN");
    },
    20_000
  );
});
