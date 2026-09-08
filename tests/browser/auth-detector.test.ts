import { describe, expect, it } from "vitest";
import { AuthDetector } from "../../src/transports/browser/auth-detector.js";
import type { PageLike } from "../../src/transports/browser/types.js";

function pageWithBody(url: string, body: string, hasStructure: boolean): PageLike {
  return {
    url: () => url,
    evaluate: async (fn: unknown, _arg?: unknown) => {
      const source = String(fn);
      if (source.includes("innerText")) return body;
      // hasStructuralSignal's evaluate body
      return hasStructure;
    }
  };
}

describe("AuthDetector", () => {
  it("requires a structural signal (main region or composer) before reporting authenticated", async () => {
    const detector = new AuthDetector();
    const withStructure = pageWithBody("https://m365.example.test/chat", "Microsoft 365 Copilot", true);
    await expect(detector.detect(withStructure)).resolves.toBe("authenticated");
  });

  it("does not report authenticated on marker text alone, without a chat structural signal", async () => {
    const detector = new AuthDetector();
    const withoutStructure = pageWithBody(
      "https://m365.example.test/marketing",
      "Welcome to Microsoft 365 Copilot",
      false
    );
    await expect(detector.detect(withoutStructure)).resolves.toBe("unknown");
  });

  it("still gives sign-in markers precedence over authenticated marker text", async () => {
    const detector = new AuthDetector();
    const signIn = pageWithBody("https://login.example.test/", "Sign in to Microsoft 365 Copilot", true);
    await expect(detector.detect(signIn)).resolves.toBe("sign-in-required");
  });
});
