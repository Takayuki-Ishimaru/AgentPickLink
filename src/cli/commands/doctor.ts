import { DomainError } from "../../domain/errors.js";
import type { ToolError } from "../../frontend/schemas.js";
import { HealthService } from "../../services/health-service.js";
import type { CommandDeps } from "../command-deps.js";
import { toToolError } from "../ui/formatter.js";

/**
 * §30.5. Delegates every local prerequisite/configuration check to the shared HealthService
 * (also used by the broker's `broker.health`) so `doctor` and the broker can never drift apart.
 * doctor only adds the parts that need a broker connection, and -- by calling `agent.validate`
 * with `sendTestMessage: false` -- never sends an agent message, even with `--agent`.
 */
export async function runDoctor(
  deps: CommandDeps,
  options?: { agent?: string; auth?: boolean }
): Promise<Record<string, unknown>> {
  const health = new HealthService({ paths: deps.paths, preparer: deps.preparer, toFailure: toToolError });
  const { topologyReady, checks } = await health.localReport(deps.root());
  const result: Record<string, unknown> = { ...checks };
  // Read before connecting: connectExistingBroker cleans up a stale descriptor it rejects.
  const descriptor = await health.descriptorState();
  let broker;
  let brokerFailure: ToolError | undefined;
  try {
    broker = await deps.connectExistingBroker(deps.paths);
  } catch (value) {
    brokerFailure = toToolError(value);
  }
  result.broker = broker
    ? {
        live: true,
        descriptorPresent: true,
        ...((await broker.call("broker.health", {})) as Record<string, unknown>)
      }
    : { live: false, ...descriptor, ...(brokerFailure ? { error: brokerFailure } : {}) };
  if ((options?.auth || options?.agent) && topologyReady && !broker) {
    try {
      broker = await deps.connectOrStartDefaultBroker(deps.paths);
    } catch (value) {
      brokerFailure = toToolError(value);
    }
  }
  const unavailable =
    brokerFailure ??
    toToolError(
      new DomainError(
        topologyReady ? "BROKER_UNAVAILABLE" : "REMOTE_HOST_UNSUPPORTED",
        topologyReady
          ? "The broker could not be started."
          : "Optional browser checks require the supported local Windows topology.",
        topologyReady
      )
    );
  if (options?.auth)
    result.authentication = broker ? await broker.call("browser.authState", {}) : unavailable;
  if (options?.agent)
    result.agent = broker
      ? await broker.call("agent.validate", { agent: options.agent, sendTestMessage: false })
      : unavailable;
  broker?.close();
  return result;
}
