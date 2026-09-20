/**
 * Pure policy for the environment variables the extension is allowed to write into an on-disk MCP
 * client configuration file (Codex's `~/.codex/config.toml`, Claude Code's `<workspace>/.mcp.json`,
 * VS Code's `<workspace>/.vscode/mcp.json`).
 *
 * `runtime.ts`'s `extraEnvironment()` forwards a handful of `M365_AGENT_DEV_*` variables
 * (`M365_AGENT_DEV_INSECURE_LOOPBACK`, `M365_AGENT_DEV_APP_URL`, `M365_AGENT_ALLOW_UNSUPPORTED_OS`)
 * to *in-memory* consumers only: the broker's own child process (`spawnBroker`) and the VS Code
 * MCP provider's `McpStdioServerDefinition` (which VS Code holds in memory and never writes to
 * disk). None of those development-only overrides may ever be persisted to a file another
 * workspace, another user, or a future session could read -- a stale `M365_AGENT_DEV_APP_URL`
 * committed to `.mcp.json` would silently repoint a real client at a mock server, and a persisted
 * `M365_AGENT_DEV_INSECURE_LOOPBACK=1` would silently relax the HTTPS-only entry-point rule for
 * whoever next runs with that file. `persistedEnvironment()` is the single, pure, unit-testable
 * choke point that keeps that from happening: it allows through only `ELECTRON_RUN_AS_NODE` (when
 * the resolved Node runtime actually needs it) and `M365_AGENT_APP_DATA` (when the user explicitly
 * overrode the application-data directory) -- both of which are safe, non-sensitive, and correct to
 * keep even in another session that reads the same persisted file.
 */

/** The slice of `NodeRuntimeResolution.env` this policy looks at. */
export type PersistableNodeEnv = {
  ELECTRON_RUN_AS_NODE?: string;
};

/**
 * Computes the environment block safe to write into an on-disk MCP client configuration: the
 * Electron-as-Node marker (only when the resolved Node runtime needed it) and an overridden
 * app-data directory (only when one was set) -- and nothing else.
 */
export function persistedEnvironment(
  nodeEnv: Readonly<PersistableNodeEnv>,
  appDataOverride: string | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  if (nodeEnv.ELECTRON_RUN_AS_NODE !== undefined) result.ELECTRON_RUN_AS_NODE = nodeEnv.ELECTRON_RUN_AS_NODE;
  if (appDataOverride !== undefined) result.M365_AGENT_APP_DATA = appDataOverride;
  return result;
}
