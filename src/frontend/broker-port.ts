import type { AskInput, AskResult, ListResult, SessionInput, SessionResult, ToolError } from "./schemas.js";
import type { ProgressSink } from "../domain/progress.js";

/** Domain-only IPC surface.  No URL, selector, page, or Playwright value is accepted. */
export interface FrontendBrokerPort {
  /** Connection lifecycle only; optional for in-process/test ports. */
  isConnected?(): boolean;
  close?(): void;
  list(workspaceRoot: string, requestId: string, signal?: AbortSignal): Promise<ListResult | ToolError>;
  ask(
    workspaceRoot: string,
    input: AskInput,
    requestId: string,
    signal?: AbortSignal,
    onProgress?: ProgressSink
  ): Promise<AskResult | ToolError>;
  session(
    workspaceRoot: string,
    input: SessionInput,
    requestId: string,
    signal?: AbortSignal,
    onProgress?: ProgressSink
  ): Promise<SessionResult | ToolError>;
  health?(requestId: string): Promise<Record<string, unknown> | ToolError>;
}

/** Useful for embedding the frontend in tests or a broker client implementation. */
export class UnavailableBroker implements FrontendBrokerPort {
  async list(_workspaceRoot: string): Promise<ToolError> {
    return unavailable();
  }
  async ask(
    _workspaceRoot: string,
    _input: AskInput,
    _requestId?: string,
    _signal?: AbortSignal,
    _onProgress?: ProgressSink
  ): Promise<ToolError> {
    return unavailable();
  }
  async session(_workspaceRoot: string, _input: SessionInput): Promise<ToolError> {
    return unavailable();
  }
}
function unavailable(): ToolError {
  return {
    code: "BROKER_UNAVAILABLE",
    message: "The local Microsoft 365 broker is unavailable.",
    retryable: true,
    remediation: "Run: m365-agent broker status"
  };
}
