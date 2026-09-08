/**
 * Wiring between the extension host and the local broker. The extension never uses
 * `spawnBundledBroker()` (which resolves its entry point from `import.meta.url` and therefore does
 * not survive the CJS bundle): it always passes its own spawn closure, which starts
 * `<extension>/dist/broker/process.js` with the resolved Node runtime.
 */
import { readDescriptor } from "../broker/broker-descriptor.js";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { IpcClient } from "../ipc/client.js";
import type { Incident } from "../observability/incidents.js";
import { connectExistingBroker, connectOrStartBroker } from "../broker/broker-lifecycle.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { readText } from "../config/storage.js";
import { DomainError } from "../domain/errors.js";
import { browserLocalStatePreparer } from "../transports/browser/local-state.js";
import type { SetupDeps } from "../services/setup-service.js";
import type { ExtensionRuntime } from "./runtime.js";
import YAML from "yaml";

/** Windows needs tens of seconds to apply the private ACLs before the descriptor appears. */
const BROKER_START_TIMEOUT_MS = 60_000;
const BROKER_HEALTH_TIMEOUT_MS = 5_000;

export type BrokerHealthSnapshot = {
  instanceId: string;
  protocolMajor: number;
  protocolMinor: number;
  browserStarted: boolean;
  transport: { healthy: boolean; details?: string };
  authState?: { state: string; checkedAt: string };
  incidents: Incident[];
  /** G6: set when the broker is running against a development-only configuration (an insecure
   * loopback navigation allowance, or a dev app URL override) -- see `isDevMode()`
   * (src/extension/status.ts). Absent on a production broker/older protocol. */
  devMode?: { insecureLoopback: boolean; devAppUrl: boolean };
  /** G5: the browser the broker actually launched with, which may differ from `GlobalConfig`'s
   * configured `channel`/`headless` until the next restart. Absent before the browser has started. */
  browser?: {
    channel: string;
    headless: boolean;
    viewport?: { width: number; height: number };
    executable?: string;
  };
};

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

/**
 * A broker keeps running as a detached process across extension updates, so after a VSIX update
 * the descriptor can still point at a broker started from the previous build. The broker records
 * its entry file and that file's mtime; a client whose own broker entry differs (path or mtime)
 * knows the running broker is stale.
 */
export function isStaleBrokerBuild(
  descriptorBuild: { entry: string; mtimeMs: number } | undefined,
  current: { entry: string; mtimeMs: number }
): boolean {
  if (!descriptorBuild) return false;
  return (
    descriptorBuild.entry !== current.entry ||
    Math.round(descriptorBuild.mtimeMs) !== Math.round(current.mtimeMs)
  );
}

/** Returns whether a live broker reports a browser configuration different from this extension's
 * persisted configuration. Older brokers omit `browser` from health, so an absent description is
 * deliberately treated as unknown rather than stale; this avoids repeatedly stopping brokers
 * that predate the metadata. */
export function isStaleBrokerBrowserConfiguration(
  configured: { channel: string; headless: boolean },
  running: { channel: string; headless: boolean } | undefined
): boolean {
  return running !== undefined && (running.channel !== configured.channel || running.headless !== true);
}

async function stopBroker(client: IpcClient, runtime: ExtensionRuntime): Promise<boolean> {
  try {
    await client.call("broker.shutdown", {});
  } catch {
    /* it may already be going away */
  } finally {
    client.close();
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await readDescriptor(runtime.paths).catch(() => undefined))) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
}

async function readBrokerHealthBounded(client: IpcClient): Promise<BrokerHealthSnapshot | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BROKER_HEALTH_TIMEOUT_MS);
  try {
    return (await client.call("broker.health", {}, undefined, controller.signal)) as BrokerHealthSnapshot;
  } finally {
    clearTimeout(timeout);
  }
}

/** Detects the legacy visible-browser config before loadGlobalConfig persists its one-time
 * migration marker. This is only used when an old broker cannot report browser metadata. */
async function hasPendingHeadlessMigration(runtime: ExtensionRuntime): Promise<boolean> {
  const text = await readText(runtime.paths.config).catch(() => undefined);
  if (text === undefined) return false;
  try {
    const raw = YAML.parse(text) as unknown;
    if (!isRecord(raw)) return false;
    const browser = raw.browser;
    return isRecord(browser) && browser.headless === false;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Stops a broker started from an older build so the next connect-or-start spawns this build.
 * Returns true when a stale broker was found and asked to shut down. Never starts anything. The
 * browser metadata check also catches a legacy broker without build metadata after the one-time
 * headless migration has changed the persisted configuration. */
export async function restartBrokerIfStale(runtime: ExtensionRuntime): Promise<boolean> {
  const descriptor = await readDescriptor(runtime.paths).catch(() => undefined);
  if (!descriptor) return false;
  const pendingHeadlessMigration = await hasPendingHeadlessMigration(runtime);
  const config = await loadGlobalConfig(runtime.paths).catch(() => undefined);
  if (!config) return false;
  let staleBuild = false;
  if (descriptor.build) {
    const entry = runtime.brokerEntry();
    const mtimeMs = await stat(entry)
      .then((info) => info.mtimeMs)
      .catch(() => undefined);
    staleBuild = mtimeMs !== undefined && isStaleBrokerBuild(descriptor.build, { entry, mtimeMs });
  }
  let client;
  try {
    client = await connectExistingBroker(runtime.paths);
  } catch {
    client = undefined;
  }
  if (!client) return false;
  if (staleBuild) {
    runtime.log("broker: the running broker was started from an older build; restarting it");
    return stopBroker(client, runtime);
  }
  let staleConfiguration: boolean;
  try {
    const health = await readBrokerHealthBounded(client);
    staleConfiguration =
      isStaleBrokerBrowserConfiguration(config.browser, health?.browser) ||
      (pendingHeadlessMigration && health?.browser === undefined);
  } catch {
    // A known one-time migration is enough to replace an old broker that cannot answer health;
    // otherwise build metadata remains authoritative when an older broker is unreachable here.
    staleConfiguration = pendingHeadlessMigration;
  }
  if (!staleBuild && !staleConfiguration) {
    client.close();
    return false;
  }
  runtime.log(
    staleBuild
      ? "broker: the running broker was started from an older build; restarting it"
      : "broker: the running broker configuration differs from saved settings; restarting it"
  );
  return stopBroker(client, runtime);
}
