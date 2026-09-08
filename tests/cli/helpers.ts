import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appPaths, type AppPaths } from "../../src/config/paths.js";
import { saveRegistry } from "../../src/config/registry.js";
import { saveApprovals } from "../../src/config/approvals.js";
import type { Registry } from "../../src/config/registry.js";
import type { ApprovalStore } from "../../src/domain/approval.js";
import type { BrowserAgentDefinition } from "../../src/domain/agent.js";
import { WorkspaceService } from "../../src/services/workspace-service.js";
import type { CommandDeps } from "../../src/cli/command-deps.js";
import type { Prompter } from "../../src/cli/ui/prompts.js";
import type { LocalStatePreparer } from "../../src/transports/transport.js";
import type { CapturedAgent } from "../../src/transports/transport.js";

/** A minimal fake broker RPC client: records every `call()` and answers from a script keyed by
 * method name. Standing in for the real IpcClient in command tests that only need to observe
 * whether/what was called, never an actual broker process. */
export type FakeBrokerClient = {
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  closed: boolean;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
};

export function makeFakeBrokerClient(
  answers: Record<string, unknown | ((params: Record<string, unknown>) => unknown)> = {}
): FakeBrokerClient {
  const calls: FakeBrokerClient["calls"] = [];
  return {
    calls,
    closed: false,
    async call(method, params) {
      calls.push({ method, params });
      const answer = answers[method];
      if (typeof answer === "function")
        return (answer as (params: Record<string, unknown>) => unknown)(params);
      return answer ?? {};
    },
    close() {
      this.closed = true;
    }
  };
}

/** A scripted Prompter for tests: `question` answers are consumed in order (or by exact-match
 * key), and every `confirm` call is recorded so a test can assert exactly what was asked. */
export function makeScriptedPrompter(
  options: { interactive?: boolean; confirmAnswer?: boolean; questionAnswers?: Record<string, string> } = {}
): Prompter & { confirmCalls: string[]; questionCalls: string[] } {
  const confirmCalls: string[] = [];
  const questionCalls: string[] = [];
  return {
    interactive: options.interactive ?? true,
    confirmCalls,
    questionCalls,
    async question(text: string): Promise<string> {
      questionCalls.push(text);
      return options.questionAnswers?.[text] ?? "";
    },
    async confirm(text: string): Promise<boolean> {
      confirmCalls.push(text);
      return options.confirmAnswer ?? false;
    }
  };
}

export const noopPreparer: LocalStatePreparer = {
  async prepareLocalState() {
    /* no browser profile to prepare under test */
  },
  async verifyLocalState() {
    return { safe: true, owned: true, writable: true };
  }
};

/** Builds a real, temp-directory-backed AppPaths the way tests/unit/init.test.ts and
 * tests/unit/workspace-approval.test.ts do, so commands that go through loadRegistry/
 * loadApprovals/atomicWrite exercise the real file-locking/schema code paths. */
export async function makeTempPaths(prefix = "apl-cli-"): Promise<AppPaths> {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix));
  return appPaths(path.join(base, "appdata"));
}

export async function seedRegistry(paths: AppPaths, agents: BrowserAgentDefinition[]): Promise<void> {
  const registry: Registry = { version: 1, agents };
  await saveRegistry(paths, registry);
}

export async function seedApprovals(paths: AppPaths, store: ApprovalStore): Promise<void> {
  await saveApprovals(paths, store);
}

/** A workspace root directory with `.m365-agents.json` already written, discoverable by
 * WorkspaceService.load() directly (no ancestor climb needed). */
export async function makeWorkspaceRoot(
  agents: Array<{ alias: string; bindingFingerprint?: string }> = []
): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), "apl-workspace-"));
  const root = path.join(base, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, ".m365-agents.json"), JSON.stringify({ version: 1, agents }));
  return root;
}

/** Builds a CommandDeps for a test, plus the stderr/stdout lines it captured (unless a test
 * overrides `stderr`/`stdout` itself, in which case these arrays simply stay empty). */
export function makeCommandDeps(overrides: Partial<CommandDeps> & { paths: AppPaths }): {
  deps: CommandDeps;
  stderrLines: string[];
  stdoutLines: string[];
} {
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];
  const base: CommandDeps = {
    paths: overrides.paths,
    root: () => "/repo",
    env: {},
    clock: () => new Date("2026-09-01T00:00:00.000Z"),
    prompter: makeScriptedPrompter({ interactive: false }),
    stderr: (text) => stderrLines.push(text),
    stdout: (text) => stdoutLines.push(text),
    preparer: noopPreparer,
    workspaces: new WorkspaceService(),
    initializeLocalState: async (paths) => paths,
    connectExistingBroker: async () => undefined,
    connectOrStartDefaultBroker: async () => {
      throw new Error("connectOrStartDefaultBroker was not stubbed for this test");
    },
    terminateDescriptorBroker: async () => ({ stopped: false }),
    readDescriptor: async () => undefined,
    serveStdio: async () => {
      /* no-op default */
    }
  };
  return { deps: { ...base, ...overrides }, stderrLines, stdoutLines };
}

export function capturedAgent(overrides: Partial<CapturedAgent> = {}): CapturedAgent {
  return {
    url: "https://m365.cloud.microsoft/chat/requirements",
    surface: "m365-copilot",
    adapterId: "m365-copilot-chat@1",
    displayName: "Requirements",
    validatedUrlPattern: "^/chat/requirements$",
    ...overrides
  };
}
