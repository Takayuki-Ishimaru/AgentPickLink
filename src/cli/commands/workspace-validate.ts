import { HealthService } from "../../services/health-service.js";
import type { CommandDeps } from "../command-deps.js";

/** §30.4. Delegates to the shared HealthService check so `workspace validate` and `doctor`
 * report the same assignment/approval evaluation (§29.6/§30.5). Never writes to the repository
 * configuration file. */
export async function runWorkspaceValidate(deps: CommandDeps): Promise<Record<string, unknown>> {
  return new HealthService({ paths: deps.paths, workspaces: deps.workspaces }).workspaceReport(deps.root());
}
