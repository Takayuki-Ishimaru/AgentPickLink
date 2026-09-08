import { afterEach, describe, expect, it } from "vitest";
import { startMockChatApp } from "./server.js";

describe("mock Microsoft 365 chat application", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("serves authenticated, unauthenticated, identity, control, response, and submission hazards", async () => {
    const app = await startMockChatApp();
    closers.push(app.close);
    const modes = [
      "authenticated",
      "unauthenticated",
      "wrong-agent",
      "identity-change",
      "multiple-composers",
      "disabled-controls",
      "new-conversation-failure",
      "streaming",
      "stop-control-stream",
      "citations",
      "action-controls",
      "delayed",
      "partial-timeout",
      "crash-before-submit",
      "crash-after-submit",
      "duplicate-send",
      "ack-absent",
      "send-noop",
      "ack-ambiguous"
    ];
    for (const mode of modes) {
      const response = await fetch(`${app.origin}/chat?mode=${mode}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        mode === "unauthenticated" ? "サインイン" : 'data-surface="m365-copilot"'
      );
    }
  });
});
