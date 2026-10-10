import type { PartialResponse, SubmissionState } from "./errors.js";
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
  errorCode?: "downloads-disabled" | "host-not-allowed" | "download-failed" | "attachment-count-limit";
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
/** What reading a conversation found (m365_agent_session action=read). Reading sends nothing. */
export type ConversationReading = {
  /** Whether the last message AgentPickLink entered in the conversation is shown there as its latest
   * user message. `differs`: a user message appeared after it was entered but does not match it
   * (shown differently, or only part of it was sent). `not-shown`: it was not sent -- the send
   * control was never pressed, or the page kept the message in the composer and showed no new user
   * message, even after waiting the acknowledgement time again. `unconfirmed`: it is not shown, but
   * nothing shows it was not sent either (the page emptied the composer, or what it shows is
   * ambiguous): it may still appear. `none`: AgentPickLink has entered no message in this
   * conversation. Only `not-shown` means the message can be sent again. */
  message: "shown" | "differs" | "not-shown" | "unconfirmed" | "none";
  /** The request (requestId) of the ask that entered the message `message` describes. */
  messageRequestId?: string;
  /** The reply to the latest user message when the message is shown or differs: `complete`, still
   * `incomplete` when reading ended, or `none` (no reply started while reading). */
  reply: "complete" | "incomplete" | "none";
  /** reply=complete. */
  response?: Pick<AgentResponse, "text" | "citations" | "attachments" | "truncated" | "actionRequired">;
  /** reply=incomplete, when the reply showed any text. */
  partialResponse?: PartialResponse;
};
