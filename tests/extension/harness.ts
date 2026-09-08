/**
 * Shared fixtures for the extension-host tests: a temp-directory-backed `ExtensionRuntime`, a fake
 * webview view, and a programmable stand-in for `SetupService`.
 *
 * The `vscode` module these fixtures (and `src/extension/**`) see is `./vscode-mock.ts`, aliased in
 * vitest.config.ts. Nothing here starts a broker, spawns a process, or writes outside a temp
 * directory: `ExtensionRuntime.node()` and `homeDirectory()` are shadowed on the instance so the
 * real Node probe and the real `~/.codex` never come into play.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NodeRuntimeResolution } from "../../src/extension/node-runtime.js";
import type { PanelState } from "../../src/extension/protocol.js";
import { ExtensionRuntime } from "../../src/extension/runtime.js";
import type { SetupServiceLike } from "../../src/extension/deps.js";
import type { EnsureBrowserChannelResult } from "../../src/services/setup-service.js";
import type {
  AgentCandidate,
  ApplyPlan,
  ApplyResult,
  SetupStatus,
  UpdateConfigResult
} from "../../src/services/setup-service.js";
import type { ProgressSink } from "../../src/domain/progress.js";
import { DomainError } from "../../src/domain/errors.js";
import { createExtensionContext, setWorkspaceRoot, vscodeMock } from "./vscode-mock.js";

/* ---------------------------------------------------------------- runtime */

export const FAKE_NODE: NodeRuntimeResolution = {
  command: "/opt/node22/bin/node",
  env: {},
  kind: "path",
  version: "22.14.0",
  warnings: []
};

export type RuntimeHarness = {
  runtime: ExtensionRuntime;
  context: ReturnType<typeof createExtensionContext>;
  /** A throwaway `$HOME`, so the Codex integration can never touch the real one. */
  home: string;
  /** A throwaway workspace folder, already registered with the vscode mock. */
  workspaceRoot: string;
  extensionRoot: string;
  dispose: () => Promise<void>;
};

/**
 * Builds a real `ExtensionRuntime` over the vscode mock, with the two members that would reach the
 * outside world replaced: `node()` (which otherwise execs `node --version` and walks nvm) and
 * `homeDirectory()` (which otherwise returns the developer's real home).
 */
export async function createRuntimeHarness(
  options: { workspace?: boolean; language?: string } = {}
): Promise<RuntimeHarness> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "apl-ext-"));
  const home = path.join(base, "home");
  const workspaceRoot = path.join(base, "workspace");
  const extensionRoot = path.join(base, "extension");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(extensionRoot, { recursive: true });

  // `appPaths()` reads this in the ExtensionRuntime constructor -- including the one `activate()`
  // builds for itself -- so point it at the temp tree and restore whatever was there on dispose.
  const environmentSnapshot = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("M365_AGENT_"))
  );
  process.env.M365_AGENT_APP_DATA = path.join(base, "appdata");

  if (options.language) vscodeMock.language = options.language;
  setWorkspaceRoot(options.workspace === false ? undefined : workspaceRoot);

  const context = createExtensionContext({ extensionRoot, version: "0.1.0" });
  const runtime = new ExtensionRuntime(context as never);
  Object.assign(runtime, {
    node: () => Promise.resolve(FAKE_NODE),
    homeDirectory: () => home
  });

  return {
    runtime,
    context,
    home,
    workspaceRoot,
    extensionRoot,
    dispose: async () => {
      for (const key of Object.keys(process.env)) if (key.startsWith("M365_AGENT_")) delete process.env[key];
      Object.assign(process.env, environmentSnapshot);
      await fs.rm(base, { recursive: true, force: true });
    }
  };
}

/** Everything written to any output channel this test created, newline joined. */
export function logText(): string {
  return vscodeMock.outputChannels.flatMap((channel) => channel.lines).join("\n");
}

/* ---------------------------------------------------------------- webview */

