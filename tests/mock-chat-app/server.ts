import http from "node:http";
import { once } from "node:events";

export type MockChatMode =
  | "authenticated"
  | "unauthenticated"
  | "wrong-agent"
  | "identity-change"
  | "multiple-composers"
  | "disabled-controls"
  | "new-conversation-failure"
  | "streaming"
  | "stop-control-stream"
  | "citations"
  | "action-controls"
  | "delayed"
  | "partial-timeout"
  | "crash-before-submit"
  | "crash-after-submit"
  | "duplicate-send"
  | "ack-absent"
  | "send-noop"
  | "ack-ambiguous";

export type MockChatLocale = "ja" | "en";
/** How the landing page exposes the rest of the catalogue: an all-agents control (button or menu
 * item) that reveals the hidden row in place, or -- like Microsoft 365 -- a plain link to the store
 * page (`page`). */
export type MockStoreRole = "button" | "menuitem" | "page";
export type MockChatSurface = "m365-copilot" | "teams-web";
export type MockAgent = { id: string; name: string; description?: string };

export const SESSION_COOKIE = "mock-session";
/** Rows the landing page's sidebar renders. The last one is revealed by the "all agents" control. */
export const MOCK_SIDEBAR_AGENTS: MockAgent[] = [
  { id: "agent-requirements", name: "Requirements Agent", description: "Requirements analysis" },
  { id: "agent-architecture", name: "Architecture Agent", description: "Architecture review" }
];
export const MOCK_STORE_AGENT: MockAgent = { id: "agent-store-only", name: "Store Only Agent" };
/** Only rendered once the agent rail has actually been scrolled, like a virtualized tenant list. */
export const MOCK_LAZY_AGENT: MockAgent = { id: "agent-lazy", name: "Lazy Agent" };
/**
 * The agent store (`/chat/agentstore`): cards without links, each resolving differently -- an id
 * in the card's own attribute, a card that navigates to the chat, a details dialog carrying a
 * link, a details dialog offering only "開く" (plus an "追加" that must never be pressed), and a
 * card revealed only by the store's "表示を増やす" control.
 */
export const MOCK_STORE_CATALOG: MockAgent[] = [
  { id: "agent-store-attr", name: "Attribute Agent", description: "Id in an attribute" },
  { id: "agent-store-nav", name: "Navigating Agent", description: "Opens the chat on click" },
  { id: "agent-store-dialog", name: "Dialog Agent", description: "Details dialog with a link" },
  { id: "agent-store-open", name: "Open Agent", description: "Details dialog with an open control" },
  { id: "agent-store-more", name: "Paged Agent", description: "Behind show more" },
  { id: "agent-store-spa", name: "Router Agent", description: "Router push, no page load" }
];
/** File-hosting links the landing page carries, used as `suggestedDownloadHosts` candidates. */
export const MOCK_FILE_LINKS = [
  "https://contoso.sharepoint.com/sites/x",
  "https://contoso-my.sharepoint.com/personal/y"
];

const STRINGS: Record<
  MockChatLocale,
  {
    lang: string;
    title: string;
    signIn: string;
    newChat: string;
    composer: string;
    send: string;
    stopGenerating: string;
    approve: string;
    allAgents: string;
    /** The screen-reader-only keyboard hint a rail row carries right after the agent's name. */
    rowHint: string;
    pin: string;
    moreOptions: string;
  }
> = {
  ja: {
    lang: "ja",
    title: "Microsoft 365",
    signIn: "サインイン",
    newChat: "新しいチャット",
    composer: "プロンプトを入力",
    send: "送信",
    stopGenerating: "生成を停止",
    approve: "承認",
    allAgents: "すべてのエージェント",
    rowHint: "Tab キーを押して [ピン留め]、[その他のオプション] ボタンにアクセスします。",
    pin: "ピン留め",
    moreOptions: "その他のオプション"
  },
  en: {
    lang: "en",
    title: "Microsoft 365",
    signIn: "Sign in",
    newChat: "New chat",
    composer: "Type a message",
    send: "Send",
    stopGenerating: "Stop generating",
    approve: "Approve",
    allAgents: "すべてのエージェント",
    rowHint: "Press Tab to access the Pin and More options buttons",
    pin: "Pin",
    moreOptions: "More options"
  }
};

