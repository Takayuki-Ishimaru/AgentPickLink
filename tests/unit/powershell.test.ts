import { afterEach, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
import { executePowerShell } from "../../src/config/powershell.js";

afterEach(() => execFileMock.mockReset());

it("closes unused stdin so a noninteractive subprocess can complete", async () => {
  const end = vi.fn();
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    end.mockImplementation(() => callback(null, "complete", ""));
    return { stdin: { end } };
  });
  await expect(executePowerShell("Write-Output complete", 30_000)).resolves.toEqual({
    stdout: "complete",
    stderr: ""
  });
  expect(end).toHaveBeenCalledOnce();
  expect(execFileMock).toHaveBeenCalledWith(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Write-Output complete"],
    { windowsHide: true, timeout: 30_000, encoding: "utf8" },
    expect.any(Function)
  );
});

it("preserves exit errors and both diagnostic streams", async () => {
  const error = Object.assign(new Error("failed"), { code: 1, killed: false });
  execFileMock.mockImplementation((_file, _args, _options, callback) => ({
    stdin: { end: () => callback(error, "stage marker", "native diagnostic") }
  }));
  await expect(executePowerShell("exit 1", 30_000)).rejects.toMatchObject({
    code: 1,
    killed: false,
    stdout: "stage marker",
    stderr: "native diagnostic"
  });
});
