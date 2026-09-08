/**
 * The module seam the extension's tests replace.
 *
 * Everything in `activate()` that would otherwise reach a real broker -- connecting to it, starting
 * it, polling its health, or building the `SetupService` the panel drives -- goes through this one
 * indirection so `tests/extension/**` can run the real activation, command wiring and panel state
 * machine in plain Node without spawning a process or opening a browser.
 *
 * The defaults are the production wiring; nothing here changes behaviour at run time.
 */
import { connectOrStartBroker } from "../broker/broker-lifecycle.js";
import { SetupService } from "../services/setup-service.js";
import { createSetupDeps, readBrokerHealth, spawnBroker, type BrokerHealthSnapshot } from "./broker.js";
import type { ExtensionRuntime } from "./runtime.js";
import type * as vscode from "vscode";
import { startUpdateCheck } from "./update-checker.js";

/** Windows needs tens of seconds to apply the private ACLs before the descriptor appears. */
const BROKER_START_TIMEOUT_MS = 60_000;

/**
 * The slice of `SetupService` the panel calls. Declared structurally so a test can hand
 * `SetupViewProvider` a fake without constructing the real service (which would need file stores
 * and a live broker).
 */
export type SetupServiceLike = Pick<
  SetupService,
  | "status"
  | "ensureSignedIn"
  | "ensureBrowserChannel"
  | "cancelSignIn"
  | "cancelDiscovery"
  | "discover"
  | "apply"
  | "removeAgent"
  | "revokeWorkspace"
  | "signOut"
  | "restartBroker"
  | "updateConfig"
>;

/** The minimum an auto-start needs to hand back: the connection is closed again immediately. */
export type ClosableClient = { close: () => void };

export type ExtensionDeps = {
  checkForUpdates?: (context: vscode.ExtensionContext, runtime: ExtensionRuntime) => vscode.Disposable;
  /** Built lazily, once, the first time the panel runs an action. */
  createSetupService: (runtime: ExtensionRuntime) => SetupServiceLike;
  /** Reads `broker.health` from an already running broker; never starts one. */
  readBrokerHealth: (runtime: ExtensionRuntime) => Promise<BrokerHealthSnapshot | undefined>;
  /** The `agentpicklink.autoStartBroker` path: the only place activation may start a process. */
  connectOrStartBroker: (runtime: ExtensionRuntime) => Promise<ClosableClient>;
  /** Shuts down a broker started from an older build before auto-start (tests inject a no-op). */
  restartBrokerIfStale?: (runtime: ExtensionRuntime) => Promise<boolean>;
};

export function defaultExtensionDeps(): ExtensionDeps {
  return {
    checkForUpdates: startUpdateCheck,
    createSetupService: (runtime) => new SetupService(createSetupDeps(runtime)),
    readBrokerHealth: (runtime) => readBrokerHealth(runtime),
    connectOrStartBroker: (runtime) =>
      connectOrStartBroker(runtime.paths, () => spawnBroker(runtime), BROKER_START_TIMEOUT_MS)
  };
}

/** The panel's default service factory, so `SetupViewProvider` stays constructible on its own. */
export function defaultCreateSetupService(runtime: ExtensionRuntime): SetupServiceLike {
  return new SetupService(createSetupDeps(runtime));
}