export interface MockChatApp {
  origin: string;
  /** The same server reached through the other loopback name, used as a stand-in "login host":
   * `localhost` and `127.0.0.1` are distinct hostnames to the navigation policy. */
  authOrigin: string;
  /** Makes every sign-in page complete by itself, as `?auto=1` does, for unattended tests. */
  setAutoSignIn(value: boolean): void;
  /** Store controls that discovery must never press ("追加", a card's overflow menu) navigate to a
   * recording route; every hit lands here. Empty means nothing forbidden was clicked. */
  storeViolations(): string[];
  close(): Promise<void>;
}

/** Stateful-looking local UI fixture. Production navigation policy never permits this host. */
export async function startMockChatApp(
  options: { autoSignIn?: boolean; port?: number; persistentSession?: boolean } = {}
): Promise<MockChatApp> {
  let autoSignIn = options.autoSignIn === true;
  let boundPort = 0;
  const violations: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const locale = localeOf(url);
    const surface = surfaceOf(url);
    const signedIn = hasSession(request.headers.cookie);

    if (url.pathname === "/signin") {
      const auto = autoSignIn || url.searchParams.get("auto") === "1";
      html(response, renderSignIn(locale, auto, safeNext(url.searchParams.get("next"))));
      return;
    }
    if (url.pathname === "/signin/complete") {
      response.writeHead(302, {
        location: safeNext(url.searchParams.get("next")),
        "set-cookie": `${SESSION_COOKIE}=1; Path=/; ${options.persistentSession === false ? "" : "Max-Age=3600; "}HttpOnly; SameSite=Lax`
      });
      response.end();
      return;
    }
    // Microsoft 365 hands off to the login host even with a valid session and completes the
    // handshake client-side, well after domcontentloaded. These two routes reproduce exactly that.
    if (url.pathname === "/chat/silentauth") {
      // `stuck=1` hands off to a login page that never comes back, i.e. sign-in really is needed.
      const target =
        url.searchParams.get("stuck") === "1"
          ? `http://localhost:${boundPort}/signin`
          : `http://localhost:${boundPort}/authbounce`;
      response.writeHead(302, { location: target });
      response.end();
      return;
    }
    if (url.pathname === "/authbounce") {
      html(response, renderAuthBounce(`http://127.0.0.1:${boundPort}/chat`));
      return;
    }
    // The real application answers on the application host with its shell whatever the session
    // state is, and only decides client-side, after load, whether to render the chat or to hand
    // off to the login host. Judging the shell on arrival reports a valid session as "unknown";
    // this route reproduces exactly that. `stuck=1` sends a signed-out visitor to a login page
    // that never comes back (the probe's "did not persist" case); otherwise the same-host sign-in
    // page is used so the interactive window can complete the round trip.
    if (url.pathname === "/chat/spa") {
      const signInTarget =
        url.searchParams.get("stuck") === "1"
          ? `http://localhost:${boundPort}/signin`
          : `/signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
      html(
        response,
        renderSpaShell(locale, surface, signedIn, shellDelayOf(url), signInTarget, storeRoleOf(url))
      );
      return;
    }
    if (url.pathname === "/chat/agentstore") {
      if (!signedIn) {
        response.writeHead(302, { location: `/signin?next=${encodeURIComponent("/chat/agentstore")}` });
        response.end();
        return;
      }
      html(response, renderStore(locale, surface, storeHintOf(url)));
      return;
    }
    if (url.pathname === "/store/violation") {
      violations.push(url.searchParams.get("what") ?? "unknown");
      html(response, `<!doctype html><html lang="ja"><body><h1>forbidden control pressed</h1></body></html>`);
      return;
    }
    if (url.pathname === "/logout") {
      response.writeHead(302, {
        location: "/signin",
        "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
      });
      response.end();
      return;
    }

    const directAgentId = /^\/chat\/agent\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (directAgentId) {
      if (url.searchParams.get("requireSession") === "1" && !signedIn) {
        response.writeHead(302, {
          location: `/signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`
        });
        response.end();
        return;
      }
      const id = decodeURIComponent(directAgentId);
      const known = [...MOCK_SIDEBAR_AGENTS, MOCK_STORE_AGENT, MOCK_LAZY_AGENT, ...MOCK_STORE_CATALOG].find(
        (agent) => agent.id === id
      );
      if (!known) {
        notFound(response);
        return;
      }
      const mode = (url.searchParams.get("mode") ?? "authenticated") as MockChatMode;
      html(response, render(mode, locale, surface, known));
      return;
    }

    if (url.pathname !== "/chat") {
      notFound(response);
      return;
    }
    const requestedMode = url.searchParams.get("mode");
    if (!requestedMode) {
      // The session-gated landing page: the entry point of the redesigned setup flow.
      if (!signedIn) {
        const next = `${url.pathname}${url.search}`;
        response.writeHead(302, { location: `/signin?next=${encodeURIComponent(next)}` });
        response.end();
        return;
      }
      html(response, renderLanding(locale, surface, storeRoleOf(url), storeHintOf(url)));
      return;
    }
    html(response, render(requestedMode as MockChatMode, locale, surface));
  });
  server.listen(options.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MOCK_CHAT_START_FAILED");
  boundPort = address.port;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    authOrigin: `http://localhost:${address.port}`,
    setAutoSignIn: (value: boolean) => {
      autoSignIn = value;
    },
    storeViolations: () => [...violations],
    close: async () => {
      server.close();
      await once(server, "close");
    }
  };
}

