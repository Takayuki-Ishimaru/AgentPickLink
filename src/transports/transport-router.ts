import { assertNever } from "../domain/assert.js";
import type { AgentDefinition } from "../domain/agent.js";
import { DomainError } from "../domain/errors.js";
import type { AgentTransport, InteractiveAgentTransport } from "./transport.js";

/** The transport discriminator carried by every AgentDefinition (see src/domain/agent.ts §11.1
 * transport union). Only "browser" has a registered implementation in v0.1; "work-iq" and
 * "copilot-studio-sdk" are seeded here (per the design doc's §45 future transport strategy) so
 * that adding either later means registering a new AgentTransport with the router -- no changes
 * to broker-server.ts, services, or the frontend. */
export type TransportKind = AgentDefinition["transport"];

/**
 * Selects the AgentTransport (or InteractiveAgentTransport, for the transports that support
 * interactive/admin operations such as login) responsible for a given agent, keyed by
 * `agent.transport`. BrokerServer holds one of these instead of a single hardcoded transport
 * dependency, so per-agent dispatch (and future multi-transport support) never has to change the
 * broker, services, or frontend -- only this registration.
 */
export class TransportRouter {
  private readonly transports = new Map<TransportKind, InteractiveAgentTransport>();

  /** Registers the transport implementation to use for a given transport kind. */
  register(kind: TransportKind, transport: AgentTransport): this {
    this.transports.set(kind, transport as InteractiveAgentTransport);
    return this;
  }

  /** Looks up an already-registered transport by kind, without the AgentDefinition exhaustiveness
   * check `select` performs. Used for opaque-handle-based routing (e.g. closing a conversation
   * from its stored ConversationTransportHandle.transportId) and for transport-kind-specific
   * admin operations (browser login, capture, ...) that are not tied to a particular agent. */
  get(kind: TransportKind | string): InteractiveAgentTransport | undefined {
    return this.transports.get(kind as TransportKind);
  }

  /** Every transport kind an implementation is currently registered for. */
  registeredKinds(): TransportKind[] {
    return [...this.transports.keys()];
  }

  /** Selects the transport for `agent.transport`. The switch's `default: assertNever(agent)`
   * branch only typechecks once every member of the AgentDefinition union is handled above it --
   * so adding a new transport to the domain union without registering (or explicitly rejecting)
   * it here is a compile error, not a runtime surprise. */
  select(agent: AgentDefinition): InteractiveAgentTransport {
    switch (agent.transport) {
      case "browser":
      case "work-iq":
      case "copilot-studio-sdk": {
        const transport = this.transports.get(agent.transport);
        if (!transport)
          throw new DomainError(
            "AGENT_ENTRYPOINT_UNSUPPORTED",
            `No transport is registered for "${agent.transport}" agents.`
          );
        return transport;
      }
      default:
        return assertNever(agent);
    }
  }

  /** Disposes every registered transport (used on broker shutdown). Failures are swallowed per
   * transport so one misbehaving transport cannot block the others from shutting down. */
  async disposeAll(): Promise<void> {
    await this.disposeAllChecked().catch(() => undefined);
  }

  /** Strict shutdown variant: preserves transport ownership when any dispose fails, allowing the
   * broker to retain its descriptor and retry rather than launching a successor into a locked
   * profile. */
  async disposeAllChecked(): Promise<void> {
    const failures: unknown[] = [];
    await Promise.all(
      [...this.transports.values()].map(async (transport) => {
        try {
          await transport.dispose();
        } catch (error) {
          failures.push(error);
        }
      })
    );
    if (failures.length)
      throw new AggregateError(failures, "One or more broker transports failed to dispose.");
  }
}
