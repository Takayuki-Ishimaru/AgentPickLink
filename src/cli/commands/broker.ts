import { DomainError } from "../../domain/errors.js";
import { BROKER_STOP_TIMEOUT_MS } from "../../broker/broker-lifecycle.js";
import { assertSupportedTopology } from "../../services/workspace-service.js";
import type { CommandDeps } from "../command-deps.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const RECOVERABLE_BROKER_CODES = ["BROKER_VERSION_MISMATCH", "BROKER_AUTH_FAILED", "BROKER_UNAVAILABLE"];

export async function runBroker(
  deps: CommandDeps,
  action: "status" | "restart" | "stop"
): Promise<Record<string, unknown>> {
  if (action === "status") return status(deps);
  if (action === "stop") return stop(deps);
  return restart(deps);
}

async function status(deps: CommandDeps): Promise<Record<string, unknown>> {
  let client;
  try {
    client = await deps.connectExistingBroker(deps.paths);
  } catch (value) {
    if (!(value instanceof DomainError) || !RECOVERABLE_BROKER_CODES.includes(value.code)) throw value;
    const descriptor = await deps.readDescriptor(deps.paths);
    if (descriptor?.state === "stopping") return { live: true, stopping: true };
    return { live: false };
  }
  if (!client) return { live: false };
  try {
    return { live: true, ...((await client.call("broker.health", {})) as Record<string, unknown>) };
  } finally {
    client.close();
  }
}

async function stop(deps: CommandDeps): Promise<Record<string, unknown>> {
  let client;
  try {
    client = await deps.connectExistingBroker(deps.paths);
  } catch (value) {
    if (!(value instanceof DomainError) || !RECOVERABLE_BROKER_CODES.includes(value.code)) throw value;
    const descriptor = await deps.readDescriptor(deps.paths);
    if (descriptor?.state === "stopping") {
      if (!(await waitForDescriptorGone(deps, BROKER_STOP_TIMEOUT_MS, descriptor.instanceId)))
        throw new DomainError(
          "BROKER_UNAVAILABLE",
          "The broker did not finish stopping before the timeout.",
          true
        );
      return { live: true, stopping: true };
    }
    return {
      live: true,
      stopping: true,
      forced: true,
      ...(await deps.terminateDescriptorBroker(deps.paths))
    };
  }
  if (!client) return { live: false, stopping: false };
  const owner = await deps.readDescriptor(deps.paths);
  let shutdownError: unknown;
  try {
    await client.call("broker.shutdown", {});
  } catch (value) {
    // The broker may close this IPC connection as it tears down its listener. The descriptor is
    // the ownership signal; wait for it rather than reporting failure during that normal window.
    if (!(value instanceof DomainError) || !RECOVERABLE_BROKER_CODES.includes(value.code)) throw value;
    shutdownError = value;
  } finally {
    client.close();
  }
  if (!(await waitForDescriptorGone(deps, BROKER_STOP_TIMEOUT_MS, owner?.instanceId))) {
    if (shutdownError instanceof DomainError) throw shutdownError;
    throw new DomainError(
      "BROKER_UNAVAILABLE",
      "The broker did not finish stopping before the timeout.",
      true
    );
  }
  return { live: true, stopping: true };
}

async function restart(deps: CommandDeps): Promise<Record<string, unknown>> {
  assertSupportedTopology();
  await deps.initializeLocalState(deps.paths, deps.preparer);
  let existing;
  try {
    existing = await deps.connectExistingBroker(deps.paths);
  } catch (value) {
    if (!(value instanceof DomainError) || !RECOVERABLE_BROKER_CODES.includes(value.code)) throw value;
    const descriptor = await deps.readDescriptor(deps.paths);
    if (descriptor?.state === "stopping") {
      if (!(await waitForDescriptorGone(deps, BROKER_STOP_TIMEOUT_MS, descriptor.instanceId)))
        throw new DomainError(
          "BROKER_UNAVAILABLE",
          "The previous broker did not finish stopping before the timeout.",
          true,
          { remediation: "run: m365-agent broker restart" }
        );
    } else await deps.terminateDescriptorBroker(deps.paths);
  }
  if (existing) {
    const owner = await deps.readDescriptor(deps.paths);
    let shutdownError: unknown;
    try {
      await existing.call("broker.shutdown", {});
    } catch (value) {
      if (!(value instanceof DomainError) || !RECOVERABLE_BROKER_CODES.includes(value.code)) throw value;
      shutdownError = value;
    } finally {
      existing.close();
    }
    if (!(await waitForDescriptorGone(deps, BROKER_STOP_TIMEOUT_MS, owner?.instanceId))) {
      if (shutdownError instanceof DomainError) throw shutdownError;
      throw new DomainError(
        "BROKER_UNAVAILABLE",
        "The previous broker did not finish stopping before the timeout.",
        true
      );
    }
  }
  const next = await deps.connectOrStartDefaultBroker(deps.paths);
  try {
    return { restarted: true, ...((await next.call("broker.health", {})) as Record<string, unknown>) };
  } finally {
    next.close();
  }
}

async function waitForDescriptorGone(
  deps: CommandDeps,
  timeoutMs: number,
  instanceId?: string
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const descriptor = await deps.readDescriptor(deps.paths);
    if (!descriptor || (instanceId !== undefined && descriptor.instanceId !== instanceId)) return true;
    await delay(50);
  }
  const descriptor = await deps.readDescriptor(deps.paths);
  return !descriptor || (instanceId !== undefined && descriptor.instanceId !== instanceId);
}