function html(response: http.ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}
function notFound(response: http.ServerResponse): void {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
}
function hasSession(cookie: string | undefined): boolean {
  return (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .includes(`${SESSION_COOKIE}=1`);
}
/** Only same-site absolute paths are ever used as a redirect target. */
function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/chat";
  return value;
}
function localeOf(url: URL): MockChatLocale {
  return url.searchParams.get("locale") === "en" ? "en" : "ja";
}
function surfaceOf(url: URL): MockChatSurface {
  return url.searchParams.get("surface") === "teams-web" ? "teams-web" : "m365-copilot";
}
/** Microsoft 365 has shipped the "all agents" disclosure as a button and as a menu item. */
function storeRoleOf(url: URL): MockStoreRole {
  if (url.searchParams.get("store") === "page") return "page";
  return url.searchParams.get("storeRole") === "menuitem" ? "menuitem" : "button";
}
/** Whether the store marks the cards that open an agent with Microsoft 365's accessible hint
 * (`storeHint=1` on the landing URL, which then links to `/chat/agentstore?hint=1`). */
function storeHintOf(url: URL): boolean {
  return url.searchParams.get("storeHint") === "1" || url.searchParams.get("hint") === "1";
}
/** How long the application-host shell stays empty before it renders or hands off (0-5000 ms). */
function shellDelayOf(url: URL): number {
  const value = Number(url.searchParams.get("delayMs") ?? 800);
  return Number.isFinite(value) ? Math.min(5_000, Math.max(0, Math.floor(value))) : 800;
}
/** Avatar initials, the way Fluent renders them when an agent has no icon image. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Deliberately carries no chat structure, so AuthDetector reports "sign-in-required". */
function renderSignIn(locale: MockChatLocale, auto: boolean, next: string): string {
  const t = STRINGS[locale];
  const completion = `/signin/complete?next=${encodeURIComponent(next)}`;
  return `<!doctype html>
<html lang="${t.lang}"><head><meta charset="utf-8"><title>Sign in</title></head>
<body>
  <h1>サインイン</h1>
  <p>Sign in to Microsoft 365</p>
  <button type="button" id="signin">${t.signIn}</button>
  <script>
    const complete = () => { location.href = ${JSON.stringify(completion)}; };
    document.getElementById('signin').addEventListener('click', complete);
    if (${JSON.stringify(auto)}) setTimeout(complete, 300);
  </script>
</body></html>`;
}

/**
 * The login host mid-bounce: no chat structure and a sign-in heading, so judging the state here
 * (instead of waiting for the landing) would report a perfectly valid session as "sign in
 * required". The hand-back happens after load, exactly as Microsoft 365's auto-POST does.
 */
