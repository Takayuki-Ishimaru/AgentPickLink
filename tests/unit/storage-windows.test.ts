import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: string[],
      options: unknown,
      callback?: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
    ) => {
      const done = typeof options === "function" ? options : callback;
      done?.(null, "", "");
      return {};
    }
  )
);

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { ensurePrivateDirectories, ensurePrivateFiles } from "../../src/config/storage.js";

describe("Windows private storage batching", () => {
  afterEach(() => {
    execFileMock.mockClear();
  });

  it("applies one bounded ACL script to all initial directories", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-storage-windows-"));
    const directories = [path.join(base, "root"), path.join(base, "broker"), path.join(base, "logs")];
    try {
      await ensurePrivateDirectories([...directories, directories[1]!]);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [command, args, options] = execFileMock.mock.calls[0]!;
      expect(command).toBe("powershell.exe");
      expect(args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]));
      expect((options as { timeout?: number }).timeout).toBe(30_000);
      const script = String((args as string[])[3]);
      for (const directory of directories) expect(script).toContain(directory);
      expect(script).toContain("SetAccessRuleProtection");
      expect(script).toContain("GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])");
      expect(script).toContain("New-Object -TypeName Security.AccessControl.FileSystemAccessRule");
      expect(script).not.toContain(".Translate(");
      expect(script).toContain("Get-Acl");
      expect(script).toContain(
        "[IO.Directory]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access)"
      );
      expect(script).toContain("[IO.Directory]::SetAccessControl($p,$acl)");
      expect(script).not.toContain("Set-Acl");
    } finally {
      platform.mockRestore();
    }
  });

  it("protects existing files as one ACL batch without rewriting their bytes", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-storage-files-"));
    const files = [path.join(base, "config.yaml"), path.join(base, "registry.yaml")];
    const contents = ["config-bytes\n", "registry-bytes\n"];
    try {
      await Promise.all(files.map((file, index) => writeFile(file, contents[index], "utf8")));
      await ensurePrivateFiles(files);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [, args, options] = execFileMock.mock.calls[0]!;
      expect((options as { timeout?: number }).timeout).toBe(30_000);
      const script = String((args as string[])[3]);
      for (const file of files) expect(script).toContain(file);
      expect(script).toContain(
        "[IO.File]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access)"
      );
      expect(script).toContain("[IO.File]::SetAccessControl($p,$acl)");
      expect(script).not.toContain("Set-Acl");
    } finally {
      platform.mockRestore();
    }
  });

  it("reports a bounded PowerShell timeout distinctly", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-storage-timeout-"));
    execFileMock.mockImplementationOnce((_file, _args, options, callback) => {
      const done = typeof options === "function" ? options : callback;
      const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      done?.(error, "", "stderr" in error ? String(error.stderr) : "");
      return {};
    });
    try {
      await expect(ensurePrivateDirectories([path.join(base, "root")])).rejects.toMatchObject({
        code: "POLICY_BLOCKED",
        message: expect.stringContaining("timed out after 30 seconds")
      });
      expect((execFileMock.mock.calls[0]![2] as { timeout?: number }).timeout).toBe(30_000);
    } finally {
      platform.mockRestore();
    }
  });

  it("reports a safe ACL stage/category without exposing native stderr or sensitive paths", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-storage-diagnostic-"));
    const secretPath = path.join(base, "private", "config.yaml");
    execFileMock.mockImplementationOnce((_file, _args, options, callback) => {
      const done = typeof options === "function" ? options : callback;
      const error = Object.assign(new Error("native ACL detail"), {
        code: 1,
        stderr: `APL_ACL_STAGE=write-acl;CATEGORY=access-denied\n${secretPath}`
      });
      done?.(error, "", "stderr" in error ? String(error.stderr) : "");
      return {};
    });
    try {
      const error = await ensurePrivateDirectories([secretPath]).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "POLICY_BLOCKED",
        message: expect.stringContaining("stage=write-acl; category=access-denied")
      });
      expect((error as Error).message).not.toContain(secretPath);
      expect((error as Error).message).not.toContain("native ACL detail");
      expect((error as { options?: { remediation?: string } }).options?.remediation).toContain(
        "ensure PowerShell can read and write DACLs"
      );
    } finally {
      platform.mockRestore();
    }
  });

  it.each([
    [
      "APL_ACL_STAGE=write-acl;CATEGORY=access-denied;HRESULT=-2147024891",
      "stage=write-acl; category=access-denied; hresult=-2147024891"
    ],
    [
      "APL_ACL_STAGE=identity;CATEGORY=language-restricted;HRESULT=-2146233087",
      "stage=identity; category=language-restricted"
    ],
    ["APL_ACL_STAGE=private_user;CATEGORY=private_host", "stage=process; category=exit-1"]
  ])("reads only approved stdout diagnostic fields (%s)", async (stdout, expected) => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const base = await mkdtemp(path.join(os.tmpdir(), "apl-storage-stdout-"));
    execFileMock.mockImplementationOnce((_file, _args, options, callback) => {
      const done = typeof options === "function" ? options : callback;
      done?.(Object.assign(new Error("private native message"), { code: 1 }), stdout, "");
      return {};
    });
    try {
      const error = await ensurePrivateDirectories([path.join(base, "root")]).catch(
        (caught: unknown) => caught
      );
      expect(error).toMatchObject({ code: "POLICY_BLOCKED", message: expect.stringContaining(expected) });
      expect((error as Error).message).not.toMatch(/private_user|private_host|private native message/);
    } finally {
      platform.mockRestore();
    }
  });

  it.skipIf(!process.env.M365_AGENT_TEST_POWERSHELL)(
    "parses the emitted scripts and preserves diagnostics in real constrained PowerShell",
    async () => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const base = await mkdtemp(path.join(os.tmpdir(), "apl-storage-parser-"));
      try {
        await ensurePrivateDirectories([path.join(base, "日本語's [profile]")]);
      } finally {
        platform.mockRestore();
      }
      const script = String(execFileMock.mock.calls[0]![1][3]);
      const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const run = promisify(execFile);
      // The injected failure happens before identity lookup or any ACL access. This exercises
      // PowerShell's parser and the actual catch block without modifying a Windows permission.
      const checkScript = script.replace("try{$sid=", "try{throw 'APL_ACL_CHECK_NO_CURRENT';$sid=");
      const checked = await run(process.env.M365_AGENT_TEST_POWERSHELL!, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        checkScript
      ]).catch((error: unknown) => error);
      expect(checked).toMatchObject({
        stdout: expect.stringContaining("APL_ACL_STAGE=identity;CATEGORY=APL_ACL_CHECK_NO_CURRENT")
      });
      // ConstrainedLanguage deliberately blocks WindowsIdentity.GetCurrent, even on Windows.
      // The reporting path must still work instead of throwing again while printing its error.
      const restricted = await run(process.env.M365_AGENT_TEST_POWERSHELL!, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';" + script
      ]).catch((error: unknown) => error);
      expect(restricted).toMatchObject({
        stdout: expect.stringContaining("APL_ACL_STAGE=identity;CATEGORY=language-restricted")
      });
    },
    30_000
  );
});
