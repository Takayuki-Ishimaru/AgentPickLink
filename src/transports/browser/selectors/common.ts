/** Single module for structural (non-locale) DOM selectors. Locale-specific
 * accessible names live in ./en.js and ./ja.js; everything else that any
 * adapter needs to locate in a page.evaluate() browser-context body is
 * defined here so there is exactly one place to change a candidate selector. */
import { EN_TEXT } from "./en.js";
import { JA_TEXT } from "./ja.js";

/** Joins locale name patterns into one case-insensitive accessible-name matcher for
 * `page.getByRole(role, { name })`. Shared by every caller so a control is looked up the same
 * way in each locale. */
export function combinedPattern(patterns: readonly RegExp[]): RegExp {
  return new RegExp(patterns.map((pattern) => `(?:${pattern.source})`).join("|"), "i");
}
/** The stop-generating control, by accessible name, in every supported locale. Its presence is a
 * positive "the agent is still writing" signal for CompletionDetector. */
export const STOP_GENERATING_PATTERN = combinedPattern([
  ...JA_TEXT.stopGenerating,
  ...EN_TEXT.stopGenerating
]);
export const COMPOSER_SELECTORS = [
  'main [contenteditable="true"], [role="main"] [contenteditable="true"], main textarea, [role="main"] textarea, [data-testid*="chat" i] [contenteditable="true"], [data-testid*="chat" i] textarea'
] as const;
export const SEND_SELECTORS = [
  'main button[type="submit"]',
  '[role="main"] button[type="submit"]',
  'button[data-testid*="send" i]',
  'button[data-testid*="submit" i]',
  'button[aria-label="Send"]',
  'button[aria-label="Send message"]',
  'button[aria-label*="submit" i]',
  'button[aria-label*="送信"]',
  'button[title*="send" i]',
  'button[title*="送信"]'
] as const;
export const RESPONSE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-author="assistant"]',
  '[data-testid*="assistant" i]',
  '[role="article"].fai-CopilotMessage',
  '[role="article"].fai-CopilotMessage [data-testid="lastChatMessage"]',
  '[role="article"].fai-CopilotMessage [data-testid="markdown-reply"]'
] as const;
export const MAIN_REGION_SELECTOR = 'main, [role="main"]';
export const CONVERSATION_REGION_SELECTORS =
  '[role="feed"], [role="log"], [data-testid*="chat" i], [data-conversation-id], [data-thread-id], [data-message-author-role]';
export const IDENTITY_ROOT_SELECTOR =
  '[data-agent-id], [data-application-id], [data-testid*="agent" i], [aria-label*="agent" i]';
export const IDENTITY_HEADING_SELECTOR =
  'main h1, main h2, main h3, main [role="heading"], [role="main"] h1, [role="main"] h2, [role="main"] h3, [role="main"] [role="heading"]';
export const IDENTITY_LABEL_SELECTOR = "[aria-label]";
export const USER_MESSAGE_SELECTORS =
  '[data-message-author-role="user"], [data-author="user"], [data-testid*="user-message" i], [role="article"].fai-UserMessage';
export const ASSISTANT_MESSAGE_SELECTORS =
  '[data-message-author-role="assistant"], [data-author="assistant"], [data-testid*="assistant-message" i], [role="article"].fai-CopilotMessage';
export const CONVERSATION_ID_SELECTOR = "[data-conversation-id], [data-thread-id]";
/** UI-owned assistant header; deliberately separate from generated response content. */
export const M365_ASSISTANT_ARTICLE_SELECTOR = '.fai-CopilotMessage[role="article"]';
export const M365_ASSISTANT_AUTHOR_SELECTOR = ".fai-CopilotMessage__name";
export const M365_ASSISTANT_CONTENT_SELECTOR = ".fai-CopilotMessage__content";
