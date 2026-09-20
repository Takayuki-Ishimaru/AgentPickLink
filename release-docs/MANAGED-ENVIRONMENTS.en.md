# Managed environments: administrator notes

[日本語](MANAGED-ENVIRONMENTS.md) | [English](MANAGED-ENVIRONMENTS.en.md)

This page is for IT/security administrators evaluating or deploying AgentPickLink's **extension-less
install path**: a portable archive that a user downloads from the GitHub Release, extracts, and runs once
(`apl-setup <workspace>`) instead of installing the VS Code extension. This path is implemented in
**v0.2.0**. Installation, upgrade, rollback, coexistence with the VSIX and uninstall were verified on a
Windows 11 x64 machine with a work account between 2026-09-13 and 2026-09-17. Environment-dependent
acceptance checks, including SmartScreen, AppLocker / WDAC and native runs on Windows ARM64 and Linux, must
be completed separately before distribution.

## What gets registered, and with what identity

`apl-setup` writes a small set of files, one per detected MCP client, and every one of them uses the same
fixed, version-independent identity:

- Windows: `command` = `<home>\bin\node.exe`, `args` = `["<home>\bin\apl.js", "serve"]`
- macOS / Linux: `command` = `<home>/bin/node`, `args` = `["<home>/bin/apl.js", "serve"]`

Because the identity never changes across versions, upgrading (re-running `apl-setup` from a newer archive)
never rewrites a client's configuration file — only the files under `<home>` change. Two environment keys
appear in every entry `apl-setup` writes:

- `M365_AGENT_MANAGED=1` — an ownership marker. `apl integrations remove` and `apl self uninstall` only
  ever modify or delete an entry that carries this marker; a hand-written or renamed `m365-agents` entry is
  left untouched and reported instead.
- `M365_AGENT_BUILD=<version>+<build>` — written only into workspace-file entries (`.vscode/mcp.json`,
  `.mcp.json`), so VS Code's own launch-hash cache treats an upgraded server as changed and refreshes its
  tool list. `serve` does not read this variable; it has no effect on behavior.

Any other `M365_AGENT_*` variable already present in the environment the client process inherits (for
example one set machine-wide by policy) is passed through unchanged; `apl-setup` does not add configuration
variables beyond the two above.

**This is a different command line from the VS Code extension.** The extension registers
`<node> <extension-install-dir>/dist/cli/index.js serve` through VS Code's own MCP provider API. A site that
previously allowlisted that command line (for the VSIX) will need a separate allowlist entry for the
archive's `<home>/bin/node` + `<home>/bin/apl.js serve` identity if both are permitted to coexist.

## What is written, and where

`<home>` is `%LOCALAPPDATA%\AgentPickLink\` on Windows and `~/.local/share/AgentPickLink/` on macOS/Linux —
always a local, per-user, non-roaming path. `--home <dir>` or `M365_AGENT_INSTALL_ROOT` moves it, for
example onto a path your execution-control policy already approves (see below).

```
<home>/
  bin/node | bin/node.exe   the bundled runtime (see "Runtime provenance" below)
  bin/apl.js                launcher that imports the current app/<version>/dist/cli/index.js
  bin/apl | bin/apl.cmd     human-facing shim for `doctor`, `self`, `integrations`; never spawned by hosts
  app/<version>/            the installed package; older versions are kept until `apl self prune`
  install.json              { version, platform, nodeVersion, home, clients: [...], workspaces: [...] }