function renderAuthBounce(target: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>Signing in</title></head>
<body>
  <h1>サインイン</h1>
  <p>Completing sign-in</p>
  <script>setTimeout(() => { location.href = ${JSON.stringify(target)}; }, 700);</script>
</body></html>`;
}

/**
 * The application-host shell before the application has rendered: authenticated-looking marker
 * text ("Microsoft 365 Copilot") but no main region and no composer, so AuthDetector reports
 * "unknown". After `delayMs` it either renders the landing page in place (document.write keeps the
 * URL, exactly like a single-page application taking over its own shell) or leaves for the sign-in
 * target.
 */
function renderSpaShell(
  locale: MockChatLocale,
  surface: MockChatSurface,
  signedIn: boolean,
  delayMs: number,
  signInTarget: string,
  storeRole: MockStoreRole
): string {
  // The landing document carries its own <script>; "</" must not terminate this one early.
  const landing = JSON.stringify(renderLanding(locale, surface, storeRole)).replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="${STRINGS[locale].lang}"><head><meta charset="utf-8"><title>Microsoft 365 Copilot</title></head>
<body>
  <h1>Microsoft 365 Copilot</h1>
  <p>読み込んでいます</p>
  <script>
    setTimeout(() => {
      if (${JSON.stringify(signedIn)}) {
        document.open();
        document.write(${landing});
        document.close();
      } else {
        location.href = ${JSON.stringify(signInTarget)};
      }
    }, ${delayMs});
  </script>
</body></html>`;
}

/**
 * The signed-in landing page: ordinary chat plus the agent sidebar discovery reads. The rail is
 * deliberately short and scrollable, and one row is appended only on its first real `scroll`
 * event, so discovery's rail hydration is exercised the way a virtualized tenant list behaves.
 */
function renderLanding(
  locale: MockChatLocale,
  surface: MockChatSurface,
  storeRole: MockStoreRole = "button",
  storeHinted = false
): string {
  const t = STRINGS[locale];
  // Rows are shaped like Microsoft 365's rail items: the stable id on a wrapper, the name as the
  // link's visible text between an avatar (initials in a role="img" span) and a screen-reader-only
  // keyboard hint (clipped to one pixel, no separator after the name -- concatenated, the row's text
  // reads "Requirements AgentTab キーを押して…"), then icon-only pin / overflow buttons. There is no
  // data-agent-name: discovery has to read the name a sighted user sees.
  const row = (agent: MockAgent, hidden: boolean) =>
    `<div class="agent-row"${hidden ? " hidden" : ""} id="row-${agent.id}" data-agent-id="${agent.id}" data-nav-item-action-row-scope=""${agent.description ? ` data-agent-description="${escapeHtml(agent.description)}"` : ""}>
      <a href="/chat/agent/${agent.id}"><span role="img" class="avatar" aria-label="${escapeHtml(agent.name)}">${escapeHtml(initials(agent.name))}</span><span class="name">${escapeHtml(agent.name)}</span><span class="sr-only">${escapeHtml(t.rowHint)}</span></a>
      <button type="button" aria-label="${escapeHtml(t.pin)}"><svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></button>
      <button type="button" aria-label="${escapeHtml(t.moreOptions)}" data-testid="agent-item-more-options"><span aria-hidden="true">…</span></button>
    </div>`;
  const storeControl =
    storeRole === "page"
      ? `<a href="/chat/agentstore${storeHinted ? "?hint=1" : ""}" id="other-agents">その他のエージェント</a>`
      : storeRole === "menuitem"
        ? `<a role="menuitem" tabindex="0" id="all-agents">${t.allAgents}</a>`
        : `<button type="button" id="all-agents">${t.allAgents}</button>`;
  return `<!doctype html>
<html lang="${t.lang}"><head><meta charset="utf-8"><title>Microsoft 365 Copilot</title>
<style>
  /* A short, genuinely scrollable rail. The hidden attribute keeps winning over the row display
     rule, so a revealed row is the only thing the "all agents" control changes. */
  #agent-rail { display: block; max-height: 32px; overflow-y: auto; }
  #agent-rail .agent-row { display: flex; align-items: center; gap: 4px; }
  #agent-rail .agent-row[hidden] { display: none; }
  #agent-rail .avatar { display: inline-flex; width: 14px; height: 14px; font-size: 7px; }
  #agent-rail button { padding: 0; border: 0; background: none; line-height: 1; }
  /* The visually-hidden idiom screen-reader hints use: still in the accessibility tree and in
     textContent, clipped to a single pixel on screen. */
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style></head>
<body>
  <nav aria-label="Agents" id="agent-rail">
    ${MOCK_SIDEBAR_AGENTS.map((agent) => row(agent, false)).join("\n    ")}
    ${row(MOCK_STORE_AGENT, true)}
    ${storeControl}
  </nav>
  <footer>
    ${MOCK_FILE_LINKS.map((href) => `<a href="${href}">${escapeHtml(new URL(href).hostname)}</a>`).join("\n    ")}
  </footer>
  <main role="main" data-surface="${surface}">
    <h1>Microsoft 365 Copilot</h1>
    <button type="button" aria-label="${t.newChat}" id="new-chat">${t.newChat}</button>
    <section role="log" data-testid="chat-region" data-conversation-id="conversation-landing" id="messages"></section>
    <textarea aria-label="${t.composer}" data-testid="chat-composer" id="composer"></textarea>
    <button type="submit" aria-label="${t.send}" id="send">${t.send}</button>
  </main>
  <script>
    document.getElementById('all-agents')?.addEventListener('click', () => {
      document.getElementById('row-${MOCK_STORE_AGENT.id}').removeAttribute('hidden');
    });
    const rail = document.getElementById('agent-rail');
    let hydrated = false;
    rail.addEventListener('scroll', () => {
      if (hydrated) return;
      hydrated = true;
      const lazy = document.createElement('a');
      lazy.className = 'agent-row';
      lazy.id = 'row-${MOCK_LAZY_AGENT.id}';
      lazy.href = '/chat/agent/${MOCK_LAZY_AGENT.id}';
      lazy.dataset.agentId = ${JSON.stringify(MOCK_LAZY_AGENT.id)};
      lazy.dataset.agentName = ${JSON.stringify(MOCK_LAZY_AGENT.name)};
      lazy.textContent = ${JSON.stringify(MOCK_LAZY_AGENT.name)};
      rail.append(lazy);
    });
    document.getElementById('new-chat').addEventListener('click', () => {
      const messages = document.getElementById('messages');
      messages.dataset.conversationId = 'conversation-' + Math.random().toString(36).slice(2);
      messages.replaceChildren();
    });
  </script>
</body></html>`;
}

