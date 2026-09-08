import type { SubmissionState } from "./errors.js";
export type AgentCitation = {
  index?: number;
  marker?: string;
  title?: string;
  url?: string;
  source?: string;
};
export type AgentAttachment = {
  index: number;
  name: string;
  mediaType: string;
  sourceUrl: string;
  status: "saved" | "not-saved";
  localPath?: string;
  sizeBytes?: number;
  sha256?: string;
  errorCode?: "downloads-disabled" | "host-not-allowed" | "download-failed";
  /** Which candidate shape produced this attachment: a plain URL-based candidate found in the
   * response text, a completed-response download control, or a file card. Metadata only -- never
   * affects behaviour, just lets a failure be told apart by acquisition path. */
  kind?: "url" | "download-control" | "file-card";
  /** For not-saved attachments: the acquisition stage that failed (metadata only, e.g.
   * "card-missing", "control-not-visible", "http-rejected", "sso-retry-failed"), so a UI change
   * can be told apart from a download error. */
  stage?: string;
};
export type AgentResponse = {
  agent: string;
  conversationHandle: string;
  text: string;
  citations: AgentCitation[];
  attachments: AgentAttachment[];
  elapsedMs: number;
  truncated: boolean;
  actionRequired: boolean;
  submissionState: Extract<SubmissionState, "sent">;
  sourceType: "m365-agent";
};
