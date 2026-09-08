import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "../../src/domain/progress.js";
import { AgentDiscovery, stripKeyboardHint } from "../../src/transports/browser/agent-discovery.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { AuthDetector } from "../../src/transports/browser/auth-detector.js";
import { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import type { BrowserContextLike, LocatorLike, PageLike } from "../../src/transports/browser/types.js";

const LANDING = "https://m365.example.test/chat";
const AUTHENTICATED_BODY = "Microsoft 365 Copilot 新しいチャット";

type SidebarRow = { id?: string; name?: string; description?: string };
type LinkRow = { href?: string; name?: string };

describe("AgentDiscovery", () => {
  it("merges sidebar rows and direct links, keeping one candidate per stable agent id", async () => {
    const events: ProgressEvent[] = [];
    const { discovery } = await makeDiscovery({
      sidebar: () => [
        { id: "agent-requirements", name: "Requirements Agent", description: "Requirements analysis" },
        { id: "agent-architecture", name: "Architecture Agent" }
      ],
      links: () => [
        { href: "https://m365.example.test/chat/agent/agent-requirements", name: "Requirements Agent" },
        { href: "https://m365.example.test/chat/agent/agent-unpinned", name: "Unpinned Agent" },
        { href: "https://m365.example.test/chat", name: "Chat" },
        { href: "https://evil.example.net/chat/agent/agent-evil", name: "Evil Agent" }
      ]
    });

    const result = await discovery.discover(5_000, (event) => events.push(event));

    expect(result.agents).toEqual([
      {
        url: "https://m365.example.test/chat/agent/agent-requirements",
        surface: "m365-copilot",
        displayName: "Requirements Agent",
        stableAgentId: "agent-requirements",
        description: "Requirements analysis",
        source: "sidebar"
      },
      {
        url: "https://m365.example.test/chat/agent/agent-architecture",
        surface: "m365-copilot",
        displayName: "Architecture Agent",
        stableAgentId: "agent-architecture",
        description: undefined,
        source: "sidebar"
      },
      {
        url: "https://m365.example.test/chat/agent/agent-unpinned",
        surface: "m365-copilot",
        displayName: "Unpinned Agent",
        stableAgentId: "agent-unpinned",
        source: "link"
      }
    ]);
    expect(result.landingUrl).toBe(LANDING);
    expect(events.some((event) => event.phase === "discovering")).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: "done", total: 3 });
  });

  it("reports metadata-only per-strategy counts so an empty result can be diagnosed", async () => {
    const { discovery } = await makeDiscovery({
      // Twelve rows are visible; ten of them are unusable (generic or nameless).
      sidebar: () => [
        ...Array.from({ length: 10 }, (_, index) => ({ id: `agent-${index}`, name: "Copilot" })),
        { id: "agent-requirements", name: "Requirements Agent" },
        { id: "agent-architecture", name: "Architecture Agent" }
      ],
      links: () => [{ href: "https://m365.example.test/chat", name: "Chat" }]
    });

    const result = await discovery.discover(5_000);

    expect(result.warnings).toContain("sidebar:12/2 link:1/0 scroll:0 store:unavailable");
  });

  it("excludes generic Copilot names, nameless rows and overlong names", async () => {
    const { discovery } = await makeDiscovery({
      sidebar: () => [
        { id: "agent-generic", name: "Copilot" },
        { id: "agent-shell", name: "" },
        { id: "agent-long", name: "x".repeat(161) },
        { id: "agent-real", name: "Real Agent" }
      ],
      links: () => []
    });
    const result = await discovery.discover(5_000);
    expect(result.agents.map((agent) => agent.stableAgentId)).toEqual(["agent-real"]);
  });

  it("keeps only the agent's name when a row's text carries Microsoft 365's screen-reader keyboard hint", async () => {
    const hint = "Tab キーを押して [ピン留め]、[その他のオプション] ボタンにアクセスします。";
    const { discovery } = await makeDiscovery({
      sidebar: () => [
        // The hint follows the name with no separator, exactly as the rail's concatenated text reads.
        { id: "agent-pdf", name: `APL-T08-PdfFile${hint}`, description: `Reads PDF files ${hint}` },
        { id: "agent-shift", name: "Slide Agent Shift + Tab キーを押して [ピン留め] ボタンに移動します。" },
        { id: "agent-en", name: "Sales AgentPress Tab to access the Pin and More options buttons" },
        { id: "agent-only-hint", name: hint },
        { id: "agent-tabulator", name: "Tabulator Agent" }
      ],
      links: () => [
        { href: "https://m365.example.test/chat/agent/agent-linked", name: `Linked Agent${hint}` }
      ]
    });

    const result = await discovery.discover(5_000);

    expect(result.agents.map((agent) => [agent.stableAgentId, agent.displayName, agent.description])).toEqual(
      [
        ["agent-pdf", "APL-T08-PdfFile", "Reads PDF files"],
        ["agent-shift", "Slide Agent", undefined],
        ["agent-en", "Sales Agent", undefined],
        ["agent-tabulator", "Tabulator Agent", undefined],
        ["agent-linked", "Linked Agent", undefined]
      ]
    );
  });

  it("clicks one exactly named all-agents control and reports the revealed agent", async () => {
    let revealed = false;
    const clicks: string[] = [];
    const { discovery } = await makeDiscovery({
      sidebar: () =>
        revealed
          ? [
              { id: "agent-requirements", name: "Requirements Agent" },
              { id: "agent-store-only", name: "Store Only Agent" }
            ]
          : [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [],
      controls: {
        すべてのエージェント: () => {
          clicks.push("すべてのエージェント");
          revealed = true;
        }
      }
    });

    const result = await discovery.discover(5_000);

    expect(clicks).toEqual(["すべてのエージェント"]);
    expect(result.agents.map((agent) => agent.stableAgentId)).toEqual([
      "agent-requirements",
      "agent-store-only"
    ]);
    expect(result.agents.at(-1)?.source).toBe("store");
    expect(result.warnings).not.toContain("store-unavailable");
    expect(result.warnings.some((warning) => warning.includes("store:button"))).toBe(true);
  });

  it("clicks the all-agents control when it is a link or a menu item, and names the role it found", async () => {
    for (const role of ["link", "menuitem"] as const) {
      let revealed = false;
      const { discovery } = await makeDiscovery({
        sidebar: () =>
          revealed
            ? [
                { id: "agent-requirements", name: "Requirements Agent" },
                { id: "agent-store-only", name: "Store Only Agent" }
              ]
            : [{ id: "agent-requirements", name: "Requirements Agent" }],
        links: () => [],
        controls: { すべてのエージェント: { role, click: () => (revealed = true) } }
      });

      const result = await discovery.discover(5_000);

      expect(result.agents.map((agent) => agent.stableAgentId)).toEqual([
        "agent-requirements",
        "agent-store-only"
      ]);
      expect(result.warnings.some((warning) => warning.includes(`store:${role}`))).toBe(true);
    }
  });

  it("clicks nothing when the same accessible name matches controls in two roles", async () => {
    // Two candidates is ambiguous, and discovery never guesses which disclosure is the real one.
    const clicks: string[] = [];
    const { discovery } = await makeDiscovery({
      sidebar: () => [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [],
      controls: {
        すべてのエージェント: [
          { role: "button", click: () => clicks.push("button") },
          { role: "menuitem", click: () => clicks.push("menuitem") }
        ]
      }
    });

    const result = await discovery.discover(5_000);

    expect(clicks).toEqual([]);
    expect(result.warnings).toContain("store-unavailable");
  });

  it("scrolls the agent rail to hydrate lazily rendered rows before reading it", async () => {
    let hydrated = false;
    const scrolls: boolean[] = [];
    const { discovery } = await makeDiscovery({
      sidebar: () =>
        hydrated
          ? [
              { id: "agent-requirements", name: "Requirements Agent" },
              { id: "agent-lazy", name: "Lazy Agent" }
            ]
          : [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [],
      scroll: (restore) => {
        scrolls.push(restore);
        if (restore) return { moved: false, atEnd: true };
        hydrated = true;
        // Two steps: the second one reaches the bottom.
        return { moved: true, atEnd: scrolls.filter((value) => !value).length >= 2 };
      }
    });

    const result = await discovery.discover(5_000);

    expect(result.agents.map((agent) => agent.stableAgentId)).toEqual(["agent-requirements", "agent-lazy"]);
    // Two hydration steps, then the rail is put back where it was.
    expect(scrolls).toEqual([false, false, true]);
    expect(result.warnings.some((warning) => warning.includes("scroll:2"))).toBe(true);
  });

  it("suggests SharePoint/OneDrive hostnames seen on the landing page, never their URLs", async () => {
    const { discovery } = await makeDiscovery({
      sidebar: () => [],
      links: () => [],
      fileLinks: () => [
        "https://contoso.sharepoint.com/sites/x?e=secret",
        "https://CONTOSO-my.sharepoint.com/personal/y/Documents/report.docx",
        "https://contoso.sharepoint.com/sites/duplicate",
        "https://onedrive.live.com/?id=1",
        "https://tenant.sharepoint.cn/sites/cn",
        "https://tenant.sharepoint-df.com/sites/df",
        "https://evil.example.net/sharepoint.com/phish",
        "mailto:someone@contoso.com",
        "/relative/path"
      ]
    });

    const result = await discovery.discover(5_000);

    expect(result.suggestedDownloadHosts).toEqual([
      "contoso-my.sharepoint.com",
      "contoso.sharepoint.com",
      "onedrive.live.com",
      "tenant.sharepoint-df.com",
      "tenant.sharepoint.cn"
    ]);
  });

  it("omits suggested download hosts when the landing page links to none", async () => {
    const { discovery } = await makeDiscovery({ sidebar: () => [], links: () => [] });
    await expect(discovery.discover(5_000)).resolves.not.toHaveProperty("suggestedDownloadHosts");
  });

  it("never clicks an unknown control and warns when the agent store is unavailable", async () => {
    const clicks: string[] = [];
    const { discovery } = await makeDiscovery({
      sidebar: () => [],
      links: () => [],
      controls: {
        エージェントを削除: () => clicks.push("エージェントを削除")
      }
    });

    const result = await discovery.discover(5_000);

    expect(clicks).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining(["no-sidebar", "store-unavailable"]));
  });

  it("waits for the application shell to render before reading the rail", async () => {
    // Microsoft 365 answers with an empty shell (marker text, no main region) and renders the chat
    // client-side afterwards; reading on arrival would find nothing.
    let structureChecks = 0;
    const events: ProgressEvent[] = [];
    const { discovery } = await makeDiscovery({
      sidebar: () => [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [],
      structure: () => ++structureChecks >= 3,
      renderTimeoutMs: 5_000
    });

    const result = await discovery.discover(5_000, (event) => events.push(event));

    expect(structureChecks).toBeGreaterThanOrEqual(3);
    expect(result.agents.map((agent) => agent.stableAgentId)).toEqual(["agent-requirements"]);
    expect(result.warnings.some((warning) => warning.startsWith("landing"))).toBe(false);
    expect(events.some((event) => (event.message ?? "").includes("to render"))).toBe(true);
  });

  it("goes on with a warning when the shell never renders within the render budget", async () => {
    const { discovery } = await makeDiscovery({ sidebar: () => [], links: () => [], structure: () => false });
    const result = await discovery.discover(5_000);
    expect(result.warnings).toContain("landing-not-rendered:unknown");
  });

  it("describes the landing page's structure, metadata only, when nothing was found", async () => {
    const { discovery } = await makeDiscovery({
      sidebar: () => [],
      links: () => [],
      landing: () => ({
        landmarks: ["nav(エージェント):12", "aside:3"],
        shapes: ["/chat?titleId×8", "/chat/{id}×2"],
        dataAttrs: ["data-testid", "data-app-id"],
        testIds: ["agent-rail"],
        controls: ["button:すべてのエージェントを表示", "link:エージェントを取得"],
        ids: ["data-tid:T_{guid}.{guid}.gpt.{guid}×30"],
        disclosures: ["すべて表示@depth=12,common=7,after-rows=y,in-row=n"],
        main: true
      })
    });

    const result = await discovery.discover(5_000);

    const summary = result.warnings.find((warning) => warning.startsWith("landing:"));
    expect(summary).toContain("rendered=yes main=yes");
    expect(summary).toContain("rows=0 section=no-control");
    expect(summary).toContain("landmarks=nav(エージェント):12|aside:3");
    expect(summary).toContain("links=/chat?titleId×8|/chat/{id}×2");
    expect(summary).toContain("data=data-testid|data-app-id testid=agent-rail");
    expect(summary).toContain("controls=button:すべてのエージェントを表示|link:エージェントを取得");
    expect(summary).toContain("disclosures=すべて表示@depth=12,common=7,after-rows=y,in-row=n");
    expect(summary).toContain("ids=data-tid:T_{guid}.{guid}.gpt.{guid}×30");
  });

  it("expands the agent section's own show-all control before anything else, and clicks nothing more", async () => {
    // Microsoft 365 renders the rail's agent list collapsed behind a "すべて表示" button that sits
    // in the same section as the rows; the page-wide all-agents control does not exist.
    let expanded = false;
    const globalClicks: string[] = [];
    const { discovery } = await makeDiscovery({
      sidebar: () =>
        expanded
          ? [
              { id: "agent-requirements", name: "Requirements Agent" },
              { id: "agent-t01", name: "T01" }
            ]
          : [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [{ href: "https://m365.example.test/chat/all", name: "その他のエージェント" }],
      sectionDisclosure: {
        name: "すべて表示",
        click: () => {
          expanded = true;
        }
      },
      controls: {
        すべてのエージェント: () => globalClicks.push("すべてのエージェント")
      }
    });

    const result = await discovery.discover(5_000);

    expect(result.agents.map((agent) => [agent.stableAgentId, agent.source])).toEqual([
      ["agent-requirements", "sidebar"],
      ["agent-t01", "store"]
    ]);
    expect(globalClicks).toEqual([]);
    expect(result.warnings).toContain(
      "sidebar:1/1 link:1/0 scroll:0 store:section:すべて表示>route:/chat/all"
    );
  });

  it("falls through to the routes when the section control reveals nothing new", async () => {
    let current = "";
    const { discovery } = await makeDiscovery({
      sidebar: () =>
        current.endsWith("/chat/all")
          ? [{ id: "agent-t01", name: "T01" }]
          : [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [{ href: "https://m365.example.test/chat/all", name: "その他のエージェント" }],
      sectionDisclosure: { name: "すべて表示", click: () => undefined },
      onGoto: (url) => {
        current = url;
      }
    });

    const result = await discovery.discover(5_000);

    expect(result.agents.map((agent) => agent.stableAgentId)).toEqual(["agent-requirements", "agent-t01"]);
    expect(result.warnings).toContain(
      "sidebar:1/1 link:1/0 scroll:0 store:section:すべて表示>route:/chat/all"
    );
  });

  it("describes an agent-list route page that showed nothing the selectors recognize", async () => {
    let current = "";
    const { discovery } = await makeDiscovery({
      sidebar: () => [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [{ href: "https://m365.example.test/chat/all", name: "その他のエージェント" }],
      landing: () =>
        current.endsWith("/chat/all")
          ? { landmarks: ["main:40"], controls: ["button:エージェントを取得"], main: true }
          : { landmarks: ["div[navigation]:84"], controls: ["a:その他のエージェント"], main: true },
      onGoto: (url) => {
        current = url;
      }
    });

    const result = await discovery.discover(5_000);

    expect(result.warnings).toContain("sidebar:1/1 link:1/0 scroll:0 store:route-empty:/chat/all");
    const routePage = result.warnings.find((warning) => warning.startsWith("route:/chat/all:"));
    expect(routePage).toContain("landmarks=main:40 controls=button:エージェントを取得");
    expect(result.warnings.find((warning) => warning.startsWith("landing:"))).toContain(
      "controls=a:その他のエージェント"
    );
  });

  it("follows the all-agents route the landing page links to when no exactly named control exists", async () => {
    // Microsoft 365 ships the full agent list as a plain link (/chat/all) rather than a control
    // with a predictable accessible name; the rail lists only a few agents.
    let onAllAgents = false;
    const visited: string[] = [];
    const { discovery, page } = await makeDiscovery({
      sidebar: () =>
        onAllAgents
          ? [
              { id: "agent-requirements", name: "Requirements Agent" },
              { id: "agent-t01", name: "T01" }
            ]
          : [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [
        { href: "https://m365.example.test/chat/all", name: "すべてのエージェント" },
        { href: "https://m365.example.test/chat/agentstore", name: "エージェントを取得" }
      ],
      onGoto: (url) => {
        visited.push(url);
        onAllAgents = url.endsWith("/chat/all");
      }
    });

    const result = await discovery.discover(5_000);

    expect(result.agents.map((agent) => [agent.stableAgentId, agent.source])).toEqual([
      ["agent-requirements", "sidebar"],
      ["agent-t01", "store"]
    ]);
    expect(result.warnings).not.toContain("store-unavailable");
    expect(result.warnings).toContain("sidebar:1/1 link:2/0 scroll:0 store:route:/chat/agentstore");
    // Read the catalogue too, so descriptions can enrich the names from the all-agents rail.
    expect(visited).toEqual([
      LANDING,
      "https://m365.example.test/chat/all",
      "https://m365.example.test/chat/agentstore",
      LANDING,
      "https://m365.example.test/chat/agent/agent-requirements",
      "https://m365.example.test/chat/agent/agent-t01"
    ]);
    expect(page.url()).toBe("https://m365.example.test/chat/agent/agent-t01");
  });

  it("tries the agent store route when the all-agents route reveals nothing new", async () => {
    let current = "";
    const { discovery } = await makeDiscovery({
      sidebar: () =>
        current.endsWith("/chat/agentstore")
          ? [{ id: "agent-t01", name: "T01" }]
          : [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [
        { href: "https://m365.example.test/chat/all", name: "すべてのエージェント" },
        { href: "https://m365.example.test/chat/agentstore", name: "エージェントを取得" }
      ],
      onGoto: (url) => {
        current = url;
      }
    });

    const result = await discovery.discover(5_000);

    expect(result.agents.map((agent) => agent.stableAgentId)).toEqual(["agent-requirements", "agent-t01"]);
    expect(result.warnings).toContain("sidebar:1/1 link:2/0 scroll:0 store:route:/chat/agentstore");
  });

  it("drops the description of a route that showed nothing once a later route reveals an agent", async () => {
    // /chat/all (the chat history) never lists agents the rail did not; when the store route then
    // succeeds, nothing is left to diagnose, and the /chat/all description would only be noise.
    let current = "";
    const { discovery } = await makeDiscovery({
      sidebar: () =>
        current.endsWith("/chat/agentstore")
          ? [{ id: "agent-t01", name: "T01" }]
          : [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [
        { href: "https://m365.example.test/chat/all", name: "すべてのエージェント" },
        { href: "https://m365.example.test/chat/agentstore", name: "エージェントを取得" }
      ],
      landing: () => ({ landmarks: ["div[navigation]:85"], controls: ["button:すべて表示"], main: true }),
      onGoto: (url) => {
        current = url;
      }
    });

    const result = await discovery.discover(5_000);

    expect(result.agents.map((agent) => agent.stableAgentId)).toEqual(["agent-requirements", "agent-t01"]);
    expect(result.warnings).toContain("sidebar:1/1 link:2/0 scroll:0 store:route:/chat/agentstore");
    expect(result.warnings.some((warning) => warning.startsWith("route:"))).toBe(false);
    expect(result.warnings.some((warning) => warning.startsWith("landing:"))).toBe(false);
  });

  it("reports the routes it followed when none of them revealed anything new", async () => {
    const { discovery } = await makeDiscovery({
      sidebar: () => [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [{ href: "https://m365.example.test/chat/all", name: "すべてのエージェント" }],
      landing: () => ({
        landmarks: ["div[navigation]:84"],
        controls: ["link:すべてのエージェント"],
        main: true
      })
    });

    const result = await discovery.discover(5_000);

    expect(result.agents).toHaveLength(1);
    expect(result.warnings).not.toContain("store-unavailable");
    expect(result.warnings).toContain("sidebar:1/1 link:1/0 scroll:0 store:route-empty:/chat/all");
    // Still worth describing: the route existed but showed nothing the selectors recognize.
    expect(result.warnings.find((warning) => warning.startsWith("landing:"))).toContain(
      "controls=link:すべてのエージェント"
    );
  });

  it("keeps the unresolved store count at zero when one card resolver throws", async () => {
    const { discovery } = await makeDiscovery({
      sidebar: () => [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [{ href: "https://m365.example.test/chat/agentstore", name: "エージェントを取得" }],
      storeCards: () => [{ key: "Broken card", name: "Broken card", list: "#0:-", opens: true }],
      cardClick: () => {
        throw new Error("card click failed");
      }
    });

    const result = await discovery.discover(5_000);

    expect(result.warnings).toContain(
      "store-catalog:items=1 attr=0 nav=0 dialog=0 open=0 forbidden-only=0 skipped=0 none=0 errors=1 off-host=0 more=0"
    );
  });

  it("keeps reading the catalogue when a load-more control disappears during its click", async () => {
    const controls: FakeControls = {
      "Show more": () => {
        delete controls["Show more"];
        throw new Error("locator.click: element disappeared during hydration");
      }
    };
    const { discovery } = await makeDiscovery({
      sidebar: () => [
        { id: "agent-requirements", name: "Requirements Agent", description: "Existing description" }
      ],
      links: () => [{ href: "https://m365.example.test/chat/agentstore", name: "Agent catalogue" }],
      controls,
      storeCards: () => [{ key: "Broken card", name: "Broken card", list: "#0:-", opens: true }],
      cardClick: () => {
        throw new Error("card unavailable");
      }
    });
    const result = await discovery.discover(5_000);
    expect(controls["Show more"]).toBeUndefined();
    expect(result.warnings.some((line) => line.startsWith("store-catalog-failed:"))).toBe(false);
    expect(result.warnings.find((line) => line.startsWith("store-catalog:"))).toContain("errors=1");
    expect(result.agents[0]?.description).toBe("Existing description");
  });

  it("reports failed expansion but still inspects every available card", async () => {
    let cardClicks = 0;
    const { discovery } = await makeDiscovery({
      sidebar: () => [
        { id: "agent-requirements", name: "Requirements Agent", description: "Existing description" }
      ],
      links: () => [{ href: "https://m365.example.test/chat/agentstore", name: "Agent catalogue" }],
      controls: {
        "Show more": () => {
          throw new Error("load more obstructed");
        }
      },
      storeCards: () =>
        ["First", "Second", "Third"].map((name) => ({ key: name, name, list: "#0:-", opens: true })),
      cardClick: () => {
        cardClicks++;
        throw new Error("card unavailable");
      }
    });
    const result = await discovery.discover(5_000);
    expect(cardClicks).toBe(3);
    expect(result.warnings.filter((line) => line.startsWith("store-expansion-failed:"))).toHaveLength(1);
    expect(result.warnings.some((line) => line.startsWith("store-catalog-failed:"))).toBe(false);
    expect(result.warnings.find((line) => line.startsWith("store-catalog:"))).toContain(
      "errors=3 off-host=0 more=0 partial"
    );
    expect(result.agents[0]?.description).toBe("Existing description");
  });

  it("never follows a route the landing page does not link to, or one on another host", async () => {
    const visited: string[] = [];
    const { discovery, page } = await makeDiscovery({
      sidebar: () => [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [{ href: "https://evil.example.net/chat/all", name: "すべてのエージェント" }],
      onGoto: (url) => visited.push(url)
    });

    const result = await discovery.discover(5_000);

    expect(result.warnings).toContain("store-unavailable");
    expect(visited).toEqual([LANDING, "https://m365.example.test/chat/agent/agent-requirements"]);
    expect(page.url()).toBe(visited.at(-1));
  });

  it("also describes the landing page when agents were found but no all-agents control was", async () => {
    // A rail that lists a few agents and hides the rest behind a control discovery does not
    // recognize: the summary is what names that control for the next selector round.
    const { discovery } = await makeDiscovery({
      sidebar: () => [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [],
      landing: () => ({
        landmarks: ["nav(エージェント):6"],
        controls: ["button:すべてのエージェントを表示"],
        main: true
      })
    });

    const result = await discovery.discover(5_000);

    expect(result.agents).toHaveLength(1);
    expect(result.warnings).toContain("store-unavailable");
    expect(result.warnings.find((warning) => warning.startsWith("landing:"))).toContain(
      "controls=button:すべてのエージェントを表示"
    );
  });

  it("keeps the warnings free of the landing summary when the all-agents control was found", async () => {
    const { discovery } = await makeDiscovery({
      sidebar: () => [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [],
      controls: { すべてのエージェント: () => undefined },
      landing: () => ({ landmarks: ["nav(エージェント):6"], main: true })
    });

    const result = await discovery.discover(5_000);

    expect(result.warnings).not.toContain("store-unavailable");
    expect(result.warnings.some((warning) => warning.startsWith("landing:"))).toBe(false);
  });

  it("omits the landing summary when the page could not describe itself", async () => {
    const { discovery } = await makeDiscovery({ sidebar: () => [], links: () => [] });
    const result = await discovery.discover(5_000);
    expect(result.warnings.some((warning) => warning.startsWith("landing:"))).toBe(false);
  });

  it("requires a signed-in landing page", async () => {
    const { discovery } = await makeDiscovery({ sidebar: () => [], links: () => [], body: "サインイン" });
    await expect(discovery.discover(5_000)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      remediation: expect.stringContaining("AgentPickLink panel")
    });
  });

  it("does not attempt sidebar discovery on the Teams surface", async () => {
    const { discovery } = await makeDiscovery({
      sidebar: () => [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [],
      appHost: "teams.example.test"
    });
    await expect(discovery.discover(5_000)).resolves.toMatchObject({
      agents: [],
      warnings: ["teams-discovery-unsupported"]
    });
  });

  it("moves on from a route page as soon as its rail has rendered with nothing new", async () => {
    // A route page rebuilds its rail after load; once that rail holds steady showing nothing the
    // landing page did not, waiting out the whole store budget (5 s per route in production)
    // would only add seconds to every run.
    const { discovery, manager } = await makeDiscovery({
      sidebar: () => [{ id: "agent-requirements", name: "Requirements Agent" }],
      links: () => [{ href: "https://m365.example.test/chat/all", name: "すべてのエージェント" }],
      storeWaitMs: 5_000
    });

    await manager.start();
    // Start after profile/ACL setup; this assertion measures only discovery.
    const started = Date.now();
    const result = await discovery.discover(20_000);

    expect(result.agents.map((agent) => agent.stableAgentId)).toEqual(["agent-requirements"]);
    expect(result.warnings).toContain("sidebar:1/1 link:1/0 scroll:0 store:route-empty:/chat/all");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps waiting after the one guarded click until the rail actually changes", async () => {
    // The disclosure expands late: for a few polls after the click the rail still shows exactly
    // what it showed before. The route pages' "rendered and steady" shortcut must not fire before
    // the count has moved away from its pre-click value, or a late expansion would be missed.
    let clicked = false;
    let readsSinceClick = 0;
    const { discovery } = await makeDiscovery({
      sidebar: () => {
        if (clicked) readsSinceClick++;
        return clicked && readsSinceClick > 5
          ? [
              { id: "agent-requirements", name: "Requirements Agent" },
              { id: "agent-late", name: "Late Agent" }
            ]
          : [{ id: "agent-requirements", name: "Requirements Agent" }];
      },
      links: () => [],
      controls: {
        すべてのエージェント: () => {
          clicked = true;
        }
      },
      storeWaitMs: 5_000
    });

    const result = await discovery.discover(20_000);

    expect(result.agents.map((agent) => [agent.stableAgentId, agent.source])).toEqual([
      ["agent-requirements", "sidebar"],
      ["agent-late", "store"]
    ]);
  });
});

describe("stripKeyboardHint", () => {
  it("cuts a trailing keyboard hint at its key name and leaves every other name alone", () => {
    expect(
      stripKeyboardHint(
        "APL-T08-PdfFileTab キーを押して [ピン留め]、[その他のオプション] ボタンにアクセスします。"
      )
    ).toBe("APL-T08-PdfFile");
    expect(stripKeyboardHint("Slide Agent [Tab] キーを押して操作します。")).toBe("Slide Agent");
    expect(stripKeyboardHint("Sales Agent Press Enter to open the agent")).toBe("Sales Agent");
    expect(stripKeyboardHint("Tab キーを押して [ピン留め] ボタンにアクセスします。")).toBe("");
    // Names that merely contain a key name, or "press", keep every character.
    expect(stripKeyboardHint("Tabulator Agent")).toBe("Tabulator Agent");
    expect(stripKeyboardHint("Press Release Writer")).toBe("Press Release Writer");
    expect(stripKeyboardHint("Enter キー入力の相談")).toBe("Enter キー入力の相談");
  });
});

/** One control the fake page exposes to `getByRole`, in the role Microsoft 365 rendered it in. */
type FakeControl = { role: string; click: () => void };
type FakeControls = Record<string, (() => void) | FakeControl | FakeControl[]>;

async function makeDiscovery(options: {
  sidebar: () => SidebarRow[];
  links: () => LinkRow[];
  controls?: FakeControls;
  /** Landing-page hrefs the download-host scan sees. */
  fileLinks?: () => string[];
  /** One rail-scroll step (`restore` puts it back); defaults to "nothing is scrollable". */
  scroll?: (restore: boolean) => { moved: boolean; atEnd: boolean };
  body?: string;
  appHost?: string;
  /** Whether the chat structure (main region / composer) exists yet; defaults to "rendered". */
  structure?: () => boolean;
  /** What the metadata-only landing summary sees when discovery found nothing. */
  landing?: () => unknown;
  renderTimeoutMs?: number;
  rowsSettleMs?: number;
  /** The store budget (`storeWaitMs`); defaults to 1 ms since a fake never takes long to render. */
  storeWaitMs?: number;
  /** Optional catalogue cards for the store-route error accounting test. */
  storeCards?: () => unknown[];
  /** Optional failure injected when the fake resolves a catalogue card. */
  cardClick?: () => void;
  /** Observes every navigation, so a test can make the next page look different. */
  onGoto?: (url: string) => void;
  /** The agent section's own "show all" control: its accessible name, and what clicking it does. */
  sectionDisclosure?: { name: string; click: () => void };
}) {
  const appHost = options.appHost ?? "m365.example.test";
  const landing = `https://${appHost}/chat`;
  let currentUrl = landing;
  const closed: string[] = [];
  const page: PageLike = {
    url: () => currentUrl,
    goto: async (target: string) => {
      currentUrl = target;
      options.onGoto?.(target);
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      const source = String(fn);
      if (source.includes("readStoreCards")) return (options.storeCards?.() ?? []) as never;
      // Strategies A and B share one body (readRail) that answers with rows and links together.
      if (source.includes("firstReadableBlock"))
        return { rows: options.sidebar(), links: options.links() } as never;
      // The section-disclosure walk stops at document.body, so it must be recognized first.
      if (source.includes("shapeOf")) return { found: true, shape: "attrs=- testid=- tags=-" } as never;
      if (source.includes("args.marker"))
        return (
          options.sectionDisclosure ? { name: options.sectionDisclosure.name } : { reason: "no-control" }
        ) as never;
      if (source.includes("document.body")) return (options.body ?? AUTHENTICATED_BODY) as never;
      if (source.includes("scrollTop"))
        return (options.scroll ?? (() => ({ moved: false, atEnd: true })))(
          (arg as { restore?: boolean } | undefined)?.restore === true
        ) as never;
      if (source.includes("getAttribute(attribute)")) return (options.fileLinks?.() ?? []) as never;
      if (source.includes("document.querySelector(sel.main)"))
        return (options.structure?.() ?? true) as never;
      if (source.includes("landmarkSelector")) return (options.landing?.() ?? true) as never;
      if (source.includes("rowSelector")) return (options.sidebar().length + options.links().length) as never;
      if (source.includes("a[href]")) return options.links() as never;
      if (source.includes("data-agent-id")) return options.sidebar() as never;
      return true as never;
    },
    getByRole: (role: string, roleOptions?: { name?: string | RegExp; exact?: boolean }) => {
      const name = typeof roleOptions?.name === "string" ? roleOptions.name : "";
      const matches = () => fakeControls(options.controls?.[name]).filter((control) => control.role === role);
      const locator: LocatorLike = {
        count: async () => matches().length,
        isVisible: async () => matches().length > 0,
        isEnabled: async () => matches().length > 0,
        click: async () => matches()[0]?.click()
      };
      return locator;
    },
    locator: (selector: string) => {
      const marked = selector.includes("data-agentpicklink-disclosure")
        ? options.sectionDisclosure
        : undefined;
      const locator: LocatorLike = {
        count: async () => (marked ? 1 : 0),
        isVisible: async () => !!marked,
        isEnabled: async () => !!marked,
        click: async () => {
          if (selector.includes("data-agentpicklink-card")) options.cardClick?.();
          return marked?.click();
        }
      };
      return locator;
    },
    waitForTimeout: async () => undefined,
    isClosed: () => false,
    close: async () => {
      closed.push("page");
    },
    on: () => undefined,
    off: () => undefined
  };
  const context: BrowserContextLike = {
    pages: () => [],
    newPage: async () => page,
    close: async () => undefined,
    on: () => undefined
  };
  const profilePath = path.join(await mkdtemp(path.join(os.tmpdir(), "apl-discovery-")), "profile");
  const manager = new BrowserManager({
    profilePath,
    launcher: { launchPersistentContext: async () => context }
  });
  const policy = new NavigationPolicy({ appHosts: [appHost], authHosts: ["login.example.test"] });
  const discovery = new AgentDiscovery({
    manager,
    policy,
    navigator: new AgentNavigator(policy, new AuthDetector({ signInHosts: ["login.example.test"] })),
    appHosts: [appHost],
    authHosts: ["login.example.test"],
    storeWaitMs: options.storeWaitMs ?? 1,
    storeItemWaitMs: 1,
    descriptionWaitMs: 2,
    // Fakes never take long to render; keep the waits short instead of spending production budgets.
    renderTimeoutMs: options.renderTimeoutMs ?? 50,
    rowsSettleMs: options.rowsSettleMs ?? 20
  });
  return { discovery, manager, closed, page };
}

/** A plain function in the controls map is the historical "a button with this name" shorthand. */
function fakeControls(value: FakeControls[string] | undefined): FakeControl[] {
  if (!value) return [];
  if (typeof value === "function") return [{ role: "button", click: value }];
  return Array.isArray(value) ? value : [value];
}
