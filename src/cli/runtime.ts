import {
  connectExistingBroker,
  connectOrStartDefaultBroker,
  terminateDescriptorBroker
} from "../broker/broker-lifecycle.js";
import { readDescriptor } from "../broker/broker-descriptor.js";
import { initializeLocalState } from "../config/init.js";
import { appPaths } from "../config/paths.js";
import { serveStdio } from "../frontend/mcp-server.js";
import { WorkspaceService } from "../services/workspace-service.js";
import { browserLocalStatePreparer } from "../transports/browser/local-state.js";
import type { CliApi } from "./api.js";
import type { CommandDeps } from "./command-deps.js";
import { runAgentAdd } from "./commands/agent-add.js";
import { runAgentDiscover } from "./commands/agent-discover.js";
import { runAgentList } from "./commands/agent-list.js";
import { runAgentRemove } from "./commands/agent-remove.js";
import { runAgentTest } from "./commands/agent-test.js";
import { runBroker } from "./commands/broker.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { runServe } from "./commands/serve.js";
import { runWorkspaceApprovalStatus } from "./commands/workspace-approval-status.js";
import { runWorkspaceApprove } from "./commands/workspace-approve.js";
import { runWorkspaceConfigure } from "./commands/workspace-configure.js";
import { runWorkspaceList } from "./commands/workspace-list.js";
import { runWorkspaceRevoke } from "./commands/workspace-revoke.js";
import { runWorkspaceValidate } from "./commands/workspace-validate.js";
import { toToolError } from "./ui/formatter.js";
import { createTtyPrompter } from "./ui/prompts.js";

/** Wraps a command body so any thrown value (a `DomainError` or otherwise) becomes the CliApi's
 * `CliResult` error shape instead of propagating -- the one place that mapping happens for the
 * whole CLI surface. */
async function attempt<T>(action: () => Promise<T>): Promise<T | ReturnType<typeof toToolError>> {
  try {
    return await action();
  } catch (value) {
    return toToolError(value);
  }
}

/** Builds the one real `CommandDeps`, wiring every command module to the actual filesystem,
 * broker, and terminal. This is the sole composition root for the CLI: it holds the only
 * module-level construction in `src/cli`, and every command function it calls is otherwise
 * free of hidden state. */
function createCommandDeps(): CommandDeps {
  return {
    paths: appPaths(),
    root: () => process.cwd(),
    env: process.env,
    clock: () => new Date(),
    prompter: createTtyPrompter(),
    stderr: (text) => {
      process.stderr.write(text);
    },
    stdout: (text) => {
      process.stdout.write(text);
    },
    preparer: browserLocalStatePreparer,
    workspaces: new WorkspaceService(),
    initializeLocalState,
    connectExistingBroker,
    connectOrStartDefaultBroker,
    terminateDescriptorBroker,
    readDescriptor,
    serveStdio
  };
}

export function createDefaultCliApi(): CliApi {
  const deps = createCommandDeps();
  return {
    init: () => attempt(() => runInit(deps)),
    login: () => attempt(() => runLogin(deps)),
    logout: (options) => attempt(() => runLogout(deps, options)),
    doctor: (options) => attempt(() => runDoctor(deps, options)),
    broker: (action) => attempt(() => runBroker(deps, action)),
    agentAdd: (options) => attempt(() => runAgentAdd(deps, options)),
    agentRemove: (alias) => attempt(() => runAgentRemove(deps, alias)),
    agentList: () => attempt(() => runAgentList(deps)),
    agentDiscover: (options) => attempt(() => runAgentDiscover(deps, options)),
    agentTest: (alias, options) => attempt(() => runAgentTest(deps, alias, options)),
    workspaceConfigure: () => attempt(() => runWorkspaceConfigure(deps)),
    workspaceList: () => attempt(() => runWorkspaceList(deps)),
    workspaceValidate: () => attempt(() => runWorkspaceValidate(deps)),
    workspaceApprove: (options) => attempt(() => runWorkspaceApprove(deps, options)),
    workspaceApprovalStatus: () => attempt(() => runWorkspaceApprovalStatus(deps)),
    workspaceRevoke: () => attempt(() => runWorkspaceRevoke(deps)),
    // serve owns the MCP stdio transport: its failures are handled by src/cli/index.ts rather
    // than folded into the JSON-shaped CliResult envelope every other command uses.
    serve: () => runServe(deps)
  };
}
