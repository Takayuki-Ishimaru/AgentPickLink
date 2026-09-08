import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: string[],
      options: unknown,
      callback?: (error: NodeJS.ErrnoException | null) => void
    ) => {
      const done = typeof options === "function" ? options : callback;
      done?.(null);
      return {};
    }
  )
);

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { assertSafeProfilePath } from "../../src/config/profile-safety.js";

describe("Windows profile safety timeout", () => {
  it("bounds local-drive PowerShell validation and reports timeout distinctly", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-profile-timeout-"));
    execFileMock.mockImplementationOnce((_file, _args, options, callback) => {
      const done = typeof options === "function" ? options : callback;
      const error = Object.assign(new Error("timed out"), { killed: true, code: "ETIMEDOUT" });
      done?.(error);
      return {};
    });
    try {
      await expect(assertSafeProfilePath(path.join(base, "browser-profile"))).rejects.toMatchObject({
        code: "BROWSER_PROFILE_INVALID",
        message: expect.stringContaining("validation timed out")
      });
      expect((execFileMock.mock.calls[0]![2] as { timeout?: number }).timeout).toBe(30_000);
    } finally {
      platform.mockRestore();
    }
  });
});
