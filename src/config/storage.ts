import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { DomainError } from "../domain/errors.js";

const execFileAsync = promisify(execFile);
const WINDOWS_ACL_TIMEOUT_MS = 30_000;
const ACL_STAGES = new Set([
  "identity",
  "read-acl",
  "disable-inheritance",
  "remove-rules",
  "create-rule",
  "add-rule",
  "write-acl",
  "verify-acl",
  "verify-rules"
]);
const ACL_CATEGORIES = new Set([
  "native-failure",
  "access-denied",
  "language-restricted",
  "invalid-argument",
  "APL_ACL_CHECK_UNPROTECTED",
  "APL_ACL_CHECK_FOREIGN_ALLOW",
  "APL_ACL_CHECK_NO_CURRENT"
]);
// Write-Output works in ConstrainedLanguage too; invoking Console.Error in the catch block
// could itself be blocked and discard the very diagnostic needed to explain the failure.
const ACL_FAILURE_REPORT = [
  "$category='native-failure'",
  "$native=$_.Exception",
  "while($null -ne $native.InnerException){$native=$native.InnerException}",
  "$hresult=$native.HResult",
  "if($_.FullyQualifiedErrorId -match 'ConstrainedLanguage|MethodInvocationNotSupported|CannotCreateType'){$category='language-restricted'}elseif($hresult -eq -2147024891){$category='access-denied'}elseif($hresult -eq -2147024809){$category='invalid-argument'}",
  "if(@('APL_ACL_CHECK_UNPROTECTED','APL_ACL_CHECK_FOREIGN_ALLOW','APL_ACL_CHECK_NO_CURRENT') -contains $_.Exception.Message){$category=$_.Exception.Message}",
  "Write-Output ('APL_ACL_STAGE={0};CATEGORY={1};HRESULT={2}' -f $stage,$category,$hresult)",
  "exit 1"
].join(";");

export async function ensurePrivateDirectory(dir: string): Promise<void> {
  await ensurePrivateDirectories([dir]);
}

/** Create and protect several sensitive directories with one Windows ACL operation. */
export async function ensurePrivateDirectories(dirs: string[]): Promise<void> {
  const unique = [...new Set(dirs)];
  for (const dir of unique) {
    const stat = await fs.lstat(dir).catch(() => undefined);
    if (stat?.isSymbolicLink())
      throw new DomainError(
        "BROWSER_PROFILE_INVALID",
        "Sensitive local storage must not be a symbolic link."
      );
  }
  await Promise.all(unique.map((dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  if (process.platform !== "win32") {
    await Promise.all(unique.map((dir) => fs.chmod(dir, 0o700)));
  } else {
    await protectWindowsPaths(unique, true);
  }
}

/** Protect existing sensitive files without rewriting their bytes. */
export async function ensurePrivateFiles(files: string[]): Promise<void> {
  const unique = [...new Set(files)];
  for (const file of unique) {
    const stat = await fs.lstat(file).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || !stat.isFile())
      throw new DomainError("POLICY_BLOCKED", "Sensitive local state must be a regular file.");
  }
  if (process.platform !== "win32") {
    await Promise.all(unique.map((file) => fs.chmod(file, 0o600)));
  } else {
    await protectWindowsPaths(unique, false);
  }
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  await ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(12).toString("hex")}.tmp`
  );
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform === "win32") await protectWindowsPaths([temporary], false);
    await fs.rename(temporary, file);
    if (process.platform !== "win32") await fs.chmod(file, 0o600);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink())
      throw new DomainError("POLICY_BLOCKED", "Sensitive configuration must not be a symbolic link.");
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read-only verification used by doctor after initialization has applied ACLs. */
export async function verifyPrivatePath(target: string, requireWritable = false): Promise<void> {
  const info = await fs.lstat(target).catch(() => undefined);
  if (!info)
    throw new DomainError("POLICY_BLOCKED", "Sensitive local state does not exist. Run m365-agent init.");
  if (info.isSymbolicLink())
    throw new DomainError("POLICY_BLOCKED", "Sensitive local state must not be a symbolic link.");
  if (requireWritable)
    await fs.access(target, constants.W_OK).catch(() => {
      throw new DomainError("POLICY_BLOCKED", "Sensitive local state is not writable by the current user.");
    });
  if (process.platform !== "win32") {
    if ((info.mode & 0o077) !== 0)
      throw new DomainError("POLICY_BLOCKED", "Sensitive local state is accessible to group or other users.");
    return;
  }
  const escaped = target.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p='${escaped}'`,
    "$stage='identity'",
    `try{$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$sidValue=$sid.Value;$stage='read-acl';$acl=Get-Acl -LiteralPath $p;if(!$acl.AreAccessRulesProtected){throw 'APL_ACL_CHECK_UNPROTECTED'};$stage='verify-rules';$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);$hasCurrent=$false;foreach($entry in @($rules | Where-Object {$_.AccessControlType -eq 'Allow'})){if($entry.IdentityReference.Value -ne $sidValue){throw 'APL_ACL_CHECK_FOREIGN_ALLOW'};$hasCurrent=$true};if(!$hasCurrent){throw 'APL_ACL_CHECK_NO_CURRENT'}}catch{${ACL_FAILURE_REPORT}}`
  ].join(";");
  await runPowerShell(script, "Sensitive local state is not protected by a current-user-only ACL.");
}

