import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
export type AuditEvent = {
  event: "agent.invoke.complete" | "agent.invoke.failed";
  requestId: string;
  workspace: string;
  agent: string;
  conversation: string;
  durationMs: number;
  requestChars: number;
  responseChars: number;
  citationCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  /** Count of not-saved attachments, keyed by acquisition stage (or errorCode when no stage was
   * recorded) -- e.g. `{ "host-not-allowed": 1, "http-rejected": 1 }`. Metadata only: no
   * filenames, sourceUrls, or other content. Omitted when nothing failed to save. */
  attachmentFailuresByStage?: Record<string, number>;
  status: "success" | "failure";
  errorCode?: string;
};
export class AuditLogger {
  constructor(
    private readonly directory: string,
    private readonly enabled = true
  ) {}
  async write(event: AuditEvent): Promise<void> {
    if (!this.enabled) return;
    const safe: AuditEvent = {
      event: event.event,
      requestId: event.requestId,
      workspace: event.workspace,
      agent: event.agent,
      conversation: event.conversation,
      durationMs: event.durationMs,
      requestChars: event.requestChars,
      responseChars: event.responseChars,
      citationCount: event.citationCount,
      attachmentCount: event.attachmentCount,
      attachmentBytes: event.attachmentBytes,
      ...(event.attachmentFailuresByStage && Object.keys(event.attachmentFailuresByStage).length
        ? { attachmentFailuresByStage: event.attachmentFailuresByStage }
        : {}),
      status: event.status,
      ...(event.errorCode ? { errorCode: event.errorCode } : {})
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await appendFile(path.join(this.directory, "audit.jsonl"), `${JSON.stringify(safe)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }
}
