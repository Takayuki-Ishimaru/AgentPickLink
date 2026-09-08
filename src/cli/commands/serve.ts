import path from "node:path";
import { IpcBrokerClient } from "../../frontend/ipc-client.js";
import { LazyBrokerPort } from "../../frontend/lazy-broker-port.js";
import { assertSupportedTopology } from "../../services/workspace-service.js";
import type { CommandDeps } from "../command-deps.js";

/** §30.6: the stdio transport must come up first -- `m365_agent_list` has to be visible even
 * while the broker is still starting (or fails to start). The broker is connected lazily, on
 * the first tool call that actually needs it, via LazyBrokerPort. Never starts Edge at startup. */
export async function runServe(deps: CommandDeps): Promise<void> {
  assertSupportedTopology();
  let initialized = false;
  const port = new LazyBrokerPort(async (signal) => {
    // MCP initialize/tools/list need neither the private profile nor filesystem ACL work.
    // Do this once, only when this workspace actually makes a broker-backed tool call.
    if (!initialized) {
      await deps.initializeLocalState(deps.paths, deps.preparer);
      initialized = true;
    }
    signal.throwIfAborted();
    const brokerClient = await deps.connectOrStartDefaultBroker(deps.paths);
    return new IpcBrokerClient(brokerClient);
  });
  try {
    await deps.serveStdio(port, deps.root, { attachmentsDirectory: path.join(deps.root(), "APL_downloads") });
  } finally {
    port.close();
  }
}
