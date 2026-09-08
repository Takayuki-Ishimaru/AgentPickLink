import { DomainError } from "../domain/errors.js";
export class InvocationLimiter {
  private active = 0;
  private readonly timestamps = new Map<string, number[]>();
  constructor(
    private readonly maxConcurrent: number,
    private readonly maxPerMinute: number
  ) {}
  async run<T>(workspaceKey: string, operation: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const prior = (this.timestamps.get(workspaceKey) ?? []).filter((value) => now - value < 60_000);
    if (prior.length >= this.maxPerMinute)
      throw new DomainError("RATE_LIMITED", "The workspace invocation rate limit has been reached.", true, {
        retryAfterMs: 60_000 - (now - prior[0]!)
      });
    if (this.active >= this.maxConcurrent)
      throw new DomainError(
        "RATE_LIMITED",
        "The broker invocation concurrency limit has been reached.",
        true,
        { retryAfterMs: 1000 }
      );
    prior.push(now);
    this.timestamps.set(workspaceKey, prior);
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
    }
  }
}