export async function withFileLock<T>(
  target: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  await ensurePrivateDirectory(path.dirname(target));
  await fs.writeFile(target, "", { flag: "a", mode: 0o600 });
  const release = await lockfile.lock(target, {
    retries:
      options.timeoutMs === undefined
        ? { retries: 10, factor: 1.2, minTimeout: 20, maxTimeout: 250 }
        : {
            retries: Math.max(1, Math.ceil(options.timeoutMs / 250)),
            factor: 1,
            minTimeout: 250,
            maxTimeout: 250
          },
    realpath: false
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function protectWindowsPaths(targets: string[], directory: boolean): Promise<void> {
  if (!targets.length) return;
  const quoted = targets.map((target) => `'${target.replace(/'/g, "''")}'`).join(",");
  const inheritance = directory
    ? "[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit"
    : "[Security.AccessControl.InheritanceFlags]::None";
  // powershell.exe uses .NET Framework. Its Set-Acl provider copies all security sections,
  // which can require WRITE_OWNER even when we only changed the DACL. Read Access only and
  // persist the modified object directly: no owner/group/SACL write or extra privileges.
  const fileSystemType = directory ? "IO.Directory" : "IO.File";
  const protectPath = [
    "$stage='read-acl'",
    `$acl=[${fileSystemType}]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access)`,
    "$stage='disable-inheritance'",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$stage='remove-rules'",
    "foreach($entry in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($entry)}",
    "$stage='create-rule'",
    "$rule=New-Object -TypeName Security.AccessControl.FileSystemAccessRule -ArgumentList @($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
    "$stage='add-rule'",
    "[void]$acl.AddAccessRule($rule)",
    "$stage='write-acl'",
    `[${fileSystemType}]::SetAccessControl($p,$acl)`,
    "$stage='verify-acl'",
    "$check=Get-Acl -LiteralPath $p",
    "if(!$check.AreAccessRulesProtected){throw 'APL_ACL_CHECK_UNPROTECTED'}",
    "$hasCurrent=$false",
    "foreach($entry in @($check.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'})){if($entry.IdentityReference.Value -ne $sidValue){throw 'APL_ACL_CHECK_FOREIGN_ALLOW'};$hasCurrent=$true}",
    "if(!$hasCurrent){throw 'APL_ACL_CHECK_NO_CURRENT'}"
  ].join(";");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$paths=@(${quoted})`,
    `$inheritance=${inheritance}`,
    "$stage='identity'",
    `try{$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$sidValue=$sid.Value;foreach($p in $paths){${protectPath}}}catch{${ACL_FAILURE_REPORT}}`
  ].join(";");
  await runPowerShell(script, "Could not enforce current-user-only protection for sensitive local state.");
}

async function runPowerShell(script: string, failureMessage: string): Promise<void> {
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: WINDOWS_ACL_TIMEOUT_MS
    });
  } catch (error) {
    const timedOut =
      (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
      (error as { killed?: boolean }).killed === true;
    const diagnostic = readPowerShellAclDiagnostic(error);
    const detail = timedOut
      ? "stage=process; category=timeout"
      : `stage=${diagnostic.stage}; category=${diagnostic.category}${diagnostic.hresult === undefined ? "" : `; hresult=${diagnostic.hresult}`}`;
    throw new DomainError(
      "POLICY_BLOCKED",
      timedOut
        ? `${failureMessage} The Windows ACL operation timed out after 30 seconds (${detail}).`
        : `${failureMessage} (${detail}).`,
      false,
      {
        remediation:
          "Retry setup. If this persists, ensure PowerShell can read and write DACLs for AgentPickLink's dedicated local app-data directory; do not weaken the private ACL requirement."
      }
    );
  }
}

function readPowerShellAclDiagnostic(error: unknown): { stage: string; category: string; hresult?: number } {
  const stderr =
    typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr : "";
  const stdout =
    typeof (error as { stdout?: unknown })?.stdout === "string" ? (error as { stdout: string }).stdout : "";
  const marker = /APL_ACL_STAGE=([A-Za-z0-9_-]+);CATEGORY=([A-Za-z0-9_-]+)(?:;HRESULT=(-?\d{1,10}))?/.exec(
    stdout + "\n" + stderr
  );
  if (marker && ACL_STAGES.has(marker[1]!) && ACL_CATEGORIES.has(marker[2]!)) {
    const hresult = marker[3] === undefined ? undefined : Number(marker[3]);
    return {
      stage: marker[1]!,
      category: marker[2]!,
      ...(hresult !== undefined && hresult >= -2147483648 && hresult <= 2147483647 ? { hresult } : {})
    };
  }

  const code = (error as { code?: unknown })?.code;
  if (code === "ENOENT") return { stage: "process", category: "powershell-unavailable" };
  if (code === "EACCES" || code === "EPERM") return { stage: "process", category: "process-access-denied" };
  if (typeof code === "number" && Number.isInteger(code))
    return { stage: "process", category: `exit-${code}` };
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number" && Number.isInteger(status))
    return { stage: "process", category: `exit-${status}` };
  return { stage: "process", category: "native-failure" };
}
