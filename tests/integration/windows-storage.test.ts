import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  atomicWrite,
  ensurePrivateDirectories,
  ensurePrivateFiles,
  verifyPrivatePath
} from "../../src/config/storage.js";

const execFileAsync = promisify(execFile);

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function assertCurrentUserOnlyAcl(paths: string[]): Promise<void> {
  const entries = paths.map(powershellLiteral).join(",");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$paths=@(${entries})`,
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    'foreach($p in $paths){$acl=Get-Acl -LiteralPath $p;if(!$acl.AreAccessRulesProtected){throw "APL_TEST_UNPROTECTED:$p"};$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq \'Allow\'});if($rules.Count -eq 0){throw "APL_TEST_NO_ALLOW:$p"};foreach($rule in $rules){if($rule.IdentityReference.Value -ne $sid.Value){throw "APL_TEST_FOREIGN_ALLOW:$p"};if(([int]$rule.FileSystemRights -band [int][Security.AccessControl.FileSystemRights]::FullControl) -ne [int][Security.AccessControl.FileSystemRights]::FullControl){throw "APL_TEST_NOT_FULL_CONTROL:$p"}}}',
    "Write-Output 'APL_TEST_ACL_OK'"
  ].join(";");
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: 30_000
    }
  );
  expect(result.stdout).toContain("APL_TEST_ACL_OK");
}

/** This test intentionally uses the real Windows PowerShell process, never a mocked child process. */
it.skipIf(process.platform !== "win32")(
  "protects real Windows storage through initialization, writes, repeats, and parallel work",
  async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "apl-windows-storage-integration-"));
    const root = path.join(scratch, "private");
    const nested = path.join(root, "nested");
    const parallelA = path.join(root, "parallel-a");
    const parallelB = path.join(root, "parallel-b");
    const file = path.join(nested, "state.unknown");
    const payload = "preserve these bytes\n";

    try {
      await ensurePrivateDirectories([root, nested]);
      await Promise.all([ensurePrivateDirectories([parallelA]), ensurePrivateDirectories([parallelB])]);
      await atomicWrite(file, payload);
      await ensurePrivateFiles([file]);

      await verifyPrivatePath(root, true);
      await verifyPrivatePath(nested, true);
      await verifyPrivatePath(file);
      await assertCurrentUserOnlyAcl([root, nested, parallelA, parallelB, file]);

      // Initialization is idempotent and must not rewrite or truncate existing state.
      await Promise.all([
        ensurePrivateDirectories([root, nested, parallelA, parallelB]),
        ensurePrivateFiles([file])
      ]);
      expect(await readFile(file, "utf8")).toBe(payload);
      await verifyPrivatePath(file);
      await assertCurrentUserOnlyAcl([root, nested, parallelA, parallelB, file]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  180_000
);

it.skipIf(process.platform !== "win32")(
  "protects directories and files when WRITE_OWNER is denied, preserving owner and group",
  async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "apl-windows-dacl-only-"));
    const directory = path.join(scratch, "日本語's [private]");
    const file = path.join(directory, "state.yaml");
    const targets = [directory, file];
    const entries = targets.map(powershellLiteral).join(",");
    const run = (script: string) =>
      execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        timeout: 30_000
      });
    const ownersScript = [
      "$ErrorActionPreference='Stop'",
      `$paths=@(${entries})`,
      "foreach($p in $paths){$acl=Get-Acl -LiteralPath $p;$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group)}"
    ].join(";");
    try {
      await mkdir(directory);
      await writeFile(file, "preserve these bytes\n");
      const before = await run(ownersScript);
      // The process may edit the DACL, but must not request WRITE_OWNER. Run this regression
      // under a normal, unelevated Windows user; no privileged account or policy change needed.
      await run(
        [
          "$ErrorActionPreference='Stop'",
          `$paths=@(${entries})`,
          "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
          "foreach($p in $paths){$item=Get-Item -LiteralPath $p;$acl=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access);$rule=New-Object -TypeName Security.AccessControl.FileSystemAccessRule -ArgumentList @($sid,[Security.AccessControl.FileSystemRights]::TakeOwnership,[Security.AccessControl.AccessControlType]::Deny);[void]$acl.AddAccessRule($rule);$item.SetAccessControl($acl)}"
        ].join(";")
      );
      await ensurePrivateDirectories([directory]);
      await ensurePrivateFiles([file]);
      await assertCurrentUserOnlyAcl(targets);
      const after = await run(ownersScript);
      expect(after.stdout).toBe(before.stdout);
      expect(await readFile(file, "utf8")).toBe("preserve these bytes\n");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  120_000
);
