import { describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "../../src/domain/progress.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import { ConversationDriver } from "../../src/transports/browser/conversation-driver.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import type { ChatUiAdapter } from "../../src/transports/browser/ui-adapter.js";
import type { BrowserAgentDefinition, PageLike } from "../../src/transports/browser/types.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const agent: BrowserAgentDefinition = {
  alias: "requirements",
  displayName: "Requirements",
  transport: "browser",
  kind: "m365-agent-builder",
  entryPoint: { mode: "direct-chat", url: "https://m365.example.test/chat", surface: "m365-copilot" },
  enabled: true,
  capabilityClass: "knowledge-only",
  uiActionPolicy: "never-click",
  verification: {
    status: "verified",
    adapterId: "fixture@1",
    expectedDisplayName: "Requirements",
    expectedSurface: "m365-copilot",
    validatedUrlPattern: "^/chat$",
    bindingFingerprint: fingerprint,
    validatedAt: "2026-09-01T00:00:00.000Z"
  }
};

describe("conversation submission guard", () => {
  it("waits for a transiently missing visible name on a registered direct route", async () => {
    const registered = registeredAgent();
    const route = registered.entryPoint.url;
    const page: PageLike = {
      url: () => route,
      on: () => undefined,
      off: () => undefined
    };
    let assertions = 0;
    let submissions = 0;
    let extractions = 0;
    const adapter = fixtureAdapter({
      assertAgentIdentity: async () => {
        assertions++;
        if (assertions <= 2 || assertions >= 5)
          return {
            valid: true,
            identity: {
              displayName: registered.displayName,
              stableAgentId: registered.verification.expectedStableAgentId,
              surface: "m365-copilot",
              digest: "expected",
              evidence: ["visible-name"]
            }
          };
        return {
          valid: false,
          identity: {
            stableAgentId: registered.verification.expectedStableAgentId,
            surface: "m365-copilot",
            digest: "expected",
            evidence: []
          },
          code: "AGENT_IDENTITY_UNVERIFIED"
        };
      },
      captureSubmissionMarker: async () => ({
        userCount: 0,
        assistantCount: 0,
        url: route,
        identityDigest: "expected",
        composerValue: "hello",
        capturedAt: 0
      }),
      submitComposer: async () => {
        submissions++;
      },
      extractLatestResponse: async () => {
        extractions++;
        return { text: "answer", citations: [], actionRequired: false, truncated: false };
      }
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { responseStartTimeoutMs: 500, attachmentSettleMs: 0 }
    );

    await expect(
      driver.invoke(page, conversation(), registered, adapter, { message: "hello" })
    ).resolves.toMatchObject({
      submissionState: "sent",
      text: "answer"
    });
    expect(assertions).toBe(8);
    expect(submissions).toBe(1);
    expect(extractions).toBe(1);
  });

  it("fails sent when the visible name stays missing and never extracts a response", async () => {
    const registered = registeredAgent();
    const route = registered.entryPoint.url;
    const page: PageLike = {
      url: () => route,
      on: () => undefined,
      off: () => undefined
    };
    let assertions = 0;
    let submissions = 0;
    let extractions = 0;
    const adapter = fixtureAdapter({
      assertAgentIdentity: async () => {
        assertions++;
        if (assertions <= 2)
          return {
            valid: true,
            identity: {
              displayName: registered.displayName,
              stableAgentId: registered.verification.expectedStableAgentId,
              surface: "m365-copilot",
              digest: "expected",
              evidence: ["visible-name"]
            }
          };
        return {
          valid: false,
          identity: {
            stableAgentId: registered.verification.expectedStableAgentId,
            surface: "m365-copilot",
            digest: "expected",
            evidence: []
          },
          code: "AGENT_IDENTITY_UNVERIFIED"
        };
      },
      captureSubmissionMarker: async () => ({
        userCount: 0,
        assistantCount: 0,
        url: route,
        identityDigest: "expected",
        composerValue: "hello",
        capturedAt: 0
      }),
      submitComposer: async () => {
        submissions++;
      },
      extractLatestResponse: async () => {
        extractions++;
        return { text: "answer", citations: [], actionRequired: false, truncated: false };
      }
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { responseStartTimeoutMs: 30, attachmentSettleMs: 0 }
    );

    await expect(
      driver.invoke(page, conversation(), registered, adapter, { message: "hello" })
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHANGED", details: { submissionState: "sent" } });
    expect(submissions).toBe(1);
    expect(extractions).toBe(0);
    expect(assertions).toBeGreaterThan(2);
  });

  it.each(["visible-name", "stable-id", "surface", "route"] as const)(
    "fails immediately when the post-submit %s identity signal conflicts",
    async (conflict) => {
      const registered = registeredAgent();
      const expectedRoute = registered.entryPoint.url;
      let currentRoute = expectedRoute;
      const page: PageLike = {
        url: () => currentRoute,
        on: () => undefined,
        off: () => undefined
      };
      let assertions = 0;
      let submissions = 0;
      const adapter = fixtureAdapter({
        assertAgentIdentity: async () => {
          assertions++;
          if (assertions <= 2)
            return {
              valid: true,
              identity: {
                displayName: registered.displayName,
                stableAgentId: registered.verification.expectedStableAgentId,
                surface: "m365-copilot",
                digest: "expected",
                evidence: ["visible-name"]
              }
            };
          if (conflict === "visible-name")
            return {
              valid: false,
              identity: {
                displayName: "Different Agent",
                stableAgentId: registered.verification.expectedStableAgentId,
                surface: "m365-copilot",
                digest: "different",
                evidence: ["visible-name"]
              },
              code: "AGENT_IDENTITY_MISMATCH"
            };
          if (conflict === "stable-id")
            return {
              valid: false,
              identity: {
                stableAgentId: "different-agent",
                surface: "m365-copilot",
                digest: "different",
                evidence: []
              },
              code: "AGENT_IDENTITY_MISMATCH"
            };
          if (conflict === "surface")
            return {
              valid: false,
              identity: {
                stableAgentId: registered.verification.expectedStableAgentId,
                surface: "teams-web",
                digest: "different",
                evidence: []
              },
              code: "AGENT_IDENTITY_MISMATCH"
            };
          currentRoute = "https://m365.example.test/chat/agent/different-agent";
          return {
            valid: false,
            identity: {
              stableAgentId: registered.verification.expectedStableAgentId,
              surface: "m365-copilot",
              digest: "expected",
              evidence: []
            },
            code: "AGENT_CONTEXT_CHANGED"
          };
        },
        captureSubmissionMarker: async () => ({
          userCount: 0,
          assistantCount: 0,
          url: expectedRoute,
          identityDigest: "expected",
          composerValue: "hello",
          capturedAt: 0
        }),
        submitComposer: async () => {
          submissions++;
        }
      });
      const started = Date.now();
      const driver = new ConversationDriver(
        new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
        undefined,
        { responseStartTimeoutMs: 500, attachmentSettleMs: 0 }
      );

      await expect(
        driver.invoke(page, conversation(), registered, adapter, { message: "hello" })
      ).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHANGED", details: { submissionState: "sent" } });
      expect(submissions).toBe(1);
      expect(Date.now() - started).toBeLessThan(300);
      expect(assertions).toBeLessThanOrEqual(3);
    }
  );

  it("caps the post-submit identity wait at the request timeout", async () => {
    const registered = registeredAgent();
    const route = registered.entryPoint.url;
    const page: PageLike = {
      url: () => route,
      on: () => undefined,
      off: () => undefined
    };
    let assertions = 0;
    const adapter = fixtureAdapter({
      assertAgentIdentity: async () => {
        assertions++;
        if (assertions <= 2)
          return {
            valid: true,
            identity: {
              displayName: registered.displayName,
              stableAgentId: registered.verification.expectedStableAgentId,
              surface: "m365-copilot",
              digest: "expected",
              evidence: ["visible-name"]
            }
          };
        return {
          valid: false,
          identity: {
            stableAgentId: registered.verification.expectedStableAgentId,
            surface: "m365-copilot",
            digest: "expected",
            evidence: []
          },
          code: "AGENT_IDENTITY_UNVERIFIED"
        };
      },
      captureSubmissionMarker: async () => ({
        userCount: 0,
        assistantCount: 0,
        url: route,
        identityDigest: "expected",
        composerValue: "hello",
        capturedAt: 0
      })
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { responseStartTimeoutMs: 500, attachmentSettleMs: 0 }
    );
    const started = Date.now();

    await expect(
      driver.invoke(page, conversation(), registered, adapter, { message: "hello", timeoutMs: 25 })
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHANGED", details: { submissionState: "sent" } });
    expect(Date.now() - started).toBeLessThan(250);
    expect(assertions).toBeGreaterThan(2);
  });

  it("clears a filled composer and never submits after an identity change", async () => {
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined
    };
    let assertions = 0;
    let cleared = 0;
    let submitted = 0;
    const adapter = fixtureAdapter({
      assertAgentIdentity: async () =>
        ++assertions === 1
          ? {
              valid: true,
              identity: {
                displayName: "Requirements",
                surface: "m365-copilot",
                digest: "expected",
                evidence: ["visible-name"]
              }
            }
          : { valid: false, code: "AGENT_IDENTITY_MISMATCH" },
      clearComposer: async () => {
        cleared++;
      },
      submitComposer: async () => {
        submitted++;
      }
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { attachmentSettleMs: 0 }
    );
    await expect(
      driver.invoke(
        page,
        {
          handle: "conv_test",
          agentAlias: "requirements",
          bindingFingerprint: fingerprint,
          pageKey: "page",
          state: "ready"
        },
        agent,
        adapter,
        { message: "secret" }
      )
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHANGED" });
    expect(cleared).toBe(1);
    expect(submitted).toBe(0);
  });

  it("does not treat an ambiguous acknowledgement as safe to retry", async () => {
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined
    };
    const adapter = fixtureAdapter({ waitForUserMessageAck: async () => ({ state: "unknown" }) });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { attachmentSettleMs: 0 }
    );
    await expect(
      driver.invoke(
        page,
        {
          handle: "conv_test",
          agentAlias: "requirements",
          bindingFingerprint: fingerprint,
          pageKey: "page",
          state: "ready"
        },
        agent,
        adapter,
        { message: "hello" }
      )
    ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
  });

  it("carries the just-verified identity digest into the submission marker", async () => {
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined
    };
    let markerDigest: string | undefined;
    const adapter = fixtureAdapter({
      captureSubmissionMarker: async (_page, verifiedIdentityDigest) => {
        markerDigest = verifiedIdentityDigest;
        return {
          userCount: 0,
          assistantCount: 0,
          url: "https://m365.example.test/chat",
          identityDigest: verifiedIdentityDigest ?? "",
          composerValue: "hello",
          capturedAt: 0
        };
      }
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { attachmentSettleMs: 0 }
    );

    await expect(
      driver.invoke(
        page,
        {
          handle: "conv_test",
          agentAlias: "requirements",
          bindingFingerprint: fingerprint,
          pageKey: "page",
          state: "ready"
        },
        agent,
        adapter,
        { message: "hello" }
      )
    ).resolves.toMatchObject({ text: "answer", submissionState: "sent" });
    expect(markerDigest).toBe("expected");
  });

  it("stops waiting after post-submit cancellation and preserves partial output", async () => {
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined
    };
    const controller = new AbortController();
    const adapter = fixtureAdapter({
      waitForResponseComplete: async () => {
        controller.abort();
        return { complete: false, cancelled: true, partial: "partial" };
      },
      extractLatestResponse: async () => ({
        text: "partial",
        citations: [],
        actionRequired: false,
        truncated: false
      })
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { attachmentSettleMs: 0 }
    );
    await expect(
      driver.invoke(
        page,
        {
          handle: "conv_test",
          agentAlias: "requirements",
          bindingFingerprint: fingerprint,
          pageKey: "page",
          state: "ready"
        },
        agent,
        adapter,
        { message: "hello", signal: controller.signal }
      )
    ).rejects.toMatchObject({
      code: "RESPONSE_TIMEOUT",
      details: { submissionState: "sent", partialResponse: { text: "partial" } }
    });
  });

  it("marks a post-submit identity change as sent and never retries", async () => {
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined
    };
    let assertions = 0;
    let submissions = 0;
    const adapter = fixtureAdapter({
      assertAgentIdentity: async () =>
        ++assertions < 3
          ? {
              valid: true,
              identity: {
                displayName: "Requirements",
                surface: "m365-copilot",
                digest: "expected",
                evidence: ["visible-name"]
              }
            }
          : { valid: false, code: "AGENT_IDENTITY_MISMATCH" },
      submitComposer: async () => {
        submissions++;
      }
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { attachmentSettleMs: 0 }
    );
    await expect(
      driver.invoke(
        page,
        {
          handle: "conv_test",
          agentAlias: "requirements",
          bindingFingerprint: fingerprint,
          pageKey: "page",
          state: "ready"
        },
        agent,
        adapter,
        { message: "hello" }
      )
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHANGED", details: { submissionState: "sent" } });
    expect(submissions).toBe(1);
  });
});

describe("conversation progress reporting", () => {
  it("emits ordered metadata-only phases, including a streaming heartbeat", async () => {
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async () => 7 as never,
      on: () => undefined,
      off: () => undefined
    };
    const adapter = fixtureAdapter({
      waitForResponseComplete: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { complete: true };
      }
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { streamingProgressIntervalMs: 5, attachmentSettleMs: 0 }
    );
    const events: ProgressEvent[] = [];

    await driver.invoke(
      page,
      {
        handle: "conv_test",
        agentAlias: "requirements",
        bindingFingerprint: fingerprint,
        pageKey: "page",
        state: "ready"
      },
      agent,
      adapter,
      { message: "hello", onProgress: (event) => events.push(event) }
    );

    const phases = events.map((event) => event.phase);
    expect(phases.filter((phase) => phase !== "streaming")).toEqual([
      "asserting-identity",
      "filling",
      "submitting",
      "submitted",
      "waiting-response",
      "extracting",
      "saving-attachments",
      "done"
    ]);
    const streaming = events.filter((event) => event.phase === "streaming");
    expect(streaming.length).toBeGreaterThan(0);
    expect(streaming[0]).toMatchObject({ responseChars: 7 });
    expect(events.every((event) => typeof event.elapsedMs === "number")).toBe(true);
    // Progress is metadata only: no prompt or response text may appear in any message.
    expect(events.some((event) => (event.message ?? "").includes("hello"))).toBe(false);
  });
});

describe("conversation timing and completion metadata", () => {
  it("starts the response budget after submission, and bounds the ack and response-start waits", async () => {
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined
    };
    const budgets: Record<string, number> = {};
    const adapter = fixtureAdapter({
      // A composer that takes longer to fill than the whole response budget: that time must not
      // be charged to the agent's time to answer.
      fillComposer: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
      waitForUserMessageAck: async (_page, _marker, timeoutMs) => {
        budgets.ack = timeoutMs;
        return { state: "sent" };
      },
      waitForResponseStart: async (_page, _marker, timeoutMs) => {
        budgets.start = timeoutMs;
        return { assistantCount: 1 };
      },
      waitForResponseComplete: async (_page, _marker, timeoutMs) => {
        budgets.complete = timeoutMs;
        return { complete: true };
      }
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { ackTimeoutMs: 20, responseStartTimeoutMs: 30, attachmentSettleMs: 0 }
    );

    await driver.invoke(page, conversation(), agent, adapter, { message: "hello", timeoutMs: 50 });

    expect(budgets.ack).toBe(20);
    expect(budgets.start).toBe(30);
    // The full budget is still available for the response itself, despite the 60 ms fill.
    expect(budgets.complete).toBeGreaterThan(40);
  });

  it("carries metadata-only completion details on a response timeout", async () => {
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined
    };
    const adapter = fixtureAdapter({
      waitForResponseComplete: async () => ({
        complete: false,
        timedOut: true,
        partial: "partial answer",
        reason: "timeout",
        sawStreamingSignal: false,
        finalChars: 14
      })
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { attachmentSettleMs: 0 }
    );

    const error = await driver
      .invoke(page, conversation(), agent, adapter, { message: "hello" })
      .catch((caught: unknown) => caught as { code: string; details: Record<string, unknown> });

    expect(error.code).toBe("RESPONSE_TIMEOUT");
    expect(error.details.completion).toEqual({
      reason: "timeout",
      sawStreamingSignal: false,
      finalChars: 14
    });
  });

  it.each([0, 1])("collects staged attachments starting with %i candidates", async (initialCount) => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const items = [0, 1, 2, 3].map((index) => ({
      index,
      name: index === 3 ? "bundle.zip" : "report.pdf",
      url: `https://m365.example.test/files/${index}`
    }));
    let extractions = 0;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined,
      waitForTimeout: async (ms) => {
        now += ms;
      }
    };
    const adapter = fixtureAdapter({
      extractLatestResponse: async () => ({
        text: "answer",
        citations: [],
        actionRequired: false,
        truncated: false,
        attachmentCandidates:
          ++extractions === 1
            ? items.slice(0, initialCount)
            : extractions === 2
              ? items.slice(0, 3)
              : [...items].reverse()
      })
    });
    const save = vi.fn(async (_page: unknown, _candidates: unknown[]) => []);
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      { save } as never,
      { attachmentSettleMs: 100, attachmentPollIntervalMs: 50, attachmentMaxWaitMs: 500 }
    );
    try {
      await driver.invoke(page, conversation(), agent, adapter, { message: "hello" });
      expect(extractions).toBe(5);
      expect(save.mock.calls[0]?.[1]).toEqual(items);
      expect(now).toBe(1_200);
    } finally {
      clock.mockRestore();
    }
  });

  it("stops at the hard observation deadline even when candidates keep arriving", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let extractions = 0;
    const save = vi.fn(async (_page: unknown, _candidates: unknown[]) => []);
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined,
      waitForTimeout: async (ms) => {
        now += ms;
      }
    };
    const adapter = fixtureAdapter({
      extractLatestResponse: async () => ({
        text: "answer",
        citations: [],
        actionRequired: false,
        truncated: false,
        attachmentCandidates: [
          { index: 0, name: "report.pdf", url: `https://m365.example.test/${++extractions}` }
        ]
      })
    });
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      { save } as never,
      { attachmentSettleMs: 100, attachmentPollIntervalMs: 50, attachmentMaxWaitMs: 200 }
    );
    try {
      await driver.invoke(page, conversation(), agent, adapter, { message: "hello" });
      expect(now).toBe(1_200);
      expect(save.mock.calls[0]?.[1]).toHaveLength(5);
    } finally {
      clock.mockRestore();
    }
  });

  it("cancels observation before saving files", async () => {
    const controller = new AbortController();
    const save = vi.fn(async (_page: unknown, _candidates: unknown[]) => []);
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined,
      waitForTimeout: async () => {
        controller.abort();
      }
    };
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      { save } as never,
      { attachmentSettleMs: 100 }
    );
    await expect(
      driver.invoke(page, conversation(), agent, fixtureAdapter({}), {
        message: "hello",
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });
    expect(save).not.toHaveBeenCalled();
  });
});

