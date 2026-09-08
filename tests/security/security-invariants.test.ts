import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_TOOLS } from "../../src/frontend/mcp-server.js";
import { M365CopilotChatAdapter } from "../../src/transports/browser/adapters/index.js";
import { GenericDiagnosticAdapter } from "../../src/transports/browser/adapters/generic-diagnostic-adapter.js";
import { ResponseExtractor } from "../../src/transports/browser/response-extractor.js";
import { BrowserManager } from "../../src/transports/browser/browser-manager.js";
import type { BrowserContextLike, PageLike } from "../../src/transports/browser/types.js";

describe("security invariants", () => {
  it("exposes no raw navigation or browser primitive in MCP inputs", () => {
    for (const tool of PUBLIC_TOOLS) {
      const properties = Object.keys(tool.inputSchema.properties);
      expect(properties).not.toContain("url");
      expect(properties).not.toContain("selector");
      expect(properties).not.toContain("click");
      expect(properties).not.toContain("evaluate");
    }
  });
  it("keeps the generic adapter incapable of entry, fill, or submission", async () => {
    const adapter = new GenericDiagnosticAdapter();
    expect(adapter.canSubmit).toBe(false);
    await expect(adapter.findComposer({ url: () => "https://example.test" })).rejects.toThrow(
      "CANNOT_SUBMIT"
    );
    await expect(adapter.submitComposer({ url: () => "https://example.test" })).rejects.toThrow(
      "CANNOT_SUBMIT"
    );
  });
  it("keeps the generic adapter structurally unable to create a conversation or capture a submission marker", async () => {
    const adapter = new GenericDiagnosticAdapter();
    const page = { url: () => "https://example.test" };
    await expect(adapter.startNewConversation(page)).rejects.toMatchObject({ code: "UNSUPPORTED_UI" });
    await expect(
      adapter.verifyNewConversation(page, { userCount: 0, assistantCount: 0 })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_UI" });
    await expect(adapter.captureSubmissionMarker(page)).rejects.toMatchObject({ code: "UNSUPPORTED_UI" });
  });
  it("keeps the prompt out of the send-control diagnostic", async () => {
    // This diagnostic is attached to UI_CHANGED errors, recorded as an incident and copied by the
    // user for a bug report, so it must describe structure only -- never what was typed.
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      // The real diagnostic body runs in the page; this stands in for the DOM it would read.
      evaluate: async () => ({
        composer: {
          tag: "div",
          role: "textbox",
          contentEditable: "true",
          ariaLabel: "Requirements Agent にメッセージを送信",
          placeholder: null,
          className: "composer"
        },
        controls: [{ tag: "button", role: "button", ariaLabel: "送信", disabled: false }]
      })
    };

    const diagnostics = (await adapter.sendControlDiagnostics(page)) as {
      composer: Record<string, unknown>;
    };

    for (const forbidden of ["text", "html", "value", "innerText", "textContent"])
      expect(Object.keys(diagnostics.composer)).not.toContain(forbidden);
    expect(Object.keys(diagnostics.composer).sort()).toEqual([
      "ariaLabel",
      "className",
      "contentEditable",
      "placeholder",
      "role",
      "tag"
    ]);
  });

  it("builds the send-control diagnostic without reading composer text, HTML or value", async () => {
    // The body is evaluated in the page, so the guarantee has to hold in its source too.
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    let source = "";
    await adapter.sendControlDiagnostics({
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        source = String(fn);
        return {} as never;
      }
    });

    expect(source).not.toContain("innerText");
    expect(source).not.toContain("innerHTML");
    expect(source).toContain("aria-label");
  });

  it("reports action controls in a response without activating them", async () => {
    let clicks = 0;
    const extractor = new ResponseExtractor();
    const result = await extractor.extract(
      {
        url: () => "https://example.test",
        evaluate: async () => ({
          html: "<p>Review this</p><button>Approve</button>",
          citations: [],
          actionRequired: true
        }),
        getByRole: () => ({
          click: async () => {
            clicks++;
          }
        })
      },
      { assistantCount: 1 }
    );
    expect(result.actionRequired).toBe(true);
    expect(clicks).toBe(0);
    expect(result.text).toBe("Review this");
  });

  it("forces the visible sign-in window to reject downloads and permissions regardless of the hidden context's settings", async () => {
    // The hidden automation context may legitimately be configured with acceptDownloads: true (it
    // saves file-card/download-control attachments), but the visible sign-in window is shown to
    // the user only to complete an identity handshake with a federated provider whose pages are
    // deliberately unpoliced (see docs/security.md's "Sign-in handoff" section) -- it must never
    // be able to save a file or hold a granted permission (camera, clipboard, ...) itself.
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "apl-profile-signin-"));
    const launched: Array<Record<string, unknown>> = [];
    const manager = new BrowserManager({
      profilePath,
      acceptDownloads: true,
      launcher: {
        launchPersistentContext: async (_dir, options) => {
          launched.push(options);
          return {
            pages: () => [],
            newPage: async () => ({ url: () => "about:blank", close: async () => undefined }),
            close: async () => undefined,
            on: () => undefined
          } satisfies BrowserContextLike;
        }
      }
    });

    // The hidden context: acceptDownloads: true is honored there.
    await manager.createConversationPage("conversation");
    expect(launched[0]!.acceptDownloads).toBe(true);

    // The visible sign-in window: forced to false/empty regardless.
    await manager.runInteractiveLogin(async () => undefined);
    expect(launched[1]!.acceptDownloads).toBe(false);
    expect(launched[1]!.permissions).toEqual([]);

    await manager.close();
  });
});
