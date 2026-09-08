import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError } from "../domain/errors.js";
import { executePowerShell } from "./powershell.js";

/** Reject profile locations that could redirect secret-equivalent browser state. */
export async function assertSafeProfilePath(profilePath: string): Promise<void> {
  if (!path.isAbsolute(profilePath))
    throw new DomainError("BROWSER_PROFILE_INVALID", "Browser profile path must be absolute.");
  if (/^\\\\/.test(profilePath) || /^\/\/[^/]+\//.test(profilePath) || /^\\\\\?\\UNC\\/i.test(profilePath)) {
    throw new DomainError(
      "BROWSER_PROFILE_INVALID",
      "Browser profile path must not use UNC or network storage."
    );
  }
  if (process.platform === "win32") await assertLocalWindowsDrive(profilePath);
  const resolved = path.resolve(profilePath);
  assertNarrowLocalProfilePath(resolved);
  if (/(?:^|[\\/])Microsoft[\\/]Edge[\\/]User Data(?:[\\/]|$)/i.test(resolved)) {
    throw new DomainError(
      "BROWSER_PROFILE_INVALID",
      "The normal Microsoft Edge user profile must never be automated; configure a dedicated AgentPickLink profile."
    );
  }
  const repositoryRoot = await findRepositoryRoot(path.dirname(resolved));
  if (repositoryRoot)
    throw new DomainError(
      "BROWSER_PROFILE_INVALID",
      "Browser profile path must not be inside a source repository."
    );
  await assertNoRedirectedComponent(resolved);
}

async function assertLocalWindowsDrive(target: string): Promise<void> {
  const escaped = target.replace(/'/g, "''");
  const script = [
    `$p='${escaped}'`,
    "$root=[IO.Path]::GetPathRoot($p).TrimEnd('\\')",
    "$disk=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='$root'\"",
    "if($null -eq $disk -or $disk.DriveType -eq 4){exit 4}",
    "$probe=$p",
    "while($probe){if(Test-Path -LiteralPath $probe){$item=Get-Item -Force -LiteralPath $probe;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){exit 5}};$parent=Split-Path -Parent $probe;if(!$parent -or $parent -eq $probe){break};$probe=$parent}"
  ].join(";");
  try {
    await executePowerShell(script, 30_000);
  } catch (error) {
    throw new DomainError(
      "BROWSER_PROFILE_INVALID",
      (error as { killed?: boolean }).killed
        ? "Windows profile validation timed out. Check whether PowerShell or drive inspection is blocked, then retry setup."
        : "Browser profile path must be on a local non-reparse Windows drive."
    );
  }
}

function assertNarrowLocalProfilePath(resolved: string): void {
  const broadRoots = [
    path.parse(resolved).root,
    osHome(),
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA
  ]
    .filter((value): value is string => !!value)
    .map((value) => path.resolve(value));
  if (broadRoots.some((root) => samePath(root, resolved))) {
    throw new DomainError(
      "BROWSER_PROFILE_INVALID",
      "Browser profile path must be a dedicated subdirectory, not a filesystem, home, or application-data root."
    );
  }
  const cloudRoots = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer]
    .filter((value): value is string => !!value)
    .map((value) => path.resolve(value));
  if (
    cloudRoots.some((root) => isWithin(resolved, root)) ||
    /(?:^|[\\/])(?:OneDrive(?:\s*-\s*[^\\/]+)?|Dropbox|Google Drive|iCloudDrive)(?:[\\/]|$)/i.test(resolved)
  ) {
    throw new DomainError(
      "BROWSER_PROFILE_INVALID",
      "Browser profile path must not be inside a known cloud-synchronized directory."
    );
  }
}

function osHome(): string | undefined {
  return process.env.USERPROFILE ?? process.env.HOME;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertNoRedirectedComponent(target: string): Promise<void> {
  let current = target;
  // The profile and its application-data parent are controlled by this app.
  // System ancestors (for example macOS /var -> /private/var in dev tests) are
  // outside that boundary and may legitimately be redirected by the OS.
  for (let depth = 0; depth < 2; depth++) {
    const existing = await fs.lstat(current).catch(() => undefined);
    if (existing?.isSymbolicLink())
      throw new DomainError(
        "BROWSER_PROFILE_INVALID",
        "Browser profile path must not contain a symbolic link or junction."
      );
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function findRepositoryRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  while (true) {
    if (await fs.lstat(path.join(current, ".git")).catch(() => undefined)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
