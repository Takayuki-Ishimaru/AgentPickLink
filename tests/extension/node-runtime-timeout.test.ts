import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: string[],
      options: unknown,
      callback?: (error: NodeJS.ErrnoException | null, result?: { stdout: string }) => void
    ) => {
      const done = typeof options === "function" ? options : callback;
      done?.(null, { stdout: "v22.14.0\n" });
      return {};
    }
  )
);

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { defaultNodeProbe } from "../../src/extension/node-runtime.js";

describe("default Node runtime probe", () => {
  it("uses a five-second bound for node --version", async () => {
    const probe = defaultNodeProbe();
    await expect(probe.run("node", ["--version"])).resolves.toBe("v22.14.0\n");
    expect(execFileMock).toHaveBeenCalledWith(
      "node",
      ["--version"],
      expect.objectContaining({ windowsHide: true, timeout: 5_000 }),
      expect.any(Function)
    );
  });
});
