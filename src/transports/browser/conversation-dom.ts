import type { TurnSnapshot } from "./turn-correlation.js";

export type ReplyAnchor = {
  documentId: string;
  conversationId?: string;
  userKey: string;
  responseKey: string;
};
export type TurnDomRegistry = {
  document: Document;
  documentId: string;
  key: (element: Element) => string;
  conversationId: () => string | undefined;
  response: (anchor: ReplyAnchor, selector: string) => HTMLElement | undefined;
};

/** Runs in the page. DOM identities stay in a WeakMap; no attributes or message text are written.
 * Stable, unique message IDs survive an in-document redraw. Node keys are diagnostic only:
 * virtual lists can recycle the same element for a different historical message. */
export function captureTurnDom(selectors: { user: string; assistant: string }): TurnSnapshot {
  const realm = globalThis as typeof globalThis & { __aplTurnDomV1?: TurnDomRegistry };
  let registry = realm.__aplTurnDomV1;
  if (!registry || registry.document !== document) {
    const keys = new WeakMap<Element, string>();
    let next = 0;
    const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
      value.toString(16)
    ).join("-");
    const roots = () =>
      Array.from(document.querySelectorAll(`${selectors.user}, ${selectors.assistant}`)).filter(
        (node) => !node.parentElement?.closest(`${selectors.user}, ${selectors.assistant}`)
      );
    const conversationId = () => {
      const region = document.querySelector('main, [role="main"]');
      if (!region) return undefined;
      const nodes = [
        region,
        ...Array.from(region.querySelectorAll("[data-conversation-id], [data-thread-id]"))
      ];
      const ids = new Set(
        nodes
          .filter((node) => !node.closest('nav, aside, [role="navigation"]'))
          .map((node) => node.getAttribute("data-conversation-id") || node.getAttribute("data-thread-id"))
          .filter((value): value is string => !!value)
      );
      return ids.size === 1 ? [...ids][0] : undefined;
    };
    const key = (node: Element) => {
      // Only explicit message identifiers: generic element IDs are often positional/reused.
      for (const attribute of ["data-message-id", "data-message-key"]) {
        const value = node.getAttribute(attribute);
        if (value) return `${attribute}:${value}`;
      }
      let value = keys.get(node);
      if (!value) {
        value = `node:${++next}`;
        keys.set(node, value);
      }
      return value;
    };
    registry = {
      document,
      documentId,
      key,
      conversationId,
      response: (anchor, selector) => {
        if (anchor.documentId !== documentId) return undefined;
        if (anchor.conversationId && anchor.conversationId !== conversationId()) return undefined;
        const messages = roots();
        const users = messages.filter((node) => node.matches(selectors.user));
        const user = users.at(-1);
        if (!user || key(user) !== anchor.userKey) return undefined;
        if (!user.hasAttribute("data-message-id") && !user.hasAttribute("data-message-key")) return undefined;
        if (messages.filter((node) => key(node) === anchor.userKey).length !== 1) return undefined;
        const replies = messages.slice(messages.indexOf(user) + 1);
        if (replies.length !== 1 || !replies[0]?.matches(selectors.assistant)) return undefined;
        const root = replies[0];
        if (key(root) !== anchor.responseKey) return undefined;
        if (!root.hasAttribute("data-message-id") && !root.hasAttribute("data-message-key")) return undefined;
        if (messages.filter((node) => key(node) === anchor.responseKey).length !== 1) return undefined;
        // Prefer the textual child inside M365's article, retaining the article as file scope.
        return (Array.from(root.querySelectorAll(selector)).at(-1) ??
          (root.matches(selector) ? root : undefined)) as HTMLElement | undefined;
      }
    };
    realm.__aplTurnDomV1 = registry;
  }
  const messages = Array.from(document.querySelectorAll(`${selectors.user}, ${selectors.assistant}`))
    .filter((node) => !node.parentElement?.closest(`${selectors.user}, ${selectors.assistant}`))
    .map((node) => ({
      key: registry.key(node),
      stable: !!(node.getAttribute("data-message-id") || node.getAttribute("data-message-key")),
      role: node.matches(selectors.user) ? ("user" as const) : ("assistant" as const)
    }));
  return { documentId: registry.documentId, conversationId: registry.conversationId(), messages };
}
