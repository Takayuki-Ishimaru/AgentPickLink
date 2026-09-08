import { createInterface } from "node:readline/promises";

/**
 * Injectable terminal interaction surface. Every CLI command that needs to ask the user
 * something goes through this instead of touching `process.stdin`/`process.stdout` directly,
 * so tests can drive commands with a scripted implementation and never block on a real TTY.
 */
export interface Prompter {
  /** True when free-text/selection prompts may actually be shown (a real interactive TTY). */
  readonly interactive: boolean;
  question(text: string): Promise<string>;
  /** Non-interactive callers must resolve `false` rather than block; `--yes` bypass is applied
   * by the caller (see `withYes`), not by the Prompter itself. */
  confirm(text: string): Promise<boolean>;
  select?(text: string, choices: string[]): Promise<string>;
}

/** The real readline/TTY-backed implementation used by the composition root. */
export function createTtyPrompter(): Prompter {
  const interactive = process.stdin.isTTY === true;
  return {
    interactive,
    async question(text: string): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(text)).trim();
      } finally {
        rl.close();
      }
    },
    async confirm(text: string): Promise<boolean> {
      if (!interactive) return false;
      const answer = await this.question(`${text} [y/N] `);
      return /^(y|yes)$/i.test(answer);
    }
  };
}

/** Never blocks and never claims a real terminal is present: `question` rejects (it should
 * never be reachable once a caller checks `interactive` first) and `confirm` always declines. */
export const nonInteractivePrompter: Prompter = {
  interactive: false,
  question: () => Promise.reject(new Error("No interactive terminal is available for this prompt.")),
  confirm: () => Promise.resolve(false)
};

/** Wraps a Prompter so `confirm` short-circuits to `true` when the command was invoked with
 * `--yes`, without every command re-implementing that bypass inline. */
export function withYes(prompter: Prompter, yes: boolean): Prompter {
  if (!yes) return prompter;
  return { ...prompter, confirm: () => Promise.resolve(true) };
}
