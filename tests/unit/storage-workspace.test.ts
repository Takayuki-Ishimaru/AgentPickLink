import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { atomicWriteWorkspaceFile } from "../../src/config/storage.js";

it("saves and replaces workspace config without changing the workspace mode or Windows ACL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "apl-workspace-permissions-"));
  const file = path.join(root, ".m365-agents.json");
  const acl = async () => {
    const result = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[IO.Directory]::GetAccessControl('${root.replace(/'/g, "''")}').GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)`
      ],
      { windowsHide: true, timeout: 30_000 }
    );
    return result.stdout.trim();
  };
  try {
    if (process.platform !== "win32") await chmod(root, 0o755);
    const before = process.platform === "win32" ? await acl() : (await stat(root)).mode & 0o777;
    await atomicWriteWorkspaceFile(file, '{"version":1}\n');
    await atomicWriteWorkspaceFile(file, '{"version":2}\n');
    const after = process.platform === "win32" ? await acl() : (await stat(root)).mode & 0o777;
    expect(after).toBe(before);
    expect(await readFile(file, "utf8")).toBe('{"version":2}\n');
    expect(await readdir(root)).toEqual([".m365-agents.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("cleans a temporary workspace file when replacement fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "apl-workspace-write-failure-"));
  try {
    // A directory cannot be replaced by a file on either supported desktop platform.
    await expect(atomicWriteWorkspaceFile(root, "payload")).rejects.toThrow();
    const siblings = await readdir(path.dirname(root));
    expect(siblings.filter((name) => name.startsWith(`.${path.basename(root)}.`))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
