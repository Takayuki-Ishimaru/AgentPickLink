/**
 * A resettable, dependency-free stand-in for the `vscode` module.
 *
 * `vitest.config.ts` aliases the bare specifier `vscode` to this file, so `import * as vscode from
 * "vscode"` inside `src/extension/**` resolves here when the extension modules are loaded from a
 * test. Only the surface the extension actually touches is implemented (see the grep of
 * `vscode.<member>` usages in src/extension) -- everything else is deliberately absent so a new API
 * dependency fails loudly instead of silently doing nothing.
 *
 * Everything observable is collected on the exported `vscodeMock` object; `resetVscodeMock()` puts
 * it back to a pristine state and must be called from a `beforeEach` in every suite that touches
 * the extension.
 */
import path from "node:path";

/* ------------------------------------------------------------------ primitives */

export type MockDisposable = { dispose: () => void };

function disposable(dispose: () => void = () => {}): MockDisposable {
  return { dispose };
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => unknown>();

  readonly event = (listener: (value: T) => unknown): MockDisposable => {
    this.listeners.add(listener);
    return disposable(() => {
      this.listeners.delete(listener);
    });
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  static from(...items: MockDisposable[]): Disposable {
    return new Disposable(() => {
      for (const item of items) item.dispose();
    });
  }
  dispose(): void {
    this.callOnDispose();
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;

/** Enough of `vscode.Uri` for `Uri.file`/`Uri.joinPath`/`Uri.parse` and `fsPath`. */
export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query = "",
    readonly fragment = ""
  ) {}

  static file(fsPath: string): Uri {
    return new Uri("file", "", fsPath);
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!match) return new Uri("file", "", value);
    return new Uri(match[1], match[2], match[3] || "/", match[4] ?? "", match[5] ?? "");
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, base.authority, path.posix.join(base.path, ...segments));
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    const suffix = `${this.query ? `?${this.query}` : ""}${this.fragment ? `#${this.fragment}` : ""}`;
    return `${this.scheme}://${this.authority}${this.path}${suffix}`;
  }
}

/** VS Code 1.101+'s MCP stdio definition; `cwd` is assigned after construction, as in the real API. */
export class McpStdioServerDefinition {
  cwd?: Uri;
  constructor(
    readonly label: string,
    readonly command: string,
    readonly args: string[] = [],
    readonly env: Record<string, string | number | null> = {},
    readonly version?: string
  ) {}
}

/* ------------------------------------------------------------------ recordings */

export type MessageKind = "information" | "warning" | "error";

export type RecordedMessage = {
  kind: MessageKind;
  message: string;
  /** The modal/detail options object, when the call passed one. */
  options?: { modal?: boolean; detail?: string };
  /** The action button labels offered to the user. */
  items: string[];
};

export type MockOutputChannel = {
  name: string;
  lines: string[];
  shown: boolean;
  disposed: boolean;
  appendLine: (value: string) => void;
  append: (value: string) => void;
  replace: (value: string) => void;
  clear: () => void;
  info: (value: string) => void;
  warn: (value: string) => void;
  error: (value: string) => void;
  debug: (value: string) => void;
  trace: (value: string) => void;
  show: (preserveFocus?: boolean) => void;
  hide: () => void;
  dispose: () => void;
};

export type MockStatusBarItem = {
  alignment: number;
  priority?: number;
  text: string;
  tooltip?: string;
  command?: string;
  backgroundColor?: ThemeColor;
  shown: boolean;
  disposed: boolean;
  show: () => void;
  hide: () => void;
  dispose: () => void;
};

export type MockWorkspaceFolder = { uri: Uri; name: string; index: number };

export type ConfigurationUpdate = { key: string; value: unknown; target: number | undefined };