/**
 * The agent store, shaped like Microsoft 365's: the rail (so strategy A sees the same rows again),
 * then `role="list"` groups of cards -- buttons named after the agent followed by its description,
 * each with an overflow-menu button that must never be pressed. See `MOCK_STORE_CATALOG` for how
 * each card resolves. "追加" and the overflow menus record a violation instead of doing anything.
 * With `hinted`, the cards whose click opens an agent carry Microsoft 365's accessible hint
 * (`aria-description`), the way the real store marks the account's added agents; discovery then
 * clicks only those and skips the dialog flavours.
 */
function renderStore(locale: MockChatLocale, surface: MockChatSurface, hinted = false): string {
  const t = STRINGS[locale];
  const [attr, nav, dialog, open, more, spa] = MOCK_STORE_CATALOG as [
    MockAgent,
    MockAgent,
    MockAgent,
    MockAgent,
    MockAgent,
    MockAgent
  ];
  const hint = hinted ? ` aria-description="Enter キーを押してエージェントを開く"` : "";
  const card = (agent: MockAgent, extra = "", hidden = false) =>
    `<div role="listitem"${hidden ? " hidden" : ""} id="item-${agent.id}">
      <button type="button" class="card" data-card="${agent.id}"${extra}><span data-testid="agent-icon"></span><span class="name">${escapeHtml(agent.name)}</span><span class="desc">${escapeHtml(agent.description ?? "")}</span></button>
      <button type="button" aria-label="その他のオプション" data-testid="agent-item-more-options" data-card-menu="${agent.id}">…</button>
    </div>`;
  const rows = MOCK_SIDEBAR_AGENTS.map(
    (agent) =>
      `<a class="agent-row" id="row-${agent.id}" href="/chat/agent/${agent.id}" data-agent-id="${agent.id}" data-agent-name="${escapeHtml(agent.name)}">${escapeHtml(agent.name)}</a>`
  ).join("\n    ");
  return `<!doctype html>
<html lang="${t.lang}"><head><meta charset="utf-8"><title>Microsoft 365 Copilot</title>
<style>[hidden] { display: none !important; } [role="dialog"] { border: 1px solid; padding: 8px; }</style></head>
<body>
  <nav aria-label="Agents" id="agent-rail">
    ${rows}
    <a href="/chat/agentstore" id="other-agents">その他のエージェント</a>
  </nav>
  <main role="main" data-surface="${surface}">
    <h1>Microsoft 365 Copilot</h1>
    <div role="list" aria-label="おすすめ">
      ${card(attr, ` data-agent-id="${attr.id}" data-agent-name="${escapeHtml(attr.name)}"${hint}`)}
      ${card(nav, hint)}
      ${card(more, hint, true)}
      <button type="button" id="show-more">表示を増やす</button>
    </div>
    <div role="list" aria-label="組織">
      ${card(dialog)}
      ${card(open)}
      ${card(spa, hint)}
    </div>
    <div role="dialog" id="dialog" aria-label="エージェントの詳細" hidden>
      <h2 id="dialog-title"></h2>
      <a id="dialog-link" href="/chat" hidden>チャットを見る</a>
      <button type="button" id="dialog-open" hidden>開く</button>
      <button type="button" id="dialog-add">追加</button>
      <button type="button" id="dialog-close">閉じる</button>
    </div>
  </main>
  <script>
    const violation = (what) => { location.href = '/store/violation?what=' + encodeURIComponent(what); };
    const dialog = document.getElementById('dialog');
    const showDialog = (agentId, name, withLink, withOpen) => {
      document.getElementById('dialog-title').textContent = name;
      const link = document.getElementById('dialog-link');
      link.hidden = !withLink;
      // Only the "link" flavour carries the agent anywhere in the dialog's DOM; the "open" flavour
      // must be resolved through its 開く control alone.
      link.href = withLink ? '/chat/agent/' + agentId : '/chat';
      const open = document.getElementById('dialog-open');
      open.hidden = !withOpen;
      open.onclick = () => { location.href = '/chat/agent/' + agentId; };
      dialog.hidden = false;
    };
    document.querySelector('[data-card="${nav.id}"]').addEventListener('click', () => { location.href = '/chat/agent/${nav.id}'; });
    document.querySelector('[data-card="${more.id}"]').addEventListener('click', () => { location.href = '/chat/agent/${more.id}'; });
    document.querySelector('[data-card="${attr.id}"]').addEventListener('click', () => { location.href = '/chat/agent/${attr.id}'; });
    // A single-page router: the URL changes without a load, and history.back() restores the store.
    document.querySelector('[data-card="${spa.id}"]').addEventListener('click', () => { history.pushState({}, '', '/chat/agent/${spa.id}/conversation/new'); });
    document.querySelector('[data-card="${dialog.id}"]').addEventListener('click', () => showDialog('${dialog.id}', ${JSON.stringify(dialog.name)}, true, false));
    document.querySelector('[data-card="${open.id}"]').addEventListener('click', () => showDialog('${open.id}', ${JSON.stringify(open.name)}, false, true));
    for (const menu of document.querySelectorAll('[data-card-menu]')) menu.addEventListener('click', () => violation('more-options:' + menu.dataset.cardMenu));
    document.getElementById('dialog-add').addEventListener('click', () => violation('add'));
    document.getElementById('dialog-close').addEventListener('click', () => { dialog.hidden = true; });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') dialog.hidden = true; });
    document.getElementById('show-more').addEventListener('click', () => {
      document.getElementById('item-${more.id}').removeAttribute('hidden');
      document.getElementById('show-more').hidden = true;
    });
  </script>
</body></html>`;
}

