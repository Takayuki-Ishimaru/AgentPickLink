import { describe, expect, it } from "vitest";
import {
  AgentBuilderChatAdapter,
  CopilotStudioM365Adapter,
  M365CopilotChatAdapter,
  TeamsWebAdapter
} from "../../src/transports/browser/adapters/index.js";
import {
  directAgentNameFromComposerLabel,
  type BaseChatUiAdapter
} from "../../src/transports/browser/adapters/base-chat-adapter.js";
import type { LocatorLike, PageLike } from "../../src/transports/browser/types.js";

const cases = [
  [
    "m365-copilot-chat@1",
    () =>
      new M365CopilotChatAdapter({
        hostnames: ["m365.example.test"],
        stabilityWindowMs: 1,
        pollIntervalMs: 1,
        quietStreamingGraceMs: 1
      }),
    "https://m365.example.test/chat",
    "m365-copilot"
  ],
  [
    "agent-builder-chat@1",
    () =>
      new AgentBuilderChatAdapter({
        hostnames: ["m365.example.test"],
        stabilityWindowMs: 1,
        pollIntervalMs: 1,
        quietStreamingGraceMs: 1
      }),
    "https://m365.example.test/chat",
    "m365-copilot"
  ],
  [
    "copilot-studio-m365-chat@1",
    () =>
      new CopilotStudioM365Adapter({
        hostnames: ["m365.example.test"],
        stabilityWindowMs: 1,
        pollIntervalMs: 1,
        quietStreamingGraceMs: 1
      }),
    "https://m365.example.test/chat",
    "m365-copilot"
  ],
  [
    "teams-web-agent-chat@1",
    () =>
      new TeamsWebAdapter({
        hostnames: ["teams.example.test"],
        stabilityWindowMs: 1,
        pollIntervalMs: 1,
        quietStreamingGraceMs: 1
      }),
    "https://teams.example.test/chat",
    "teams-web"
  ]
] as const;

