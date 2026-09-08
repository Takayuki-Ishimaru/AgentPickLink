import type { AppPaths } from "../config/paths.js";
import type { LocalStatePreparer } from "../transports/transport.js";
import type { BrokerDescriptor } from "../ipc/protocol.js";
import type { IpcClient } from "../ipc/client.js";
import type { FrontendBrokerPort } from "../frontend/broker-port.js";
import type { WorkspaceService } from "../services/workspace-service.js";
import type { Prompter } from "./ui/prompts.js";

/**
 * Everything a CLI command needs from the outside world, explicit and injected rather than
 * read from module-level singletons or `process.env`/`process.cwd()` directly. The composition
 * root (`src/cli/runtime.ts`) builds the one real `CommandDeps`; tests build fakes/temp-dir
 * backed instances instead of monkey-patching modules.
 */
export type CommandDeps = {
  paths: AppPaths;
  /** The workspace root a command operates against; a function (not a bare string) because
   * `process.cwd()` can change between commands in the same process. */
  root: () => string;
  env: NodeJS.ProcessEnv;
  /** Injected so verification/approval timestamps are deterministic under test. */
  clock: () => Date;
  prompter: Prompter;
  /** Diagnostic/explanatory text that must not go through `--json` shaping (e.g. the workspace
   * approve summary, the agent-add capture hint). Always stderr, matching the prior behavior. */
  stderr: (text: string) => void;
  /** The interactive `workspace configure` candidate menu, matching the prior behavior of
   * writing that listing to stdout (distinct from the `stderr`-only approval/diagnostic text). */
  stdout: (text: string) => void;
  /** The transport-owned local-state contract (the dedicated browser profile), passed through to
   * `initializeLocalState`/`HealthService` without the CLI depending on a concrete transport. */
  preparer: LocalStatePreparer;
  workspaces: WorkspaceService;
  initializeLocalState: (paths: AppPaths, preparer: LocalStatePreparer) => Promise<AppPaths>;
  connectExistingBroker: (paths: AppPaths) => Promise<IpcClient | undefined>;
  connectOrStartDefaultBroker: (paths: AppPaths) => Promise<IpcClient>;
  terminateDescriptorBroker: (paths: AppPaths) => Promise<{ stopped: boolean; pid?: number }>;
  readDescriptor: (paths: AppPaths) => Promise<BrokerDescriptor | undefined>;
  serveStdio: (
    port: FrontendBrokerPort,
    workspaceRoot: () => string,
    options?: { attachmentsDirectory?: string }
  ) => Promise<void>;
};