function render(
  mode: MockChatMode,
  locale: MockChatLocale = "ja",
  surface: MockChatSurface = "m365-copilot",
  agent?: MockAgent
): string {
  const t = STRINGS[locale];
  if (mode === "unauthenticated")
    return `<!doctype html><html lang="${t.lang}"><body><main><h1>${t.title}</h1><a href="/signin?locale=${locale}&surface=${surface}">${t.signIn}</a></main></body></html>`;
  const name = agent?.name ?? (mode === "wrong-agent" ? "Wrong Agent" : "Requirements Agent");
  const agentId = agent?.id ?? "agent-requirements";
  const disabled = mode === "disabled-controls" ? " disabled" : "";
  const extraComposer =
    mode === "multiple-composers" ? `<textarea aria-label="${t.composer}"></textarea>` : "";
  // A direct agent route names the agent in the composer placeholder, exactly like M365 does.
  const placeholder = agent ? ` placeholder="${escapeHtml(`${name} にメッセージを送信`)}"` : "";
  return `<!doctype html>
<html lang="${t.lang}"><head><meta charset="utf-8"><title>Mock M365 agent chat</title></head>
<body>
  <main role="main" data-surface="${surface}">
    <header data-testid="agent-header" data-agent-id="${agentId}" data-agent-name="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">${escapeHtml(name)}</header>
    <button type="button" aria-label="${t.newChat}" id="new-chat">${t.newChat}</button>
    <section role="log" data-testid="chat-region" data-conversation-id="conversation-existing" id="messages">
      <article data-message-author-role="user">previous question</article>
      <article data-message-author-role="assistant">previous answer</article>
    </section>
    <textarea aria-label="${t.composer}"${placeholder} data-testid="chat-composer" id="composer"${disabled}></textarea>
    ${extraComposer}
    <button type="submit" aria-label="${t.send}" id="send"${disabled}>${t.send}</button>
  </main>
  <script>
    const mode = ${JSON.stringify(mode)};
    const stopGeneratingLabel = ${JSON.stringify(t.stopGenerating)};
    const approveLabel = ${JSON.stringify(t.approve)};
    const messages = document.getElementById('messages');
    const composer = document.getElementById('composer');
    const send = document.getElementById('send');
    const header = document.querySelector('[data-agent-id]');
    composer.addEventListener('input', () => {
      if (mode === 'identity-change') {
        header.dataset.agentId = 'agent-other';
        header.dataset.agentName = 'Other Agent';
        header.setAttribute('aria-label', 'Other Agent');
        header.textContent = 'Other Agent';
      }
    });
    document.getElementById('new-chat').addEventListener('click', () => {
      if (mode === 'new-conversation-failure') return;
      messages.dataset.conversationId = 'conversation-' + Math.random().toString(36).slice(2);
      messages.replaceChildren();
    });
    send.addEventListener('click', () => {
      // The send control does nothing at all: the composer keeps the prompt, which is the only
      // positive "this was not sent" signal.
      if (mode === 'send-noop') return;
      if (mode === 'crash-before-submit') { location.href = 'about:blank'; return; }
      const value = composer.value;
      if (mode !== 'ack-absent') append('user', mode === 'ack-ambiguous' ? value + ' changed' : value);
      if (mode === 'ack-ambiguous' || mode === 'duplicate-send') append('user', value);
      composer.value = '';
      if (mode === 'crash-after-submit') { setTimeout(() => { location.href = 'about:blank'; }, 0); return; }
      const delay = mode === 'delayed' ? 500 : 10;
      setTimeout(() => respond(), delay);
    });
    function append(role, text) {
      const node = document.createElement('article');
      node.dataset.messageAuthorRole = role;
      node.textContent = text;
      messages.append(node);
      return node;
    }
    function respond() {
      const node = append('assistant', '');
      if (mode === 'partial-timeout') { node.dataset.streaming = 'true'; node.textContent = 'partial answer'; return; }
      if (mode === 'stop-control-stream') {
        // The only streaming evidence is a stop-generating control identified by its accessible
        // name: no data-streaming attribute, no aria-busy, and no visible label text.
        const stop = document.createElement('button');
        stop.setAttribute('aria-label', stopGeneratingLabel);
        node.append(stop);
        node.prepend(document.createTextNode('stream 1'));
        let part = 1;
        const timer = setInterval(() => {
          part++;
          node.firstChild?.remove();
          node.prepend(document.createTextNode('stream ' + part));
          if (part === 4) { clearInterval(timer); stop.remove(); }
        }, 150);
        return;
      }
      if (mode === 'streaming') {
        node.dataset.streaming = 'true';
        const stop = document.createElement('button'); stop.setAttribute('aria-label', stopGeneratingLabel); stop.textContent = stopGeneratingLabel; node.append(stop);
        let part = 0; const timer = setInterval(() => { part++; node.firstChild?.remove(); node.prepend(document.createTextNode('stream ' + part)); if (part === 3) { clearInterval(timer); delete node.dataset.streaming; stop.remove(); } }, 20);
        return;
      }
      node.innerHTML = mode === 'citations' ? 'answer <a href="https://example.test/source#part">Source</a>' : 'answer';
      if (mode === 'action-controls') { const action = document.createElement('button'); action.textContent = approveLabel; node.append(action); }
    }
  </script>
</body></html>`;
}