describe.each(cases)("adapter contract %s", (adapterId, create, url, surface) => {
  it("matches, identifies, starts fresh, submits once, completes, and extracts", async () => {
    const adapter: BaseChatUiAdapter = create();
    const fixture = pageFixture(url, surface, "ja");
    await expect(adapter.canHandle(fixture.page)).resolves.toMatchObject({
      matched: true,
      confidence: "strong"
    });
    await expect(
      adapter.assertAgentIdentity(fixture.page, {
        status: "verified",
        adapterId,
        expectedDisplayName: "Requirements Agent",
        expectedStableAgentId: "agent-1",
        expectedSurface: surface,
        validatedUrlPattern: "^/chat$",
        bindingFingerprint: `sha256:${"a".repeat(64)}`,
        validatedAt: new Date().toISOString()
      })
    ).resolves.toMatchObject({ valid: true });
    const before = await adapter.captureConversationMarker(fixture.page);
    await adapter.startNewConversation(fixture.page);
    await expect(adapter.verifyNewConversation(fixture.page, before)).resolves.toMatchObject({
      verified: true
    });
    await adapter.fillComposer(fixture.page, "hello");
    const submission = await adapter.captureSubmissionMarker(fixture.page);
    await adapter.submitComposer(fixture.page);
    await expect(adapter.waitForUserMessageAck(fixture.page, submission, 1_000)).resolves.toMatchObject({
      state: "sent"
    });
    const response = await adapter.waitForResponseStart(fixture.page, submission, 1_000);
    await expect(adapter.waitForResponseComplete(fixture.page, response, 1_000)).resolves.toMatchObject({
      complete: true
    });
    await expect(adapter.extractLatestResponse(fixture.page, response)).resolves.toMatchObject({
      text: "Answer",
      citations: [{ url: "https://example.test/source" }]
    });
    expect(fixture.sendClicks()).toBe(1);
    expect(fixture.labels()).toEqual(expect.arrayContaining(["send-ja", "new-ja"]));
  });

  it("matches, identifies, starts fresh, submits once, completes, and extracts against the English-locale page", async () => {
    const adapter: BaseChatUiAdapter = create();
    const fixture = pageFixture(url, surface, "en");
    await expect(adapter.canHandle(fixture.page)).resolves.toMatchObject({
      matched: true,
      confidence: "strong"
    });
    await expect(
      adapter.assertAgentIdentity(fixture.page, {
        status: "verified",
        adapterId,
        expectedDisplayName: "Requirements Agent",
        expectedStableAgentId: "agent-1",
        expectedSurface: surface,
        validatedUrlPattern: "^/chat$",
        bindingFingerprint: `sha256:${"a".repeat(64)}`,
        validatedAt: new Date().toISOString()
      })
    ).resolves.toMatchObject({ valid: true });
    const before = await adapter.captureConversationMarker(fixture.page);
    await adapter.startNewConversation(fixture.page);
    await expect(adapter.verifyNewConversation(fixture.page, before)).resolves.toMatchObject({
      verified: true
    });
    await adapter.fillComposer(fixture.page, "hello");
    const submission = await adapter.captureSubmissionMarker(fixture.page);
    await adapter.submitComposer(fixture.page);
    await expect(adapter.waitForUserMessageAck(fixture.page, submission, 1_000)).resolves.toMatchObject({
      state: "sent"
    });
    const response = await adapter.waitForResponseStart(fixture.page, submission, 1_000);
    await expect(adapter.waitForResponseComplete(fixture.page, response, 1_000)).resolves.toMatchObject({
      complete: true
    });
    await expect(adapter.extractLatestResponse(fixture.page, response)).resolves.toMatchObject({
      text: "Answer",
      citations: [{ url: "https://example.test/source" }]
    });
    expect(fixture.sendClicks()).toBe(1);
    expect(fixture.labels()).toEqual(expect.arrayContaining(["send-en", "new-en"]));
  });

  it("rejects an unsupported host", async () => {
    const adapter: BaseChatUiAdapter = create();
    const fixture = pageFixture("https://not-allowlisted.example.test/chat", surface, "ja");
    await expect(adapter.canHandle(fixture.page)).resolves.toMatchObject({ matched: false });
  });

  it("rejects a mismatched display name", async () => {
    const adapter: BaseChatUiAdapter = create();
    const fixture = pageFixture(url, surface, "ja");
    await expect(
      adapter.assertAgentIdentity(fixture.page, {
        status: "verified",
        adapterId,
        expectedDisplayName: "Someone Else's Agent",
        expectedStableAgentId: "agent-1",
        expectedSurface: surface,
        validatedUrlPattern: "^/chat$",
        bindingFingerprint: `sha256:${"a".repeat(64)}`,
        validatedAt: new Date().toISOString()
      })
    ).resolves.toMatchObject({ valid: false, code: "AGENT_IDENTITY_MISMATCH" });
  });
});

describe("surface derivation does not use a hostname substring heuristic", () => {
  it("matches a teams-web adapter on a hostname that does not contain 'teams'", async () => {
    const adapter = new TeamsWebAdapter({
      hostnames: ["chat.example.test"],
      stabilityWindowMs: 1,
      pollIntervalMs: 1
    });
    const fixture = pageFixture("https://chat.example.test/chat", "teams-web", "ja");
    await expect(adapter.canHandle(fixture.page)).resolves.toMatchObject({
      matched: true,
      confidence: "strong"
    });
  });
  it("does not reject an m365-copilot adapter just because its hostname contains 'teams'", async () => {
    const adapter = new M365CopilotChatAdapter({
      hostnames: ["teams.contoso.example"],
      stabilityWindowMs: 1,
      pollIntervalMs: 1
    });
    const fixture = pageFixture("https://teams.contoso.example/chat", "m365-copilot", "ja");
    await expect(adapter.canHandle(fixture.page)).resolves.toMatchObject({
      matched: true,
      confidence: "strong"
    });
  });
});

