import type { AppPaths } from "../config/paths.js";
import type { LocalStatePreparer } from "../transports/transport.js";
import type { BrokerDescriptor } from "../ipc/protocol.js";
import type { IpcClient } from "../ipc/client.js";
import type { FrontendBrokerPort } from "../frontend/broker-port.js";
import type { McpHandshakeOptions, McpHandshakeResult } from "../services/mcp-handshake.js";
import type { SetupServiceLike } from "../services/setup-controller.js";
import type { WorkspaceService } from "../services/workspace-service.js";
import type { Prompter } from "./ui/prompts.js";

/**
 * Everything a CLI command needs from the outside world, explicit and injected rather than
 * read from module-level singletons or `process.env`/`process.cwd()` directly. The composition
 * root (`src/cli/runtime.ts`) builds the one real `CommandDeps`; tests build fakes/temp-dir
 * backed instances instead of monkey-patching modules.
 */
export type CommandDeps = {
  /** Open the one-shot setup URL without passing it to a log sink. */
  runtimeExecutable?: string;
  openBrowser?: (url: string) => Promise<void>;
  diagnose?: (deps: CommandDeps) => Promise<Record<string, unknown>>;
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
  /** WP-B (`install`/`self`/`integrations`): the running CLI's own OS platform, the invoking
   * user's OS home directory, its `package.json` version, and a POSIX uid probe -- all injected
   * (rather than read from `process`/`os` directly) so `install`'s elevation refusal and its
   * `<home>` resolution stay testable without mutating global state. */
  platform: NodeJS.Platform;
  homedir: () => string;
  version: string;
  getuid: () => number | undefined;
  /** The running package's own root directory (the one containing `package.json`) -- `install`
   * stages this into `<home>/app/<version>`. Injectable so a test never stages the real repository
   * checkout; production resolves it from this module's own location (`resolvePackageRoot`,
   * src/cli/commands/install.ts). */
  packageRoot: () => Promise<string>;
  /** Builds the `SetupServiceLike` `install` drives per workspace, bound to `root` rather than
   * `CommandDeps.root` (which never changes within one process) -- `install` sets up more than one
   * workspace in a single run. Tests substitute a fake (e.g. `FakeSetupService` from
   * tests/extension/harness.ts) so `install`'s "Agents" step never needs a real broker or browser. */
  createSetupService: (deps: CommandDeps, root: () => string) => SetupServiceLike;
  /** The shared stdio MCP handshake (src/services/mcp-handshake.ts), used by `install`'s verify
   * step. Injectable so a test never spawns a real child process. */
  mcpHandshake: (options: McpHandshakeOptions) => Promise<McpHandshakeResult>;
  /** Runs a short-lived external command and resolves with its stdout. Used only for the two
   * `<runtime> --version` probes -- `install` recording `runtime.nodeVersion` (P1-5) and `doctor`'s
   * runtime-liveness row (§4.7 C12) -- plus `installRuntime`'s darwin `xattr` call. Optional so
   * every existing `CommandDeps` literal keeps compiling; the composition root supplies the real
   * `execFile`, and tests supply a fake so no test ever execs a binary it did not stage. */
  exec?: (command: string, args: string[]) => Promise<{ stdout: string }>;
};
