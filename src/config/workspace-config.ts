import { promises as fs } from "node:fs";
import path from "node:path";
import { WorkspaceConfigSchema, type WorkspaceConfig } from "../domain/workspace.js";
import { DomainError } from "../domain/errors.js";
import { migrateStore } from "./migrations.js";
export async function discoverWorkspaceConfig(
  start: string,
  boundary?: string
): Promise<{ path: string; config: WorkspaceConfig }> {
  const resolvedBoundary = boundary
    ? path.resolve(boundary)
    : ((await findGitRoot(start)) ?? path.parse(path.resolve(start)).root);
  let current = path.resolve(start);
  while (true) {
    const file = path.join(current, ".m365-agents.json");
    try {
      const raw = await fs.readFile(file, "utf8");
      // migrateStore fails closed (throws its own DomainError, with a version-drift-specific
      // remediation) on anything but version 1, before the strict zod schema even runs.
      try {
        return {
          path: file,
          config: WorkspaceConfigSchema.parse(migrateStore("workspace-config", JSON.parse(raw)))
        };
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError("WORKSPACE_CONFIG_INVALID", "The workspace configuration is invalid.");
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new DomainError("WORKSPACE_ROOT_UNAVAILABLE", "The workspace configuration could not be read.");
    }
    if (samePath(current, resolvedBoundary) || current === path.parse(current).root) break;
    const parent = path.dirname(current);
    if (!isWithin(parent, resolvedBoundary) && !isWithin(resolvedBoundary, parent)) break;
    current = parent;
  }
  throw new DomainError("WORKSPACE_NOT_CONFIGURED", "No .m365-agents.json was found for this workspace.");
}

async function findGitRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  while (true) {
    try {
      if (
        (await fs.stat(path.join(current, ".git"))).isDirectory() ||
        (await fs.stat(path.join(current, ".git"))).isFile()
      )
        return current;
    } catch {
      /* keep searching */
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
