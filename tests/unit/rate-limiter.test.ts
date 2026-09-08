import { describe, expect, it } from "vitest";
import { InvocationLimiter } from "../../src/services/rate-limiter.js";

describe("InvocationLimiter", () => {
  it("enforces broker-wide concurrency", async () => {
    const limiter = new InvocationLimiter(1, 10);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = limiter.run("workspace-a", async () => {
      await gate;
      return "done";
    });
    await expect(limiter.run("workspace-b", async () => "other")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true
    });
    release();
    await expect(first).resolves.toBe("done");
  });

  it("enforces the per-workspace rolling minute limit", async () => {
    const limiter = new InvocationLimiter(2, 1);
    await limiter.run("workspace-a", async () => undefined);
    await expect(limiter.run("workspace-a", async () => undefined)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true
    });
    await expect(limiter.run("workspace-b", async () => "allowed")).resolves.toBe("allowed");
  });
});