```

Per-client files, written only for clients `apl-setup` detects on the machine, and named exactly as the
client itself expects them:

| Client                         | File                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| VS Code (workspace, default)   | `<workspace>/.vscode/mcp.json`                                                      |
| VS Code (user profile, opt-in) | `%APPDATA%\Code\User\mcp.json` / `~/Library/Application Support/Code/User/mcp.json` |
| Claude Code                    | `<workspace>/.mcp.json`                                                             |
| Codex                          | `~/.codex/config.toml` (`[mcp_servers.m365-agents]`)                                |

Per workspace, `apl-setup` also writes `<workspace>/.m365-agents.json` (the requested agent aliases for that
folder) and records the workspace in `<home>/install.json`. Neither file grants access by itself: an
explicit local approval, recorded separately, is still required before any agent can be invoked (see
"Approval stays per workspace" below).

## Network behavior

The CLI makes no network calls of its own beyond what signing in to Microsoft 365 and talking to agents
inherently requires, with exactly one opt-in exception: `apl doctor --check-updates`, which checks the
public GitHub Releases API and is never invoked automatically or from `serve`. Offline and air-gapped
machines are supported: the archive contains the runtime and every dependency, so `apl-setup` runs entirely
from local disk.

## Runtime provenance and integrity

- **Bundled Node.js.** The version currently pinned by the release you downloaded is reported by
  `apl doctor` and recorded in `install.json`. It is the official binary from `nodejs.org`, verified against
  `nodejs.org`'s own `SHASUMS256.txt` at archive-build time — not a custom or re-built binary.
- **Code signing.** On Windows, the bundled `node.exe` is Authenticode-signed; Node.js 24.21.0 x64 was verified on Windows 11 on 2026-09-13 using `Get-AuthenticodeSignature`
  (status `Valid`, publisher **OpenJS Foundation**). Recheck each downloaded runtime, for example with
  Sysinternals `sigcheck -a bin\node.exe`. On macOS, the bundled `node` binary is code-signed; verify with
  `codesign -dv --verbose=4 bin/node`.
- **Archive integrity.** Every GitHub Release includes a `SHA256SUMS` file alongside the archives. Verify
  the archive you downloaded against it before extracting (`shasum -a 256 -c SHA256SUMS` on macOS/Linux, or
  `CertUtil -hashfile <file> SHA256` compared by eye on Windows) rather than trusting the download alone.
- **The launcher scripts are plain and readable.** `apl-setup` / `apl-setup.cmd` are short, uncompiled
  scripts, not a piped or opaque installer. Read them before running them — each is a two-line wrapper that
  invokes the sibling bundled runtime against the sibling package with no network access of its own.

## Execution-control policy (AppLocker / WDAC)

`<home>/bin` is a per-user, non-`Program Files` directory. Default AppLocker/WDAC executable rules commonly
allow only `Program Files` and `Windows`, which will block `<home>\bin\node.exe` outright. Two options,
either of which is sufficient:

1. Add a publisher rule for the Node.js signing certificate (see "Code signing" above), which then covers
   the bundled runtime wherever it is installed.
2. Point the install at a path your policy already allows: `apl-setup --home <approved-path>` or the
   `M365_AGENT_INSTALL_ROOT` environment variable.

`apl doctor` reports a launch failure here explicitly rather than failing silently.

## MCP policy and per-client allowlists

VS Code, Claude Code and Codex each gate MCP servers with their own policy, independent of whether the
server is registered by the extension or by file:

- **VS Code.** The `ChatMCP` policy (`chat.mcp.access`) deployed through VS Code's ADMX/Intune templates can
  restrict MCP to `none`, an internal registry, or an explicit allow/deny list. Where this value is readable
  (user `settings.json`, or the policy key under `HKCU`/`HKLM\SOFTWARE\Policies\Microsoft\VSCode`),
  `apl doctor` and the setup plan step name it explicitly instead of failing generically. A policy value
  deployed but not locally readable is not detected, and setup says so.
- **Claude Code.** `managed-mcp.json` and the `allowedMcpServers` setting can restrict which server entries
  are honored.
- **Codex.** No separate device-policy layer is documented for MCP servers beyond the `config.toml` entry
  itself; the entry's presence is the enablement mechanism.

A client that is installed but blocked by policy is reported as such, not silently skipped.

## The browser profile, and why approval stays per workspace

Signing in to Microsoft 365 uses a dedicated, isolated browser profile under `<home>`'s companion
application-data directory (not `<home>` itself) — see [`SECURITY.md`](SECURITY.md) (Japanese; the
authentication and approval sections apply unchanged to the archive install path) for what it holds and how
it is protected. `apl-setup` writing a client's configuration file is not, by itself, consent
to use any agent: a workspace only gets a usable MCP server after its agents are explicitly approved on that
machine, and that approval is scoped to the one normalized workspace path it was granted for. Copying a
workspace's `.vscode/mcp.json`/`.mcp.json` to another machine or another folder does not carry the approval
with it.

## VS Code workspace trust and MCP start-up

VS Code treats every `mcp.json`-defined server as trusted and shows no per-server trust dialog. A server
defined in a workspace-scoped file (`<workspace>/.vscode/mcp.json`, `<workspace>/.mcp.json`) is, however,
gated on **workspace trust**: if the folder is not yet trusted, VS Code asks for it before starting the server.
A server defined in the user-profile
`mcp.json` (`%APPDATA%\Code\User\mcp.json`) has no such gate and, with the default `chat.mcp.autostart`,
starts on the first chat message.

`apl-setup` therefore registers VS Code in the user-profile `mcp.json` and Claude Code in the user scope
(`claude mcp add-json … --scope user`) by default. Workspace files are written only with
`--clients vscode-workspace` / `--clients claude-project`; expect VS Code to ask for folder trust on first
start and Claude Code to ask for project-server approval in that case. VS Code's own prompt for a folder that
has never been opened before is unrelated to MCP and does not appear for folders already in use.

Registration is not authorisation. Regardless of how the server was registered, every tool call still requires
the local, per-workspace approval described above (`.m365-agents.json` plus the approval record in app data);
a folder that was never set up, an empty window, or a multi-root window gets `WORKSPACE_NOT_CONFIGURED` per
call. See [Security](SECURITY.md) for approval and data-protection details.

## Before you deploy

1. Read `apl-setup` / `apl-setup.cmd` yourself; they are short and uncompiled.
2. Verify `SHA256SUMS` against the archive you intend to distribute.
3. Decide your AppLocker/WDAC approach (publisher rule vs. `--home`) before rolling out to end users.
4. Confirm which of VS Code / Claude Code / Codex your policy allows, and pre-stage the corresponding
   allowlist entries above.
5. See [`README.en.md`](README.en.md) for the end-user steps and [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
   for what a blocked or misconfigured install looks like from the user's side.

### vscode-user workspace scope

`--clients vscode-user` supports exactly one folder and fixes `cwd` to it. Multiple folders are rejected
before writing; use `--clients vscode` for per-workspace files instead. Empty and multi-root windows do
not dynamically select a folder. Re-registering another folder reports a warning. There is no
`code --add-mcp` fallback: unwritable configuration produces a snippet. Check the result with `apl doctor`.
