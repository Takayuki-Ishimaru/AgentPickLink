import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import type { ProgressEvent } from "../../src/domain/progress.js";
import { AgentNavigator } from "../../src/transports/browser/agent-navigator.js";
import {
  ConversationDriver,
  enteredMessage,
  enteredMessageDigest,
  type ConversationDriverOptions
} from "../../src/transports/browser/conversation-driver.js";
import { NavigationPolicy } from "../../src/transports/browser/navigation-policy.js";
import type { ChatUiAdapter, SubmitGuard } from "../../src/transports/browser/ui-adapter.js";
import {
  BrowserTransportError,
  type AttachmentCandidate,
  type BrowserAgentDefinition,
  type ConversationExchange,
  type EnteredMessage,
  type PageLike
} from "../../src/transports/browser/types.js";

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
  it("clears and refuses a composer that changed between fill verification and capture", async () => {
    const clearComposer = vi.fn(async () => {});
    const submitComposer = vi.fn(async () => {});
    const adapter = fixtureAdapter({
      clearComposer,
      submitComposer,
      captureSubmissionMarker: async () => ({
        userCount: 0,
        assistantCount: 0,
        url: "https://m365.example.test/chat",
        identityDigest: "expected",
        composerValue: "changed",
        capturedAt: Date.now()
      })
    });
    const page: PageLike = { url: () => "https://m365.example.test/chat", on: () => {}, off: () => {} };
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] }))
    );
    await expect(
      driver.invoke(page, conversation(), agent, adapter, { message: "hello" })
    ).rejects.toMatchObject({ code: "UI_CHANGED", details: { submissionState: "not-sent" } });
    expect(clearComposer).toHaveBeenCalledOnce();
    expect(submitComposer).not.toHaveBeenCalled();
  });

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

  it("reports a cancel during the post-submit identity wait as a cancellation, not a context change", async () => {
    // AGENT_CONTEXT_CHANGED is a UI-drift incident; a caller's own cancel used to be reported as one.
    const registered = registeredAgent();
    const route = registered.entryPoint.url;
    const page: PageLike = { url: () => route, on: () => undefined, off: () => undefined };
    const controller = new AbortController();
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
        // The empty assistant header while a reply starts: the driver waits for the name.
        if (assertions === 4) controller.abort();
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
      { responseStartTimeoutMs: 5_000, attachmentSettleMs: 0 }
    );

    await expect(
      driver.invoke(page, conversation(), registered, adapter, {
        message: "hello",
        signal: controller.signal
      })
    ).rejects.toMatchObject({
      code: "RESPONSE_TIMEOUT",
      message: "Waiting was cancelled after the message was submitted.",
      details: { submissionState: "sent" }
    });
    expect(assertions).toBe(4);
  });

  it("still reports a conflicting identity seen during a cancel as a context change", async () => {
    const registered = registeredAgent();
    const route = registered.entryPoint.url;
    const page: PageLike = { url: () => route, on: () => undefined, off: () => undefined };
    const controller = new AbortController();
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
        controller.abort();
        // Another agent's ID after submission is a real context change, cancelled or not.
        return {
          valid: false,
          identity: { stableAgentId: "other-agent", surface: "m365-copilot", digest: "other", evidence: [] },
          code: "AGENT_IDENTITY_MISMATCH"
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
      { responseStartTimeoutMs: 5_000, attachmentSettleMs: 0 }
    );

    await expect(
      driver.invoke(page, conversation(), registered, adapter, {
        message: "hello",
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_CHANGED", details: { submissionState: "sent" } });
    expect(assertions).toBe(3);
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

// v0.2.8 review 01/02: what was verified before submission must hold when the control is pressed,
// and every failure says how far the submission got -- never not-sent once the control was pressed.
describe("the check before the press and the submission state of failures", () => {
  const app = "https://m365.example.test/chat";
  const plainPage = (url: () => string = () => app): PageLike => ({
    url,
    on: () => undefined,
    off: () => undefined
  });
  const driver = () =>
    new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { attachmentSettleMs: 0 }
    );
  const valid = {
    valid: true,
    identity: {
      displayName: "Requirements",
      surface: "m365-copilot",
      digest: "expected",
      evidence: ["visible-name"]
    }
  };
  /** Runs the driver's check where the real adapter does: after the control became clickable. The
   * composer still holds the typed message unless `composerText` says otherwise. */
  function pressing(
    overrides: Partial<ChatUiAdapter>,
    record: { presses: number; cleared: number },
    composerText = "hello"
  ) {
    return fixtureAdapter({
      findComposer: async () => ({ inputValue: async () => composerText }),
      submitComposer: async (_page, _signal, guard) => {
        await guard!.verifyBeforePress();
        record.presses++;
      },
      clearComposer: async () => {
        record.cleared++;
      },
      ...overrides
    });
  }
  /** A marker for each capture: the first is the verified one, the next the check's. */
  const markers = (
    ...changes: Array<
      Partial<{ url: string; userCount: number; composerValue: string; pressContext: string }>
    >
  ) => {
    let call = 0;
    return async () => ({
      userCount: 0,
      assistantCount: 0,
      url: app,
      identityDigest: "expected",
      composerValue: "hello",
      capturedAt: 0,
      ...changes[Math.min(call++, changes.length - 1)]
    });
  };

  it("hands the adapter the message and the verified marker, and a check that passes when nothing changed", async () => {
    const record = { presses: 0, cleared: 0 };
    let handed: Pick<SubmitGuard, "message" | "marker"> | undefined;
    const adapter = pressing(
      {
        captureSubmissionMarker: markers({ pressContext: "context at verification" }),
        submitComposer: async (_page, _signal, guard) => {
          handed = { message: guard!.message, marker: guard!.marker };
          await guard!.verifyBeforePress();
          record.presses++;
        }
      },
      record
    );
    await expect(
      driver().invoke(plainPage(), conversation(), agent, adapter, { message: "hello" })
    ).resolves.toMatchObject({ submissionState: "sent" });
    expect(handed).toMatchObject({ message: "hello", marker: { pressContext: "context at verification" } });
    expect(record).toEqual({ presses: 1, cleared: 0 });
  });

  it("does not refuse the press for a query or fragment the page added to its address", async () => {
    const record = { presses: 0, cleared: 0 };
    const adapter = pressing(
      { captureSubmissionMarker: markers({}, { url: `${app}?tracking=1#top` }) },
      record
    );
    await expect(
      driver().invoke(plainPage(), conversation(), agent, adapter, { message: "hello" })
    ).resolves.toMatchObject({ submissionState: "sent" });
    expect(record.presses).toBe(1);
  });

  // Independent review: a composer emptied because the message went out another way was reported
  // not-sent. A new user message before the press is unknown, and nothing is pressed or cleared.
  it("refuses the press as unknown, not as not sent, when a user message appeared meanwhile", async () => {
    const record = { presses: 0, cleared: 0 };
    const adapter = pressing(
      { captureSubmissionMarker: markers({}, { userCount: 1, composerValue: "" }) },
      record
    );
    await expect(
      driver().invoke(plainPage(), conversation(), agent, adapter, { message: "hello" })
    ).rejects.toMatchObject({
      code: "SUBMIT_STATE_UNKNOWN",
      message: expect.stringContaining("sent another way"),
      details: { submissionState: "unknown" }
    });
    expect(record).toEqual({ presses: 0, cleared: 0 });
  });

  // Independent re-review: the composer emptied because the message went out another way, with the
  // user bubble rendered only later, was still reported not-sent.
  it("refuses the press as unknown when the page emptied the composer, even before any new user message", async () => {
    const record = { presses: 0, cleared: 0 };
    const adapter = pressing({ captureSubmissionMarker: markers({}, { composerValue: "" }) }, record, "");
    await expect(
      driver().invoke(plainPage(), conversation(), agent, adapter, { message: "hello" })
    ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN", details: { submissionState: "unknown" } });
    expect(record).toEqual({ presses: 0, cleared: 0 });
  });

  it("reports a not-sent failure as unknown when the conversation gained a user message after typing began", async () => {
    let userCount = 0;
    const adapter = fixtureAdapter({
      captureConversationMarker: async () => ({ userCount, assistantCount: 0 }),
      // An editor that sent the lines typed so far, after which the typed text no longer matched.
      fillComposer: async () => {
        userCount = 1;
        throw new BrowserTransportError("UI_CHANGED", "did not retain the message", undefined, {
          submissionState: "not-sent"
        });
      }
    });
    await expect(
      driver().invoke(plainPage(), conversation(), agent, adapter, { message: "first\nsecond" })
    ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN", details: { submissionState: "unknown" } });
  });

  it.each([
    [
      "the agent identity",
      { assertAgentIdentity: undefined },
      "AGENT_CONTEXT_CHANGED",
      "could not be verified"
    ],
    ["the composer text", { composerValue: "changed" }, "UI_CHANGED", "composer changed"],
    ["the page address", { url: `${app}/elsewhere` }, "AGENT_CONTEXT_CHANGED", "page address changed"]
  ] as const)(
    "refuses the press, not sent and with the draft cleared, when %s changed",
    async (_name, change, code, message) => {
      const record = { presses: 0, cleared: 0 };
      let identities = 0;
      const adapter = pressing(
        "assertAgentIdentity" in change
          ? {
              assertAgentIdentity: async () =>
                ++identities <= 2 ? valid : { valid: false, code: "AGENT_IDENTITY_MISMATCH" }
            }
          : { captureSubmissionMarker: markers({}, change) },
        record
      );
      await expect(
        driver().invoke(plainPage(), conversation(), agent, adapter, { message: "hello" })
      ).rejects.toMatchObject({
        code,
        message: expect.stringContaining(message),
        details: { submissionState: "not-sent" }
      });
      expect(record).toEqual({ presses: 0, cleared: 1 });
    }
  );

  it("refuses the press as not sent when the page left the allowed boundary meanwhile", async () => {
    const record = { presses: 0, cleared: 0 };
    let moved = false;
    const adapter = pressing(
      {
        submitComposer: async (_page, _signal, guard) => {
          moved = true;
          await guard!.verifyBeforePress();
          record.presses++;
        }
      },
      record
    );
    await expect(
      driver().invoke(
        plainPage(() => (moved ? "https://outside.example.test/chat" : app)),
        conversation(),
        agent,
        adapter,
        { message: "hello" }
      )
    ).rejects.toMatchObject({ code: "POLICY_BLOCKED", details: { submissionState: "not-sent" } });
    expect(record.presses).toBe(0);
  });

  it("reports an unacknowledged press as unknown, with the metadata-only reason", async () => {
    const adapter = fixtureAdapter({
      waitForUserMessageAck: async () => ({
        state: "unknown",
        reason: "acknowledgement timeout after the send control was activated"
      })
    });
    await expect(
      driver().invoke(plainPage(), conversation(), agent, adapter, { message: "hello" })
    ).rejects.toMatchObject({
      code: "SUBMIT_STATE_UNKNOWN",
      message: expect.stringContaining("acknowledgement timeout after the send control was activated"),
      details: { submissionState: "unknown" }
    });
  });

  const broken = () => new Error("Target page, context or browser has been closed");
  it.each([
    ["while filling", { fillComposer: async () => Promise.reject(broken()) }, "not-sent"],
    [
      "while the send control is being pressed",
      { submitComposer: async () => Promise.reject(broken()) },
      "unknown"
    ],
    [
      "while waiting for the acknowledgement",
      { waitForUserMessageAck: async () => Promise.reject(broken()) },
      "unknown"
    ],
    ["after the acknowledgement", { waitForResponseStart: async () => Promise.reject(broken()) }, "sent"]
  ] as const)(
    "gives a page that failed %s the submission state it reached",
    async (_name, failure, state) => {
      const adapter = fixtureAdapter(failure);
      await expect(
        driver().invoke(plainPage(), conversation(), agent, adapter, { message: "hello" })
      ).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message: "Target page, context or browser has been closed",
        details: { submissionState: state }
      });
    }
  );

  it("keeps a failure's code and adds the state it lacked: an unreadable response was sent", async () => {
    const adapter = fixtureAdapter({
      extractLatestResponse: async () => {
        throw new BrowserTransportError("RESPONSE_EXTRACTION_FAILED", "not isolated");
      }
    });
    await expect(
      driver().invoke(plainPage(), conversation(), agent, adapter, { message: "hello" })
    ).rejects.toMatchObject({ code: "RESPONSE_EXTRACTION_FAILED", details: { submissionState: "sent" } });
  });

  it("never leaves a failure that may have submitted the message retryable", async () => {
    const adapter = fixtureAdapter({
      waitForUserMessageAck: async () => {
        throw new DomainError("BROWSER_CRASHED", "The browser closed.", true);
      }
    });
    await expect(
      driver().invoke(plainPage(), conversation(), agent, adapter, { message: "hello" })
    ).rejects.toMatchObject({
      code: "BROWSER_CRASHED",
      retryable: false,
      options: { submissionState: "unknown" }
    });
  });

  it("does not let a failing progress sink fail the request", async () => {
    await expect(
      driver().invoke(plainPage(), conversation(), agent, fixtureAdapter({}), {
        message: "hello",
        onProgress: () => {
          throw new Error("sink closed");
        }
      })
    ).resolves.toMatchObject({ submissionState: "sent" });
  });
});

describe("conversation progress reporting", () => {
  it("emits ordered metadata-only phases, including a streaming heartbeat", async () => {
    // The response grows by one character at each check.
    let length = 6;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async () => ++length as never,
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
    // Nothing to save, so no saving stage (v0.2.8 review 2026-10-10: progress says what is waited for).
    expect(phases.filter((phase) => phase !== "streaming")).toEqual([
      "asserting-identity",
      "filling",
      "submitting",
      "submitted",
      "waiting-response",
      "extracting",
      "done"
    ]);
    const streaming = events.filter((event) => event.phase === "streaming");
    expect(streaming.length).toBeGreaterThan(0);
    expect(streaming[0]).toMatchObject({ responseChars: 8 });
    expect(events.every((event) => typeof event.elapsedMs === "number")).toBe(true);
    // Progress is metadata only: no prompt or response text may appear in any message.
    expect(events.some((event) => (event.message ?? "").includes("hello"))).toBe(false);
  });

  // v0.2.8 review 2026-10-10: `streaming` says the reply is growing, so it is sent only when the
  // length grew since the previous check. A reply that holds still, or shrinks, sends nothing, and
  // the first check is only the baseline.
  it("sends streaming only when the response grew since the previous check, once per interval", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      // The length each check finds, in order; the first check is the baseline, not a growth from 0.
      const lengths = [40, 40, 25, 60, 60, 61];
      const checkedAt: number[] = [];
      const page: PageLike = {
        url: () => "https://m365.example.test/chat",
        evaluate: async () => {
          checkedAt.push(Date.now());
          return lengths[Math.min(checkedAt.length, lengths.length) - 1] as never;
        },
        on: () => undefined,
        off: () => undefined
      };
      let finishReply!: () => void;
      const adapter = fixtureAdapter({
        waitForResponseComplete: () =>
          new Promise((resolve) => {
            finishReply = () => resolve({ complete: true });
          })
      });
      const events: ProgressEvent[] = [];
      const begun = Date.now();
      const request = new ConversationDriver(
        new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
        undefined,
        { streamingProgressIntervalMs: 10, attachmentSettleMs: 0 }
      ).invoke(page, conversation(), agent, adapter, {
        message: "hello",
        onProgress: (event) => events.push(event)
      });

      // The request is now waiting for the reply: only the baseline has been taken.
      await vi.advanceTimersByTimeAsync(0);
      expect(checkedAt).toEqual([begun]);
      await vi.advanceTimersByTimeAsync(9);
      expect(checkedAt).toHaveLength(1);
      // One check per interval: 40 (same), 25 (shorter), 60 (grew), 60 (same), 61 (grew).
      await vi.advanceTimersByTimeAsync(1);
      for (let tick = 0; tick < 4; tick++) await vi.advanceTimersByTimeAsync(10);
      expect(checkedAt).toEqual([0, 10, 20, 30, 40, 50].map((offset) => begun + offset));
      expect(
        events
          .filter((event) => event.phase === "streaming")
          .map((event) => [event.elapsedMs, event.responseChars])
      ).toEqual([
        [30, 60],
        [50, 61]
      ]);

      // Once the reply is complete nothing is checked any more.
      finishReply();
      await request;
      await vi.advanceTimersByTimeAsync(100);
      expect(checkedAt).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
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

  // v0.2.8 review 2026-10-10: the wait for files that arrive after the answer re-scans every
  // attachmentPollIntervalMs (the transport passes browser.pollIntervalMs) until the set has held
  // still for attachmentSettleMs, and gives up at max(attachmentMaxWaitMs, attachmentSettleMs + one
  // poll) while the set keeps changing.
  describe("the wait for files that arrive after the answer", () => {
    const file = (index: number): AttachmentCandidate => ({
      index,
      name: "report.pdf",
      url: `https://m365.example.test/files/${index}`
    });

    it("honours a settle time longer than attachmentMaxWaitMs: it ends once the set held still that long, not at the cap", async () => {
      const run = await lateFilesWait(
        { attachmentSettleMs: 80, attachmentPollIntervalMs: 20, attachmentMaxWaitMs: 30 },
        () => [file(0)]
      );

      // A scan per poll interval. The set never changed, so the wait ended 80 ms after the first look:
      // past the 30 ms cap, and before settle + one poll (100 ms) would have ended it.
      expect(run.delays).toEqual([20, 20, 20, 20]);
      expect(run.waited).toBe(80);
      expect(run.extractions).toBe(5);
      expect(run.saved).toEqual([file(0)]);
    });

    it.each([
      // Below settle + one poll: the cap is settle + one poll, not attachmentMaxWaitMs.
      { attachmentMaxWaitMs: 30, endsAt: 100, delays: [20, 20, 20, 20, 20] },
      // Above it: the cap is attachmentMaxWaitMs, and the last wait is cut short to end exactly there.
      { attachmentMaxWaitMs: 130, endsAt: 130, delays: [20, 20, 20, 20, 20, 20, 10] }
    ])(
      "ends a set that keeps changing at $endsAt ms with attachmentMaxWaitMs $attachmentMaxWaitMs (settle 80, poll 20)",
      async ({ attachmentMaxWaitMs, endsAt, delays }) => {
        const run = await lateFilesWait(
          { attachmentSettleMs: 80, attachmentPollIntervalMs: 20, attachmentMaxWaitMs },
          // A file nobody has seen before at every scan: the set never holds still.
          (scan) => [file(scan)]
        );

        expect(run.delays).toEqual(delays);
        expect(run.waited).toBe(endsAt);
        expect(run.extractions).toBe(delays.length + 1);
        // Every file seen on the way is still saved.
        expect(run.saved).toEqual(Array.from({ length: delays.length + 1 }, (_, scan) => file(scan)));
      }
    );
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

  it("hands the request's cancellation to the saver and reports a cancel while saving", async () => {
    const controller = new AbortController();
    let savedWith: AbortSignal | undefined;
    const save = vi.fn(async (_page: unknown, _candidates: unknown[], context: { signal?: AbortSignal }) => {
      savedWith = context.signal;
      controller.abort();
      return [{ index: 1, name: "report.pdf", status: "not-saved", stage: "cancelled" }];
    });
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined
    };
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      { save } as never,
      { attachmentSettleMs: 0 }
    );
    await expect(
      driver.invoke(page, conversation(), agent, fixtureAdapter({}), {
        message: "hello",
        signal: controller.signal
      })
    ).rejects.toMatchObject({
      code: "RESPONSE_TIMEOUT",
      message: "The request was cancelled while collecting attachments.",
      details: { submissionState: "sent" }
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(savedWith).toBe(controller.signal);
  });

  it("keeps a response whose files were all handled before a late cancel arrived", async () => {
    const controller = new AbortController();
    const saved = [{ index: 1, name: "report.pdf", status: "saved", localPath: "/tmp/report.pdf" }];
    const save = vi.fn(async () => {
      controller.abort();
      return saved;
    });
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined
    };
    const driver = new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      { save } as never,
      { attachmentSettleMs: 0 }
    );
    await expect(
      driver.invoke(page, conversation(), agent, fixtureAdapter({}), {
        message: "hello",
        signal: controller.signal
      })
    ).resolves.toMatchObject({ attachments: saved });
  });
});

describe("waiting stages and text-only questions (v0.2.8 review 2026-10-10)", () => {
  const page: PageLike = {
    url: () => "https://m365.example.test/chat",
    evaluate: async () => 7 as never,
    on: () => undefined,
    off: () => undefined
  };
  const driver = (save = vi.fn(async () => [])) =>
    new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      { save } as never,
      { attachmentSettleMs: 60, attachmentPollIntervalMs: 10, attachmentMaxWaitMs: 500 }
    );

  it("does not report a reply that holds still as streaming", async () => {
    const adapter = fixtureAdapter({
      waitForResponseComplete: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { complete: true };
      }
    });
    const events: ProgressEvent[] = [];
    await new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      undefined,
      { streamingProgressIntervalMs: 5, attachmentSettleMs: 0 }
    ).invoke(page, conversation(), agent, adapter, {
      message: "hello",
      onProgress: (event) => events.push(event)
    });
    expect(events.some((event) => event.phase === "streaming")).toBe(false);
  });

  it("says what it waits for: confirming the answer, then late files, then saving them", async () => {
    const adapter = fixtureAdapter({
      waitForResponseComplete: async (_page, _marker, _timeout, _signal, onSettling) => {
        onSettling?.();
        onSettling?.();
        return { complete: true };
      },
      extractLatestResponse: async () => ({
        text: "answer",
        citations: [],
        actionRequired: false,
        truncated: false,
        attachmentCandidates: [{ index: 0, name: "report.pdf", url: "https://m365.example.test/f/1" }]
      })
    });
    const events: ProgressEvent[] = [];
    await driver().invoke(page, conversation(), agent, adapter, {
      message: "hello",
      onProgress: (event) => events.push(event)
    });
    expect(events.map((event) => event.phase).filter((phase) => phase !== "streaming")).toEqual([
      "asserting-identity",
      "filling",
      "submitting",
      "submitted",
      "waiting-response",
      "confirming-response",
      "extracting",
      "checking-attachments",
      "saving-attachments",
      "done"
    ]);
  });

  it("does not wait for late files when the question asks for text only, but still saves files shown with the answer", async () => {
    let extractions = 0;
    const candidate = { index: 0, name: "report.pdf", url: "https://m365.example.test/f/1" };
    const adapter = fixtureAdapter({
      extractLatestResponse: async () => {
        extractions++;
        return {
          text: "answer",
          citations: [],
          actionRequired: false,
          truncated: false,
          attachmentCandidates: [candidate]
        };
      }
    });
    const save = vi.fn(async (_page: unknown, _candidates: unknown[]) => []);
    const events: ProgressEvent[] = [];
    await driver(save).invoke(page, conversation(), agent, adapter, {
      message: "hello",
      expectFiles: false,
      onProgress: (event) => events.push(event)
    });
    expect(extractions).toBe(1);
    expect(events.some((event) => event.phase === "checking-attachments")).toBe(false);
    expect(save.mock.calls[0]?.[1]).toEqual([candidate]);
  });

  it("keeps waiting for late files by default", async () => {
    let extractions = 0;
    const adapter = fixtureAdapter({
      extractLatestResponse: async () => {
        extractions++;
        return { text: "answer", citations: [], actionRequired: false, truncated: false };
      }
    });
    await driver().invoke(page, conversation(), agent, adapter, { message: "hello" });
    expect(extractions).toBeGreaterThan(1);
  });

  it("never puts internal attachment candidates into the partial response of a cancelled collection", async () => {
    const controller = new AbortController();
    const adapter = fixtureAdapter({
      extractLatestResponse: async () => {
        controller.abort();
        return {
          text: "answer",
          citations: [{ index: 1, url: "https://example.test/c" }],
          actionRequired: false,
          truncated: false,
          attachmentCandidates: [{ index: 0, name: "secret.pdf", url: "https://m365.example.test/f/1" }]
        };
      }
    });
    const error = await driver()
      .invoke(page, conversation(), agent, adapter, { message: "hello", signal: controller.signal })
      .catch((caught) => caught as BrowserTransportError);
    expect(error).toMatchObject({ code: "RESPONSE_TIMEOUT", details: { submissionState: "sent" } });
    expect(error.details?.partialResponse).toEqual({
      text: "answer",
      citations: [{ index: 1, url: "https://example.test/c" }]
    });
  });

  it("keeps the transport's record of the message current: the count before typing and how far it got", async () => {
    const ok = enteredMessage("hello");
    await driver().invoke(
      page,
      conversation(),
      agent,
      fixtureAdapter({ captureConversationMarker: async () => ({ userCount: 3, assistantCount: 3 }) }),
      { message: "hello", entered: ok }
    );
    expect(ok).toMatchObject({ userCountBefore: 3, state: "sent", digest: enteredMessageDigest("hello") });

    const unknown = enteredMessage("hello");
    await expect(
      driver().invoke(
        page,
        conversation(),
        agent,
        fixtureAdapter({
          waitForUserMessageAck: async () => ({ state: "unknown", reason: "acknowledgement timeout" })
        }),
        { message: "hello", entered: unknown }
      )
    ).rejects.toMatchObject({ code: "SUBMIT_STATE_UNKNOWN" });
    expect(unknown.state).toBe("unknown");

    const notSent = enteredMessage("hello");
    await expect(
      driver().invoke(
        page,
        conversation(),
        agent,
        fixtureAdapter({
          fillComposer: async () => {
            throw new BrowserTransportError("UI_CHANGED", "changed", undefined, {
              submissionState: "not-sent"
            });
          }
        }),
        { message: "hello", entered: notSent }
      )
    ).rejects.toMatchObject({ code: "UI_CHANGED" });
    expect(notSent.state).toBe("not-sent");
  });

  it("digests a message the way the acknowledgement compares the user's bubble", () => {
    expect(enteredMessageDigest("a\u00a0b\r\nc")).toBe(enteredMessageDigest("a b\nc"));
    expect(enteredMessageDigest("a b")).not.toBe(enteredMessageDigest("a  b"));
  });
});

describe("reading a conversation without sending anything (v0.2.8 review 2026-10-10)", () => {
  const app = "https://m365.example.test/chat";
  const page: PageLike = { url: () => app, on: () => undefined, off: () => undefined };
  const driver = (options: { ackTimeoutMs?: number; responseStartTimeoutMs?: number } = {}) =>
    new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      { save: vi.fn(async () => []) } as never,
      {
        ackTimeoutMs: options.ackTimeoutMs ?? 200,
        responseStartTimeoutMs: options.responseStartTimeoutMs ?? 200,
        attachmentSettleMs: 0
      }
    );
  const entry = (state: EnteredMessage["state"], userCountBefore?: number): EnteredMessage => ({
    ...enteredMessage("the question"),
    state,
    ...(userCountBefore === undefined ? {} : { userCountBefore })
  });
  /** One exchange per capture, the last one repeating. */
  const exchanges = (...steps: Array<Partial<ConversationExchange>>) => {
    let call = 0;
    const capture = vi.fn(async () => ({
      userCount: 0,
      assistantCount: 0,
      replyStarted: false,
      ...steps[Math.min(call++, steps.length - 1)]
    }));
    return capture;
  };
  const sendsNothing = {
    fillComposer: async () => {
      throw new Error("read must not type");
    },
    submitComposer: async () => {
      throw new Error("read must not press send");
    }
  };

  it("reports nothing to read when no message was entered in the conversation", async () => {
    const capture = exchanges({});
    await expect(
      driver().read(
        page,
        conversation(),
        agent,
        fixtureAdapter({ ...sendsNothing, captureExchange: capture }),
        {}
      )
    ).resolves.toEqual({ message: "none", reply: "none" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("reports a message that was certainly not sent as not shown, at once", async () => {
    const capture = exchanges({ userCount: 1, latestUserText: "the question", replyStarted: true });
    const started = Date.now();
    await expect(
      driver({ ackTimeoutMs: 5_000 }).read(
        page,
        conversation(),
        agent,
        fixtureAdapter({ ...sendsNothing, captureExchange: capture }),
        { entered: entry("not-sent", 1) }
      )
    ).resolves.toEqual({ message: "not-shown", reply: "none" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("gives an uncertain message the acknowledgement time again, then collects its reply", async () => {
    const capture = exchanges(
      { userCount: 0 },
      { userCount: 0 },
      { userCount: 1, latestUserText: "the question", replyStarted: true, assistantCount: 1 }
    );
    const events: ProgressEvent[] = [];
    await expect(
      driver({ ackTimeoutMs: 2_000 }).read(
        page,
        conversation(),
        agent,
        fixtureAdapter({ ...sendsNothing, captureExchange: capture }),
        {
          entered: entry("unknown", 0),
          onProgress: (event) => events.push(event)
        }
      )
    ).resolves.toEqual({
      message: "shown",
      reply: "complete",
      response: { text: "answer", citations: [], actionRequired: false, truncated: false, attachments: [] }
    });
    expect(events.map((event) => event.phase)).toEqual([
      "asserting-identity",
      "checking-message",
      "extracting",
      "done"
    ]);
  });

  it("reports a message that never appears as not shown once the acknowledgement time has passed", async () => {
    // The page kept the message in its composer and shows no user message added since typing began.
    const capture = exchanges({
      userCount: 2,
      latestUserText: "an earlier question",
      composerText: "the question",
      replyStarted: true
    });
    const started = Date.now();
    await expect(
      driver({ ackTimeoutMs: 300 }).read(
        page,
        conversation(),
        agent,
        fixtureAdapter({ ...sendsNothing, captureExchange: capture }),
        { entered: entry("unknown", 2) }
      )
    ).resolves.toEqual({ message: "not-shown", reply: "none" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  it("reports a message that never appears as unconfirmed, not as not shown, when the page emptied the composer", async () => {
    // Nothing shows that the message left, but nothing shows that it stayed either: the composer is
    // empty, so it may have been taken; only "not shown" lets the caller send it again.
    const capture = exchanges({
      userCount: 2,
      latestUserText: "an earlier question",
      composerText: "",
      replyStarted: true
    });
    const started = Date.now();
    await expect(
      driver({ ackTimeoutMs: 300 }).read(
        page,
        conversation(),
        agent,
        fixtureAdapter({ ...sendsNothing, captureExchange: capture }),
        { entered: entry("unknown", 2) }
      )
    ).resolves.toEqual({ message: "unconfirmed", reply: "none" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  it("does not take an identical earlier message for the one entered last", async () => {
    // The same question was asked and answered before; the last attempt added no user message, and
    // the page kept the message in its composer.
    const capture = exchanges({
      userCount: 1,
      latestUserText: "the question",
      composerText: "the question",
      replyStarted: true
    });
    await expect(
      driver({ ackTimeoutMs: 50 }).read(
        page,
        conversation(),
        agent,
        fixtureAdapter({ ...sendsNothing, captureExchange: capture }),
        { entered: entry("unknown", 1) }
      )
    ).resolves.toEqual({ message: "not-shown", reply: "none" });
  });

  it("reports an identical earlier message with an emptied composer as unconfirmed, not as not shown", async () => {
    // The same earlier question is the latest user message and no user message was added, but the
    // page emptied the composer: the message may have gone out some other way, so it is not "not
    // shown" (and the earlier message is not "shown" for it).
    const capture = exchanges({
      userCount: 1,
      latestUserText: "the question",
      composerText: "",
      replyStarted: true
    });
    await expect(
      driver({ ackTimeoutMs: 50 }).read(
        page,
        conversation(),
        agent,
        fixtureAdapter({ ...sendsNothing, captureExchange: capture }),
        { entered: entry("unknown", 1) }
      )
    ).resolves.toEqual({ message: "unconfirmed", reply: "none" });
  });

  it("says the message differs when another user message appeared, and still reads its reply", async () => {
    const capture = exchanges({
      userCount: 1,
      latestUserText: "the ques",
      replyStarted: true,
      assistantCount: 1
    });
    await expect(
      driver().read(
        page,
        conversation(),
        agent,
        fixtureAdapter({ ...sendsNothing, captureExchange: capture }),
        {
          entered: entry("unknown", 0)
        }
      )
    ).resolves.toMatchObject({ message: "differs", reply: "complete" });
  });

  it("waits for a reply to start and reports none when it does not", async () => {
    const capture = exchanges({ userCount: 1, latestUserText: "the question", replyStarted: false });
    const started = Date.now();
    await expect(
      driver({ responseStartTimeoutMs: 250 }).read(
        page,
        conversation(),
        agent,
        fixtureAdapter({ ...sendsNothing, captureExchange: capture }),
        { entered: entry("sent", 0) }
      )
    ).resolves.toEqual({ message: "shown", reply: "none" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(230);
  });

  it("returns what an unfinished reply showed, without failing", async () => {
    const capture = exchanges({ userCount: 1, latestUserText: "the question", replyStarted: true });
    await expect(
      driver().read(
        page,
        conversation(),
        agent,
        fixtureAdapter({
          ...sendsNothing,
          captureExchange: capture,
          waitForResponseComplete: async () => ({ complete: false, timedOut: true, reason: "timeout" }),
          extractLatestResponse: async () => ({
            text: "half an answer",
            citations: [],
            actionRequired: false,
            truncated: false
          })
        }),
        { entered: entry("sent", 0) }
      )
    ).resolves.toEqual({
      message: "shown",
      reply: "incomplete",
      partialResponse: { text: "half an answer", citations: [] }
    });
  });

  it("refuses to read a page that shows another agent, without claiming anything was sent", async () => {
    const error = await driver()
      .read(
        page,
        conversation(),
        agent,
        fixtureAdapter({
          ...sendsNothing,
          captureExchange: exchanges({}),
          assertAgentIdentity: async () => ({
            valid: false,
            code: "AGENT_IDENTITY_MISMATCH",
            identity: { displayName: "Other", digest: "other", evidence: ["visible-name"] }
          })
        }),
        { entered: entry("unknown", 0) }
      )
      .catch((caught) => caught as BrowserTransportError);
    expect(error).toMatchObject({ code: "AGENT_CONTEXT_CHANGED" });
    expect(error.details?.submissionState).toBeUndefined();
  });

  it("stops at a cancellation while waiting for the message", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const capture = exchanges({ userCount: 0 });
    const started = Date.now();
    await expect(
      driver({ ackTimeoutMs: 5_000 }).read(
        page,
        conversation(),
        agent,
        fixtureAdapter({ ...sendsNothing, captureExchange: capture }),
        { entered: entry("unknown", 0), signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT", message: "Reading the conversation was cancelled." });
    expect(Date.now() - started).toBeLessThan(500);
    expect(capture.mock.calls.length).toBeLessThan(5);
  });

  it("cannot read a page whose adapter cannot capture the exchange", async () => {
    await expect(
      driver().read(page, conversation(), agent, fixtureAdapter({}), { entered: entry("unknown", 0) })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_UI" });
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

/** One request through the driver on a virtual clock (`Date.now()` moves only when the driver
 * waits), for the wait after the answer: `candidatesAt(scan)` is what scan number `scan` finds
 * (scan 0 is the extraction of the answer itself). Reports how long the wait lasted, each wait it
 * asked the page for, how often the answer was extracted, and the candidates handed to the saver. */
async function lateFilesWait(
  options: ConversationDriverOptions,
  candidatesAt: (scan: number) => AttachmentCandidate[]
) {
  let now = 1_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const delays: number[] = [];
    let extractions = 0;
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      on: () => undefined,
      off: () => undefined,
      waitForTimeout: async (ms) => {
        delays.push(ms);
        now += ms;
      }
    };
    const adapter = fixtureAdapter({
      extractLatestResponse: async () => ({
        text: "answer",
        citations: [],
        actionRequired: false,
        truncated: false,
        attachmentCandidates: candidatesAt(extractions++)
      })
    });
    const save = vi.fn(async (_page: unknown, _candidates: unknown[]) => []);
    const begun = now;
    await new ConversationDriver(
      new AgentNavigator(new NavigationPolicy({ appHosts: ["m365.example.test"] })),
      { save } as never,
      options
    ).invoke(page, conversation(), agent, adapter, { message: "hello" });
    return { waited: now - begun, delays, extractions, saved: save.mock.calls[0]?.[1] };
  } finally {
    clock.mockRestore();
  }
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
