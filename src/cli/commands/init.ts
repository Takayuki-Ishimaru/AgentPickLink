import type { CommandDeps } from "../command-deps.js";

/** §30.2: create the local configuration directory, apply restrictive ACLs, write default
 * configuration atomically. Never creates an Entra application and never starts Edge. */
export async function runInit(deps: CommandDeps): Promise<{ initialized: boolean; configPath?: string }> {
  const result = await deps.initializeLocalState(deps.paths, deps.preparer);
  return { initialized: true, configPath: result.config };
}