export type VscodeMockState = {
  /** Every `showInformationMessage`/`showWarningMessage`/`showErrorMessage` call, in order. */
  messages: RecordedMessage[];
  /** Answers the next message box(es) with; the first matching entry wins and is consumed. */
  answer: (call: RecordedMessage) => string | undefined;
  commands: Map<string, (...args: unknown[]) => unknown>;
  registeredCommands: string[];
  executedCommands: Array<{ command: string; args: unknown[] }>;
  webviewProviders: Array<{ viewType: string; provider: unknown; options?: unknown }>;
  statusBarItems: MockStatusBarItem[];
  outputChannels: MockOutputChannel[];
  /** Providers handed to `lm.registerMcpServerDefinitionProvider`. */
  mcpProviders: Array<{ id: string; provider: unknown }>;
  /** Text written through `env.clipboard.writeText`. */
  clipboard: string[];
  language: string;
  isTrusted: boolean;
  workspaceFolders: MockWorkspaceFolder[] | undefined;
  /** Fully qualified setting id (`agentpicklink.autoStartBroker`) to value. */
  configuration: Map<string, unknown>;
  configurationUpdates: ConfigurationUpdate[];
  /** Fires `workspace.onDidGrantWorkspaceTrust` listeners. */
  grantWorkspaceTrust: () => void;
  /** Fires `workspace.onDidChangeConfiguration` listeners for the given setting id. */
  changeConfiguration: (affects: string) => void;
};

const trustEmitter = new EventEmitter<void>();
const configurationEmitter = new EventEmitter<{ affectsConfiguration: (section: string) => boolean }>();

function freshState(): VscodeMockState {
  return {
    messages: [],
    answer: () => undefined,
    commands: new Map(),
    registeredCommands: [],
    executedCommands: [],
    webviewProviders: [],
    statusBarItems: [],
    outputChannels: [],
    mcpProviders: [],
    clipboard: [],
    language: "en",
    isTrusted: true,
    workspaceFolders: undefined,
    configuration: new Map(),
    configurationUpdates: [],
    grantWorkspaceTrust: () => trustEmitter.fire(),
    changeConfiguration: (affects: string) =>
      configurationEmitter.fire({
        affectsConfiguration: (section: string) => affects === section || affects.startsWith(`${section}.`)
      })
  };
}

/** The single, mutable observation point shared by the mock module and the tests. */
export const vscodeMock: VscodeMockState = freshState();

/** Puts every recording, setting and listener back to its pristine state. */
export function resetVscodeMock(): void {
  trustEmitter.dispose();
  configurationEmitter.dispose();
  Object.assign(vscodeMock, freshState());
  lm.registerMcpServerDefinitionProvider = defaultRegisterMcpServerDefinitionProvider;
}

/** Convenience: answer the next message box carrying `label` with that same label ("press it"). */
export function answerWith(...labels: string[]): void {
  const pending = [...labels];
  vscodeMock.answer = (call) => {
    const index = pending.findIndex((label) => call.items.includes(label));
    return index >= 0 ? pending.splice(index, 1)[0] : undefined;
  };
}

/* ------------------------------------------------------------------ namespaces */

function recordMessage(kind: MessageKind, message: string, rest: unknown[]): Promise<string | undefined> {
  const [first, ...others] = rest;
  const hasOptions = typeof first === "object" && first !== null;
  const options = hasOptions ? (first as RecordedMessage["options"]) : undefined;
  const items = (hasOptions ? others : rest).filter((item): item is string => typeof item === "string");
  const call: RecordedMessage = { kind, message, ...(options ? { options } : {}), items };
  vscodeMock.messages.push(call);
  return Promise.resolve(vscodeMock.answer(call));
}

export const window = {
  createOutputChannel(name: string, _options?: { log?: boolean }): MockOutputChannel {
    const channel: MockOutputChannel = {
      name,
      lines: [],
      shown: false,
      disposed: false,
      appendLine: (value) => void channel.lines.push(value),
      append: (value) => void channel.lines.push(value),
      replace: (value) => {
        channel.lines = [value];
      },
      clear: () => {
        channel.lines = [];
      },
      info: (value) => void channel.lines.push(value),
      warn: (value) => void channel.lines.push(value),
      error: (value) => void channel.lines.push(value),
      debug: (value) => void channel.lines.push(value),
      trace: (value) => void channel.lines.push(value),
      show: () => {
        channel.shown = true;
      },
      hide: () => {
        channel.shown = false;
      },
      dispose: () => {
        channel.disposed = true;
      }
    };
    vscodeMock.outputChannels.push(channel);
    return channel;
  },

  showInformationMessage: (message: string, ...rest: unknown[]): Promise<string | undefined> =>
    recordMessage("information", message, rest),
  showWarningMessage: (message: string, ...rest: unknown[]): Promise<string | undefined> =>
    recordMessage("warning", message, rest),
  showErrorMessage: (message: string, ...rest: unknown[]): Promise<string | undefined> =>
    recordMessage("error", message, rest),

  registerWebviewViewProvider(viewType: string, provider: unknown, options?: unknown): MockDisposable {
    vscodeMock.webviewProviders.push({ viewType, provider, ...(options ? { options } : {}) });
    return disposable();
  },

  createStatusBarItem(alignment = StatusBarAlignment.Left, priority?: number): MockStatusBarItem {
    const item: MockStatusBarItem = {
      alignment,
      ...(priority === undefined ? {} : { priority }),
      text: "",
      shown: false,
      disposed: false,
      show: () => {
        item.shown = true;
      },
      hide: () => {
        item.shown = false;
      },
      dispose: () => {
        item.disposed = true;
      }
    };
    vscodeMock.statusBarItems.push(item);
    return item;
  }
};

