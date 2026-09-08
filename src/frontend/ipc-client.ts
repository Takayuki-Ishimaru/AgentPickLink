import type { FrontendBrokerPort } from "./broker-port.js";
import type { AskInput, AskResult, ListResult, SessionInput, SessionResult, ToolError } from "./schemas.js";
import { asDomainError } from "../domain/errors.js";
import type { ProgressSink } from "../domain/progress.js";

/** Adapter over the core IPC client. The transport accepts only named domain methods. */
export interface BrokerRpcTransport {
  isConnected?(): boolean;
  close?(): void;
  call(
    method:
      | "broker.health"
      | "workspace.list"
      | "conversation.create"
      | "conversation.invoke"
      | "conversation.list"
      | "conversation.close"
      | "conversation.closeAllForWorkspace"
      | "agent.discover"
      | "browser.login"
      | "browser.cancelLogin"
      | "browser.authState"
      | "agent.inspectUrl",
    params: Record<string, unknown>,
    requestId?: string,
    signal?: AbortSignal,
    options?: { onProgress?: ProgressSink }
  ): Promise<unknown>;
}

export class IpcBrokerClient implements FrontendBrokerPort {
  constructor(private readonly rpc: BrokerRpcTransport) {}

  isConnected(): boolean {
    return this.rpc.isConnected?.() ?? true;
  }
  close(): void {
    this.rpc.close?.();
  }

  async list(
    workspaceRoot: string,
    requestId: string,
    signal?: AbortSignal
  ): Promise<ListResult | ToolError> {
    const value = await this.call<Record<string, unknown>>(
      "workspace.list",
      { root: workspaceRoot },
      requestId,
      signal
    );
    if (isToolError(value)) return value;
    return {
      ok: true,
      requestId,
      workspace: value.workspace as ListResult["workspace"],
      agents: value.agents as ListResult["agents"]
    };
  }
  async ask(
    workspaceRoot: string,
    input: AskInput,
    requestId: string,
    signal?: AbortSignal,
    onProgress?: ProgressSink
  ): Promise<AskResult | ToolError> {
    const value = await this.call<Omit<AskResult, "ok" | "requestId">>(
      "conversation.invoke",
      {
        root: workspaceRoot,
        agent: input.agent,
        message: input.message,
        ...(input.conversationHandle ? { conversationHandle: input.conversationHandle } : {})
      },
      requestId,
      signal,
      onProgress ? { onProgress } : undefined
    );
    return isToolError(value) ? value : { ok: true, requestId, ...value };
  }
  async session(
    workspaceRoot: string,
    input: SessionInput,
    requestId: string,
    signal?: AbortSignal,
    onProgress?: ProgressSink
  ): Promise<SessionResult | ToolError> {
    if (input.action === "new") {
      const value = await this.call<Record<string, unknown>>(
        "conversation.create",
        { root: workspaceRoot, agent: input.agent },
        requestId,
        signal,
        onProgress ? { onProgress } : undefined
      );
      return isToolError(value)
        ? value
        : { ok: true, requestId, action: "new", conversation: publicConversation(value) };
    }
    if (input.action === "list") {
      const value = await this.call<unknown[]>(
        "conversation.list",
        { root: workspaceRoot },
        requestId,
        signal
      );
      return isToolError(value)
        ? value
        : {
            ok: true,
            requestId,
            action: "list",
            conversations: value.map((item) => publicConversation(item as Record<string, unknown>))
          };
    }
    if (input.action === "close") {
      const value = await this.call<Record<string, unknown>>(
        "conversation.close",
        { root: workspaceRoot, conversationHandle: input.conversationHandle },
        requestId,
        signal
      );
      return isToolError(value)
        ? value
        : { ok: true, requestId, action: "close", conversation: publicConversation(value) };
    }
    const value = await this.call<unknown[]>(
      "conversation.closeAllForWorkspace",
      { root: workspaceRoot },
      requestId,
      signal
    );
    return isToolError(value)
      ? value
      : { ok: true, requestId, action: "close_all", closedCount: value.length };
  }

  private async call<T>(
    method: Parameters<BrokerRpcTransport["call"]>[0],
    params: Record<string, unknown>,
    requestId?: string,
    signal?: AbortSignal,
    options?: { onProgress?: ProgressSink }
  ): Promise<T | ToolError> {
    try {
      const value = await this.rpc.call(method, params, requestId, signal, options);
      if (isToolError(value)) return value;
      if (!value || typeof value !== "object") return protocolError("Broker returned a non-object response.");
      return value as T;
    } catch (error) {
      const domain = asDomainError(error);
      return domain.toResult(requestId ?? "ipc").error;
    }
  }
}

function publicConversation(value: Record<string, unknown>) {
  return {
    conversationHandle: String(value.handle ?? value.conversationHandle ?? ""),
    agent: String(value.agentAlias ?? value.agent ?? ""),
    createdAt: String(value.createdAt ?? ""),
    lastUsedAt: String(value.lastUsedAt ?? "")
  };
}

function isToolError(value: unknown): value is ToolError {
  return (
    !!value && typeof value === "object" && "code" in value && "message" in value && "retryable" in value
  );
}
function protocolError(message: string): ToolError {
  return { code: "BROKER_PROTOCOL_ERROR", message, retryable: true };
}
