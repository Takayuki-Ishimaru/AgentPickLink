/**
 * Wiring between the extension host and the local broker. The extension never uses
 * `spawnBundledBroker()` (which resolves its entry point from `import.meta.url` and therefore does
 * not survive the CJS bundle): it always passes its own spawn closure, which starts
 * `<extension>/dist/broker/process.js` with the resolved Node runtime.
 *
 * The stale-broker *decision* (`isStaleBrokerBuild`, `isStaleBrokerBrowserConfiguration` and the
 * `restartBrokerIfStale` orchestration) lives in `src/services/broker-staleness.ts` -- it needs no
 * `vscode` API, only `ExtensionRuntime`'s paths, broker entry and logger, so the CLI can reuse it
 * too. `restartBrokerIfStale` below is a thin adapter that maps `ExtensionRuntime` onto that
 * module's plain `BrokerStalenessContext`; the re-exports below keep this module's existing
 * `isStaleBrokerBuild`/`isStaleBrokerBrowserConfiguration`/`BrokerHealthSnapshot` call sites
 * (including `tests/extension/stale-broker.test.ts`) working unchanged.
 */
import { spawn } from "node:child_process";
import type { IpcClient } from "../ipc/client.js";
import { connectExistingBroker, connectOrStartBroker } from "../broker/broker-lifecycle.js";
import {
  restartBrokerIfStale as restartBrokerIfStaleDecision,
  stalenessExpectationFrom
} from "../services/broker-staleness.js";
import type { BrokerHealthSnapshot } from "../services/setup-controller.js";
import { DomainError } from "../domain/errors.js";
import { browserLocalStatePreparer } from "../transports/browser/local-state.js";
import type { SetupDeps } from "../services/setup-service.js";
import type { ExtensionRuntime } from "./runtime.js";

export { isStaleBrokerBuild, isStaleBrokerBrowserConfiguration } from "../services/broker-staleness.js";
/** Declared with `SetupHost` (src/services/setup-controller.ts), which consumes it; re-exported
 * here because the poller, the panel and their tests have always imported it from this module. */
export type { BrokerHealthSnapshot };

/** Windows needs tens of seconds to apply the private ACLs before the descriptor appears. */
const BROKER_START_TIMEOUT_MS = 60_000;

/** Starts `dist/broker/process.js` detached so it outlives the extension host. */
export async function spawnBroker(runtime: ExtensionRuntime): Promise<void> {
  const node = await runtime.node();
  runtime.log(`broker: spawning ${runtime.brokerEntry()} with ${node.kind} node`);
  const child = spawn(node.command, [runtime.brokerEntry()], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: runtime.childEnvironment(node)
  });
  child.unref();
}

export function createSetupDeps(runtime: ExtensionRuntime): SetupDeps {
  return {
    paths: runtime.paths,
    connect: () => connectOrStartBroker(runtime.paths, () => spawnBroker(runtime), BROKER_START_TIMEOUT_MS),
    connectExisting: () => connectExistingBroker(runtime.paths),
    preparer: browserLocalStatePreparer,
    root: () => {
      const root = runtime.workspaceRoot();
      if (!root)
        throw new DomainError(
          "WORKSPACE_ROOT_UNAVAILABLE",
          "Open a single-root workspace folder before configuring AgentPickLink.",
          false
        );
      return root;
    }
  };
}

/**
 * Reads `broker.health` from an already running broker. Returns `undefined` when no broker is
 * live: polling must never start the broker (and therefore never start a browser).
 */
export async function readBrokerHealth(runtime: ExtensionRuntime): Promise<BrokerHealthSnapshot | undefined> {
  let client: IpcClient | undefined;
  try {
    client = await connectExistingBroker(runtime.paths);
  } catch {
    return undefined;
  }
  if (!client) return undefined;
  try {
    return (await client.call("broker.health", {})) as BrokerHealthSnapshot;
  } catch {
    return undefined;
  } finally {
    client.close();
  }
}

/** Stops a broker started from an older build (or a stale browser configuration) so the next
 * connect-or-start spawns this build. Returns true when a stale broker was found and asked to
 * shut down. Never starts anything itself -- see `src/services/broker-staleness.ts` for the
 * staleness decision this adapts `ExtensionRuntime` for.
 *
 * §4.7 C13: awaits `install.json` first (so `brokerEntry()` below is the machine install's, not
 * this extension's own tree) and passes exactly the `expected` version `serve` passes. Without
 * both, a machine install's perfectly current broker looks stale to the extension on every single
 * activation -- its `build.entry` is a file this VSIX never wrote -- and the two entry points
 * restart each other's broker forever. */
export async function restartBrokerIfStale(runtime: ExtensionRuntime): Promise<boolean> {
  const expected = stalenessExpectationFrom(await runtime.machineInstall());
  return restartBrokerIfStaleDecision({
    paths: runtime.paths,
    brokerEntry: runtime.brokerEntry(),
    log: (line) => runtime.log(line),
    ...(expected ? { expected } : {})
  });
}