function conversation() {
  return {
    handle: "conv_test",
    agentAlias: "requirements",
    bindingFingerprint: fingerprint,
    pageKey: "page",
    state: "ready"
  };
}

function registeredAgent(): BrowserAgentDefinition {
  return {
    ...agent,
    entryPoint: {
      ...agent.entryPoint,
      url: "https://m365.example.test/chat/agent/agent-registered"
    },
    verification: {
      ...agent.verification,
      expectedStableAgentId: "agent-registered",
      validatedUrlPattern: "^/chat/agent/agent-registered$"
    }
  };
}

function fixtureAdapter(overrides: Partial<ChatUiAdapter>): ChatUiAdapter {
  return {
    id: "fixture@1",
    canSubmit: true,
    canHandle: async () => ({ matched: true, confidence: "strong" }),
    detectAuthState: async () => "authenticated",
    detectAgentIdentity: async () => ({
      displayName: "Requirements",
      surface: "m365-copilot",
      digest: "expected",
      evidence: ["visible-name"]
    }),
    assertAgentIdentity: async () => ({
      valid: true,
      identity: {
        displayName: "Requirements",
        surface: "m365-copilot",
        digest: "expected",
        evidence: ["visible-name"]
      }
    }),
    findComposer: async () => ({}),
    captureConversationMarker: async () => ({ userCount: 0, assistantCount: 0 }),
    startNewConversation: async () => undefined,
    verifyNewConversation: async () => ({ verified: true }),
    captureSubmissionMarker: async () => ({
      userCount: 0,
      assistantCount: 0,
      url: "https://m365.example.test/chat",
      identityDigest: "expected",
      composerValue: "hello",
      capturedAt: 0
    }),
    fillComposer: async () => undefined,
    clearComposer: async () => undefined,
    submitComposer: async () => undefined,
    waitForUserMessageAck: async () => ({ state: "sent" }),
    waitForResponseStart: async () => ({ assistantCount: 1 }),
    waitForResponseComplete: async () => ({ complete: true }),
    extractLatestResponse: async () => ({
      text: "answer",
      citations: [],
      actionRequired: false,
      truncated: false
    }),
    ...overrides
  };
}