export type FakeWebviewView = {
  /** Pass this to `SetupViewProvider.resolveWebviewView()`. */
  view: never;
  /** Every `PanelState` the host has posted, oldest first. */
  states: PanelState[];
  last: () => PanelState;
  html: () => string;
  /** Delivers a webview -> host message and awaits whatever action it triggered. */
  send: (message: unknown) => Promise<void>;
  setVisible: (visible: boolean) => void;
  fireDispose: () => void;
};

export function createFakeWebviewView(): FakeWebviewView {
  const states: PanelState[] = [];
  const visibilityListeners: Array<() => void> = [];
  const disposeListeners: Array<() => void> = [];
  let receive: ((message: unknown) => unknown) | undefined;

  const webview = {
    options: {} as unknown,
    html: "",
    cspSource: "vscode-webview://fake",
    asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage(handler: (message: unknown) => unknown) {
      receive = handler;
      return { dispose: () => {} };
    },
    postMessage(message: { type?: string; state?: PanelState }) {
      if (message?.type === "state" && message.state) states.push(message.state);
      return Promise.resolve(true);
    }
  };

  const view = {
    webview,
    visible: true,
    onDidChangeVisibility(listener: () => void) {
      visibilityListeners.push(listener);
      return { dispose: () => {} };
    },
    onDidDispose(listener: () => void) {
      disposeListeners.push(listener);
      return { dispose: () => {} };
    }
  };

  return {
    view: view as never,
    states,
    last: () => states[states.length - 1],
    html: () => webview.html,
    send: async (message: unknown) => {
      await receive?.(message);
    },
    setVisible(visible: boolean) {
      view.visible = visible;
      for (const listener of visibilityListeners) listener();
    },
    fireDispose() {
      for (const listener of disposeListeners) listener();
    }
  };
}

/* ---------------------------------------------------------------- setup service */

export function candidate(overrides: Partial<AgentCandidate> & { key: string }): AgentCandidate {
  return {
    url: `https://m365.cloud.microsoft/chat/agent/${overrides.key}`,
    displayName: overrides.key,
    surface: "m365-copilot",
    source: "sidebar",
    assigned: false,
    ...overrides
  };
}

export function setupStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    platform: { os: "darwin", supported: true },
    browser: { channel: "chrome", installed: true, alternatives: [] },
    broker: {
      live: true,
      authState: { state: "authenticated", checkedAt: "2026-09-05T00:00:00.000Z" },
      incidents: []
    },
    config: {
      headless: true,
      appHosts: ["m365.cloud.microsoft"],
      downloadHosts: [],
      acceptDownloads: false,
      allowedCapabilityClasses: ["knowledge-only"],
      attachmentRetentionHours: 168,
      attachmentQuotaBytes: 1_073_741_824
    },
    workspace: { root: "/tmp/workspace", configured: false, approvalStatus: "not-approved", assignments: [] },
    registry: [],
    ...overrides
  };
}

export function applyResult(overrides: Partial<ApplyResult> = {}): ApplyResult {
  return {
    registered: [],
    workspaceFile: "/tmp/workspace/.m365-agents.json",
    approved: true,
    approvedBindings: [],
    restartRequired: false,
    changedKeys: [],
    ...overrides
  };
}

/**
 * A programmable `SetupService`. Every call is appended to `calls` (name only -- assertions read
 * the dedicated `*Input` fields for arguments), and every result is a field the test can overwrite
 * before or between calls. Setting a `*Error` field makes the next call of that method throw.
 */
export class FakeSetupService implements SetupServiceLike {
  readonly calls: string[] = [];
  async cancelDiscovery(): Promise<{ cancelled: boolean }> {
    this.calls.push("cancelDiscovery");
    return { cancelled: true };
  }

  status_: SetupStatus = setupStatus();
  statusError?: unknown;

