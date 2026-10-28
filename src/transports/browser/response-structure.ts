import type { TurnDomRegistry } from "./conversation-dom.js";
import type { PageLike } from "./types.js";
import { ASSISTANT_MESSAGE_SELECTORS, USER_MESSAGE_SELECTORS } from "./selectors/common.js";

/** Observe only new, visible prose after the acknowledged question. Existing page furniture,
 * controls and progress regions do not imply a changed answer UI. DOM text never leaves the page. */
export async function responseStructure(page: PageLike, userKey?: string) {
  try {
    return await page.evaluate?.<{ elements: number; chars: number } | undefined>(
      (args: { user: string; assistant: string; userKey?: string }) => {
        const realm = globalThis as typeof globalThis & {
          __aplTurnDomV1?: TurnDomRegistry;
          __aplResponseStructureV1?: WeakSet<Element>;
        };
        const main = document.querySelector('main, [role="main"]');
        if (!main) return undefined;
        if (!args.userKey) {
          realm.__aplResponseStructureV1 = new WeakSet(main.querySelectorAll("*"));
          return undefined;
        }
        const baseline = realm.__aplResponseStructureV1;
        const user = Array.from(main.querySelectorAll(args.user)).at(-1);
        if (!baseline || !user || realm.__aplTurnDomV1?.key(user) !== args.userKey) return undefined;
        const region =
          user.parentElement?.closest(
            '[role="feed"], [role="log"], [data-conversation-id], [data-thread-id]'
          ) ?? main;
        const ignored = `${args.user}, ${args.assistant}, nav, aside, form, button, textarea, input, [contenteditable], [role="status"], [role="progressbar"], [role="alert"], [role="navigation"], [aria-busy="true"], [data-streaming="true"]`;
        let elements = 0;
        let chars = 0;
        for (const node of region.querySelectorAll(
          'div, p, pre, table, article, [role="article"], [data-message-id]'
        )) {
          if (
            baseline.has(node) ||
            node.closest(ignored) ||
            node.querySelector(ignored) ||
            node.contains(user)
          )
            continue;
          if (!(user.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          const element = node as HTMLElement;
          const style = getComputedStyle(element);
          if (!element.getClientRects().length || style.visibility === "hidden" || style.display === "none")
            continue;
          // A short status or placeholder is insufficient evidence, even if it lacks a status role.
          const length = element.innerText?.trim().length ?? 0;
          if (length < 80) continue;
          elements++;
          chars = Math.max(chars, length);
        }
        return { elements, chars };
      },
      { user: USER_MESSAGE_SELECTORS, assistant: ASSISTANT_MESSAGE_SELECTORS, userKey }
    );
  } catch {
    return undefined;
  }
}
