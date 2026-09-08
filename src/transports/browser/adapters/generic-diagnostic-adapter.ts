import { DomainError } from "../../../domain/errors.js";
import type { AdapterMatch } from "../ui-adapter.js";
import type { ConversationMarker, LocatorLike, PageLike, SubmissionMarker } from "../types.js";
import { BaseChatUiAdapter } from "./base-chat-adapter.js";

const CANNOT_SUBMIT_MESSAGE =
  "GENERIC_ADAPTER_CANNOT_SUBMIT: the diagnostic-only adapter can never locate, fill, or submit a composer, and can never create a conversation or capture a submission marker.";

/** Last-resort diagnostics only. It is structurally unable to locate, fill, or
 * submit a composer, and equally unable to create a conversation or capture a
 * submission marker: every method that clicks, fills, or prepares a send
 * fails closed with UNSUPPORTED_UI rather than falling through to the base
 * class's real UI-interaction logic. */
export class GenericDiagnosticAdapter extends BaseChatUiAdapter {
  constructor() {
    super({ id: "generic-diagnostic@1", surface: "m365-copilot", hostnames: [], diagnosticOnly: true });
  }
  async canHandle(_page: PageLike): Promise<AdapterMatch> {
    return { matched: true, confidence: "weak", reason: "diagnostic-only fallback" };
  }
  async findComposer(_page: PageLike): Promise<LocatorLike> {
    throw blocked();
  }
  async startNewConversation(_page: PageLike): Promise<void> {
    throw blocked();
  }
  async verifyNewConversation(
    _page: PageLike,
    _before: ConversationMarker
  ): Promise<{ verified: boolean; reason?: string }> {
    throw blocked();
  }
  async captureSubmissionMarker(
    _page: PageLike,
    _verifiedIdentityDigest?: string
  ): Promise<SubmissionMarker> {
    throw blocked();
  }
  async fillComposer(_page: PageLike, _message: string): Promise<void> {
    throw blocked();
  }
  async submitComposer(_page: PageLike): Promise<void> {
    throw blocked();
  }
}
function blocked(): DomainError {
  return new DomainError("UNSUPPORTED_UI", CANNOT_SUBMIT_MESSAGE);
}