describe("current M365 direct-agent landing", () => {
  it("types through the rich-text composer's keyboard event path", async () => {
    const adapter = new M365CopilotChatAdapter({
      hostnames: ["m365.example.test"],
      stabilityWindowMs: 1
    });
    const calls: string[] = [];
    let value = "";
    const composer: LocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true,
      getAttribute: async (name) => (name === "contenteditable" ? "true" : null),
      textContent: async () => value,
      click: async () => calls.push("click"),
      press: async (key) => calls.push(`press:${key}`),
      pressSequentially: async (text) => {
        value = `${text}\u200b\u200c`;
        calls.push(`type:${text}`);
      }
    };
    const page: PageLike = {
      url: () => "https://m365.example.test/chat/agent/T_agent.gpt.instance",
      locator: () => composer,
      waitForTimeout: async () => undefined
    };

    await adapter.fillComposer(page, "hello");

    expect(calls).toEqual(["click", "type:hello"]);
  });

  it("derives the current M365 conversation id from its route", async () => {
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const page: PageLike = {
      url: () =>
        "https://m365.example.test/chat/agent/T_agent.gpt.instance/conversation/954640f2-1fb2-46ed-9479-237ef72abb42",
      evaluate: async () => ({ userCount: 1, assistantCount: 1 })
    };

    await expect(adapter.captureConversationMarker(page)).resolves.toMatchObject({
      id: "954640f2-1fb2-46ed-9479-237ef72abb42",
      userCount: 1,
      assistantCount: 1
    });
  });

  it("keeps the verified direct-agent identity on its M365 conversation route", async () => {
    const routeAgentId = "T_agent.gpt.instance";
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const page: PageLike = {
      url: () =>
        `https://m365.example.test/chat/agent/${routeAgentId}/conversation/954640f2-1fb2-46ed-9479-237ef72abb42`,
      evaluate: async () => ({
        displayName: "APL-T02-Structured",
        stableAgentId: routeAgentId,
        surface: "m365-copilot",
        evidence: ["visible-name", "stable-id"]
      })
    };

    await expect(
      adapter.assertAgentIdentity(page, {
        status: "verified",
        adapterId: "m365-copilot-chat@1",
        expectedDisplayName: "APL-T02-Structured",
        expectedStableAgentId: routeAgentId,
        expectedSurface: "m365-copilot",
        validatedUrlPattern: "^/chat/agent/T_agent\\.gpt\\.instance$",
        bindingFingerprint: `sha256:${"a".repeat(64)}`,
        validatedAt: new Date().toISOString()
      })
    ).resolves.toMatchObject({ valid: true });
  });

  it("correlates a current M365 user article with Lexical zero-width markers", async () => {
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const page: PageLike = {
      url: () => "https://m365.example.test/chat/agent/T_agent/conversation/conversation-1",
      evaluate: async (fn: unknown, arg?: unknown) => {
        const source = String(fn);
        if (source.includes("const all")) return { userCount: 1, assistantCount: 0 };
        expect(source).toContain("querySelector('[data-testid=\"chatOutput\"]')");
        expect(arg).toContain("fai-UserMessage");
        return "hello";
      },
      waitForTimeout: async () => undefined
    };

    await expect(
      adapter.waitForUserMessageAck(
        page,
        {
          userCount: 0,
          assistantCount: 0,
          url: page.url(),
          identityDigest: "digest",
          composerValue: "hello\u200b\u200c",
          capturedAt: Date.now()
        },
        1_000
      )
    ).resolves.toEqual({ state: "sent" });
  });

  it("extracts a specific agent name from localized composer labels", () => {
    expect(directAgentNameFromComposerLabel("APL-T01-Message にメッセージを送信してください")).toBe(
      "APL-T01-Message"
    );
    expect(directAgentNameFromComposerLabel("Send a message to APL-T04-WebCitations")).toBe(
      "APL-T04-WebCitations"
    );
    expect(directAgentNameFromComposerLabel("Copilot にメッセージを送信する")).toBeUndefined();
  });

  it("strongly matches an empty chat when the URL agent id and visible agent row agree", async () => {
    const routeAgentId = "T_agent.gpt.instance";
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const composer: LocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true
    };
    const page: PageLike = {
      url: () => `https://m365.example.test/chat/agent/${routeAgentId}`,
      locator: () => composer,
      evaluate: async (fn: unknown, arg?: unknown) => {
        const source = String(fn);
        if (source.includes("hasMainRegion"))
          return { hasMainRegion: true, hasSendButton: false, hasConversationRegion: false };
        if (source.includes("routeRoot")) {
          expect(arg).toMatchObject({ routeAgentId });
          return {
            displayName: "APL-T03-LongStream",
            stableAgentId: routeAgentId,
            surface: "m365-copilot",
            evidence: ["visible-name", "stable-id"]
          };
        }
        throw new Error("unexpected evaluation");
      }
    };

    await expect(adapter.canHandle(page)).resolves.toEqual({ matched: true, confidence: "strong" });
    await expect(adapter.detectAgentIdentity(page)).resolves.toMatchObject({
      displayName: "APL-T03-LongStream",
      stableAgentId: routeAgentId,
      evidence: ["visible-name", "stable-id"]
    });
  });

  it("strongly matches an unpinned direct agent when its heading and composer label agree", async () => {
    const routeAgentId = "T_hidden.gpt.instance";
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const composer: LocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true
    };
    const page: PageLike = {
      url: () => `https://m365.example.test/chat/agent/${routeAgentId}`,
      locator: () => composer,
      evaluate: async (fn: unknown, arg?: unknown) => {
        const source = String(fn);
        if (source.includes("hasMainRegion"))
          return { hasMainRegion: true, hasSendButton: false, hasConversationRegion: false };
        if (source.includes("corroboratedIdentityRoot")) {
          expect(arg).toMatchObject({
            routeAgentId,
            heading: expect.stringContaining('[role="heading"]'),
            label: "[aria-label]",
            composer: expect.stringContaining('[contenteditable="true"]')
          });
          return {
            displayName: "APL-T01-Message",
            stableAgentId: routeAgentId,
            surface: "m365-copilot",
            evidence: ["visible-name", "stable-id"]
          };
        }
        throw new Error("unexpected evaluation");
      }
    };

    await expect(adapter.canHandle(page)).resolves.toEqual({ matched: true, confidence: "strong" });
    await expect(adapter.detectAgentIdentity(page)).resolves.toMatchObject({
      displayName: "APL-T01-Message",
      stableAgentId: routeAgentId,
      evidence: ["visible-name", "stable-id"]
    });
  });

  it("does not treat the direct URL alone as strong identity evidence", async () => {
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const composer: LocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true
    };
    const page: PageLike = {
      url: () => "https://m365.example.test/chat/agent/T_expected",
      locator: () => composer,
      evaluate: async (fn: unknown) =>
        String(fn).includes("hasMainRegion")
          ? { hasMainRegion: true, hasSendButton: false, hasConversationRegion: false }
          : {
              displayName: "Different agent",
              stableAgentId: "T_different",
              surface: "m365-copilot",
              evidence: ["visible-name", "stable-id"]
            }
    };

    await expect(adapter.canHandle(page)).resolves.toMatchObject({ matched: true, confidence: "weak" });
  });

  it("prefers the corroborated heading over text from a matching agent-id shell", async () => {
    const routeAgentId = "T_agent.gpt.instance";
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const page: PageLike = {
      url: () => `https://m365.example.test/chat/agent/${routeAgentId}`,
      evaluate: async (fn: unknown, arg?: unknown) => {
        const source = String(fn);
        if (!source.includes("routeRootName")) throw new Error("unexpected evaluation");
        expect(arg).toMatchObject({ routeAgentId });
        return {
          displayName: "APL-T01-Message",
          stableAgentId: routeAgentId,
          surface: "m365-copilot",
          evidence: ["visible-name", "stable-id"]
        };
      }
    };

    await expect(adapter.detectAgentIdentity(page)).resolves.toMatchObject({
      displayName: "APL-T01-Message",
      stableAgentId: routeAgentId
    });
  });

  it("keeps identity verified after composer text replaces its agent-specific placeholder", async () => {
    const routeAgentId = "T_agent.gpt.instance";
    const displayName = "APL-T09-MultiFiles";
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const page: PageLike = {
      url: () => `https://m365.example.test/chat/agent/${routeAgentId}`,
      evaluate: async (fn: unknown, arg?: unknown) => {
        const source = String(fn);
        if (!source.includes("expectedHeading") || !source.includes("expectedVisibleName"))
          throw new Error("unexpected evaluation");
        expect(arg).toMatchObject({ routeAgentId, expectedDisplayName: displayName });
        return {
          displayName,
          stableAgentId: routeAgentId,
          surface: "m365-copilot",
          evidence: ["visible-name", "stable-id"],
          composerLabel: "Message"
        };
      }
    };

    await expect(
      adapter.assertAgentIdentity(page, {
        expectedDisplayName: displayName,
        expectedStableAgentId: routeAgentId,
        expectedSurface: "m365-copilot",
        validatedUrlPattern: `^/chat/agent/${routeAgentId}/?$`
      })
    ).resolves.toMatchObject({ valid: true });
  });

  it("does not promote a composer label over an independently observed direct-agent name", async () => {
    const routeAgentId = "T_agent.gpt.instance";
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const page: PageLike = {
      url: () => `https://m365.example.test/chat/agent/${routeAgentId}`,
      evaluate: async () => ({
        displayName: "APL-T09-MultiFiles",
        stableAgentId: routeAgentId,
        surface: "m365-copilot",
        evidence: ["visible-name", "stable-id"],
        composerLabel: "Copilot にメッセージを送信する"
      })
    };
    await expect(adapter.detectAgentIdentity(page)).resolves.toMatchObject({
      displayName: "APL-T09-MultiFiles",
      stableAgentId: routeAgentId
    });
  });

  it("submits through one enabled structural send control when its accessible name changed", async () => {
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    let clicks = 0;
    const structuralSend: LocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true,
      click: async () => {
        clicks++;
      }
    };
    const page: PageLike = {
      url: () => "https://m365.example.test/chat/agent/T_agent.gpt.instance",
      getByRole: () => ({ count: async () => 0 }),
      locator: (selector) => {
        expect(selector).toContain('button[type="submit"]');
        return structuralSend;
      }
    };

    await adapter.submitComposer(page);
    expect(clicks).toBe(1);
  });

  it("fails closed when more than one structural send control is usable", async () => {
    const adapter = new M365CopilotChatAdapter({ hostnames: ["m365.example.test"] });
    const candidate: LocatorLike = {
      isVisible: async () => true,
      isEnabled: async () => true,
      click: async () => undefined
    };
    const page: PageLike = {
      url: () => "https://m365.example.test/chat/agent/T_agent.gpt.instance",
      getByRole: () => ({ count: async () => 0 }),
      locator: () => ({
        count: async () => 2,
        nth: () => candidate
      })
    };

    await expect(adapter.submitComposer(page)).rejects.toMatchObject({
      code: "UI_CHANGED",
      details: { submissionState: "not-sent" }
    });
  });
});