  signInState = "authenticated";
  signInError?: unknown;
  signInInputs: Array<{ interactive: boolean }> = [];

  cancelResult = { cancelled: true };

  discovery: { candidates: AgentCandidate[]; warnings: string[]; suggestedDownloadHosts?: string[] } = {
    candidates: [],
    warnings: []
  };
  discoverError?: unknown;

  applyResult_: ApplyResult = applyResult();
  applyError?: unknown;
  appliedPlans: ApplyPlan[] = [];

  removedAliases: string[] = [];
  updateConfigResult: UpdateConfigResult = { restartRequired: false, changedKeys: [] };
  updateConfigPatches: unknown[] = [];
  restartCount = 0;

  /** Progress events every long-running call emits, in order, through the caller's sink. */
  progress: Array<{ phase: string; message?: string; elapsedMs?: number }> = [];

  private emit(onProgress?: ProgressSink): void {
    for (const event of this.progress) onProgress?.(event as never);
  }

  private static reject(error: unknown): never {
    throw error;
  }

  status(): Promise<SetupStatus> {
    this.calls.push("status");
    if (this.statusError) FakeSetupService.reject(this.statusError);
    return Promise.resolve(this.status_);
  }

  browserChannel_: EnsureBrowserChannelResult = { changed: false, channel: "chrome", restartRequired: false };
  async ensureBrowserChannel(): Promise<EnsureBrowserChannelResult> {
    this.calls.push("ensureBrowserChannel");
    return this.browserChannel_;
  }

  async ensureSignedIn(opts: Parameters<SetupServiceLike["ensureSignedIn"]>[0]): Promise<{ state: string }> {
    this.calls.push("ensureSignedIn");
    this.signInInputs.push({ interactive: opts.interactive });
    if (
      opts.interactive &&
      this.status_.broker.authState?.state !== "authenticated" &&
      opts.beforeInteractiveLogin &&
      !(await opts.beforeInteractiveLogin())
    ) {
      throw Object.assign(new DomainError("AUTH_FAILED", "Sign-in was cancelled.", false), {
        details: { cancelled: true }
      });
    }
    this.emit(opts.onProgress);
    if (this.signInError) FakeSetupService.reject(this.signInError);
    return Promise.resolve({ state: this.signInState });
  }

  cancelSignIn(): Promise<{ cancelled: boolean }> {
    this.calls.push("cancelSignIn");
    return Promise.resolve(this.cancelResult);
  }

  discover(
    onProgress?: ProgressSink
  ): Promise<{ candidates: AgentCandidate[]; warnings: string[]; suggestedDownloadHosts?: string[] }> {
    this.calls.push("discover");
    this.emit(onProgress);
    if (this.discoverError) FakeSetupService.reject(this.discoverError);
    return Promise.resolve(this.discovery);
  }

  apply(plan: ApplyPlan, onProgress?: ProgressSink): Promise<ApplyResult> {
    this.calls.push("apply");
    this.appliedPlans.push(plan);
    this.emit(onProgress);
    if (this.applyError) FakeSetupService.reject(this.applyError);
    return Promise.resolve(this.applyResult_);
  }

  removeAgent(alias: string): Promise<SetupStatus> {
    this.calls.push("removeAgent");
    this.removedAliases.push(alias);
    return Promise.resolve(this.status_);
  }

  revokeWorkspace(): Promise<SetupStatus> {
    this.calls.push("revokeWorkspace");
    return Promise.resolve(this.status_);
  }

  signOut(): Promise<void> {
    this.calls.push("signOut");
    return Promise.resolve();
  }

  restartBroker(): Promise<void> {
    this.calls.push("restartBroker");
    this.restartCount += 1;
    return Promise.resolve();
  }

  updateConfig(patch: unknown): Promise<UpdateConfigResult> {
    this.calls.push("updateConfig");
    this.updateConfigPatches.push(patch);
    return Promise.resolve(this.updateConfigResult);
  }
}