export const commands = {
  registerCommand(command: string, callback: (...args: unknown[]) => unknown): MockDisposable {
    vscodeMock.commands.set(command, callback);
    vscodeMock.registeredCommands.push(command);
    return disposable(() => void vscodeMock.commands.delete(command));
  },
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    vscodeMock.executedCommands.push({ command, args });
    const handler = vscodeMock.commands.get(command);
    return handler ? await handler(...args) : undefined;
  }
};

class MockWorkspaceConfiguration {
  constructor(private readonly section?: string) {}

  private id(key: string): string {
    return this.section ? `${this.section}.${key}` : key;
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    const id = this.id(key);
    return vscodeMock.configuration.has(id) ? (vscodeMock.configuration.get(id) as T) : defaultValue;
  }

  has(key: string): boolean {
    return vscodeMock.configuration.has(this.id(key));
  }

  inspect(): undefined {
    return undefined;
  }

  update(key: string, value: unknown, target?: number): Promise<void> {
    vscodeMock.configuration.set(this.id(key), value);
    vscodeMock.configurationUpdates.push({ key: this.id(key), value, target });
    return Promise.resolve();
  }
}

export const workspace = {
  get workspaceFolders(): MockWorkspaceFolder[] | undefined {
    return vscodeMock.workspaceFolders;
  },
  get isTrusted(): boolean {
    return vscodeMock.isTrusted;
  },
  getConfiguration(section?: string): MockWorkspaceConfiguration {
    return new MockWorkspaceConfiguration(section);
  },
  onDidGrantWorkspaceTrust: trustEmitter.event,
  onDidChangeConfiguration: configurationEmitter.event
};

export const env = {
  get language(): string {
    return vscodeMock.language;
  },
  clipboard: {
    writeText(value: string): Promise<void> {
      vscodeMock.clipboard.push(value);
      return Promise.resolve();
    }
  }
};

const defaultRegisterMcpServerDefinitionProvider = (id: string, provider: unknown): MockDisposable => {
  vscodeMock.mcpProviders.push({ id, provider });
  return disposable();
};

/** Mutable so a test can delete the member and exercise the feature-detection fallback. */
export const lm: {
  registerMcpServerDefinitionProvider?: (id: string, provider: unknown) => MockDisposable;
} = { registerMcpServerDefinitionProvider: defaultRegisterMcpServerDefinitionProvider };

export const extensions = {
  getExtension(): undefined {
    return undefined;
  },
  all: [] as unknown[]
};

export const version = "1.101.0";

/* ------------------------------------------------------------------ fixtures */

export type MockExtensionContext = {
  subscriptions: MockDisposable[];
  extensionUri: Uri;
  extension: { packageJSON: { version: string } };
};

/** The `vscode.ExtensionContext` slice `ExtensionRuntime` reads. */
export function createExtensionContext(
  options: { extensionRoot?: string; version?: string } = {}
): MockExtensionContext {
  return {
    subscriptions: [],
    extensionUri: Uri.file(options.extensionRoot ?? "/tmp/apl-extension"),
    extension: { packageJSON: { version: options.version ?? "0.1.0" } }
  };
}

/** Registers a workspace folder (or clears it when `root` is undefined). */
export function setWorkspaceRoot(root: string | undefined): void {
  vscodeMock.workspaceFolders = root
    ? [{ uri: Uri.file(root), name: path.basename(root), index: 0 }]
    : undefined;
}