function pageFixture(
  url: string,
  surface: string,
  locale: "ja" | "en" = "ja"
): { page: PageLike; sendClicks(): number; labels(): string[] } {
  let composerValue = "";
  let conversationId = "old";
  let userCount = 1;
  let assistantCount = 1;
  let latestUser = "";
  let clicks = 0;
  const labels: string[] = [];
  const newChatText = locale === "en" ? "New chat" : "新しいチャット";
  const sendText = locale === "en" ? "Send" : "送信";
  const stopText = locale === "en" ? "Stop generating" : "生成を停止";
  const composer: LocatorLike = {
    count: async () => 1,
    isVisible: async () => true,
    inputValue: async () => composerValue,
    fill: async (value) => {
      composerValue = value;
    },
    textContent: async () => composerValue
  };
  const page: PageLike = {
    url: () => url,
    locator: () => composer,
    getByRole: (_role, options) => {
      const pattern = options?.name as RegExp;
      const isNew = pattern.test(newChatText);
      // Nothing is generating in this fixture, so the stop-generating control does not exist.
      if (pattern.test(stopText)) return { count: async () => 0 };
      labels.push(isNew ? `new-${locale}` : pattern.test(sendText) ? `send-${locale}` : "other");
      return {
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async () => {
          if (isNew) {
            conversationId = "fresh";
            userCount = 0;
            assistantCount = 0;
          } else {
            clicks++;
            latestUser = composerValue;
            userCount++;
            assistantCount++;
          }
        }
      };
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      const source = String(fn);
      if (source.includes("hasMainRegion"))
        return { hasMainRegion: true, hasSendButton: true, hasConversationRegion: true };
      if (source.includes("stableAgentId"))
        return {
          displayName: "Requirements Agent",
          stableAgentId: "agent-1",
          surface,
          evidence: ["visible-name", "stable-id"]
        };
      if (source.includes("latest assistant response") || source.includes("actionRequired"))
        return {
          html: "<p>Answer</p>",
          citations: [{ url: "https://example.test/source" }],
          actionRequired: false
        };
      if (source.includes("nodes.at")) return latestUser;
      if (arg && typeof arg === "object" && "marker" in arg && "selector" in arg)
        return { text: "Answer", streaming: false, id: "response-1" };
      return { id: conversationId, userCount, assistantCount };
    },
    waitForTimeout: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  };
  return { page, sendClicks: () => clicks, labels: () => labels };
}
