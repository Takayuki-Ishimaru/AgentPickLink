import path from "node:path";
import { realpath } from "node:fs/promises";
import { configDigest, workspaceKey, type WorkspaceContext } from "../domain/workspace.js";
import { discoverWorkspaceConfig } from "../config/workspace-config.js";
import { DomainError } from "../domain/errors.js";
export class WorkspaceService {
  async load(root: string): Promise<WorkspaceContext> {
    assertSupportedTopology();
    if (!root || !path.isAbsolute(root))
      throw new DomainError("WORKSPACE_ROOT_UNAVAILABLE", "A local absolute workspace root is required.");
    let normalized: string;
    try {
      normalized = normalizeRoot(await realpath(root));
    } catch {
      throw new DomainError("WORKSPACE_ROOT_UNAVAILABLE", "The workspace root is unavailable.");
    }
    // §9.3: the first (and, here, only reachable) boundary is "the configured workspace
    // root" -- i.e. the folder VS Code opened. Passing it as both the start and the boundary
    // means discovery only ever looks at that exact folder and never climbs into a parent
    // (Git root or otherwise), so a config file that happens to live above the opened folder
    // is not discovered and workspaceKey never resolves to something the user did not open.
    assertSupportedTopology(process.env, normalized);
    const discovered = await discoverWorkspaceConfig(normalized, normalized);
    const workspaceRoot = normalizeRoot(path.dirname(discovered.path));
    return {
      root: workspaceRoot,
      workspaceKey: workspaceKey(workspaceRoot),
      config: discovered.config,
      configDigest: configDigest(discovered.config)
    };
  }
}

/**
 * @param providedRoot When supplied (already realpath-normalized), also enforces that a
 * single environment-declared workspace root (M365_AGENT_WORKSPACE_ROOTS, falling back to
 * VSCODE_WORKSPACE_FOLDERS) agrees with it. Left undefined for the generic, root-independent
 * topology checks performed before a specific workspace root is known (login, broker
 * lifecycle, doctor, etc).
 */
export function assertSupportedTopology(
  environment: NodeJS.ProcessEnv = process.env,
  providedRoot?: string
): void {
  if (
    process.platform !== "win32" &&
    process.platform !== "darwin" &&
    environment.NODE_ENV !== "test" &&
    environment.M365_AGENT_ALLOW_UNSUPPORTED_OS !== "1"
  ) {
    throw new DomainError(
      "REMOTE_HOST_UNSUPPORTED",
      "AgentPickLink requires local Windows 11 (production) or macOS (development) desktop execution."
    );
  }
  if (
    environment.VSCODE_REMOTE_NAME ||
    environment.WSL_DISTRO_NAME ||
    environment.REMOTE_CONTAINERS ||
    environment.CODESPACES === "true"
  ) {
    throw new DomainError(
      "REMOTE_HOST_UNSUPPORTED",
      "AgentPickLink v0.1 supports only local VS Code desktop workspaces."
    );
  }
  const encodedRoots = environment.M365_AGENT_WORKSPACE_ROOTS ?? environment.VSCODE_WORKSPACE_FOLDERS;
  const roots = encodedRoots?.split(path.delimiter).filter(Boolean) ?? [];
  if (roots.length > 1)
    throw new DomainError(
      "MULTI_ROOT_UNSUPPORTED",
      "AgentPickLink v0.1 supports only a single workspace root."
    );
  if (providedRoot && roots.length === 1 && normalizeRoot(roots[0]) !== normalizeRoot(providedRoot)) {
    throw new DomainError(
      "WORKSPACE_ROOT_AMBIGUOUS",
      "The workspace root does not match the single workspace folder declared by the environment.",
      false,
      {
        remediation:
          "Reopen the VS Code workspace folder named by M365_AGENT_WORKSPACE_ROOTS/VSCODE_WORKSPACE_FOLDERS, or correct that environment variable."
      }
    );
  }
}

export function normalizeRoot(value: string): string {
  let normalized = path.normalize(value);
  while (normalized.length > path.parse(normalized).root.length && normalized.endsWith(path.sep))
    normalized = normalized.slice(0, -1);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}
