<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/readme-header-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="media/readme-header-light.png">
  <img alt="AgentPickLink for M365" src="media/readme-header-dark.png" width="100%">
</picture>

# AgentPickLink for M365

[日本語](release-docs/README.md) | [English](README.en.md)

**v0.1.3 Beta** — A local MCP bridge for asking approved Microsoft 365 agents questions from VS Code.

Sign in to Microsoft 365, select your agents, and approve their use for each workspace. MCP-compatible AI clients can then ask those agents questions, receive response text and citations, and save agent-generated files.

AgentPickLink is **open-source software released under the MIT License**. Third-party software retains its respective licenses.

This is not an official Microsoft product. This beta may encounter connection or extraction failures due to Microsoft 365 interface changes or tenant settings.

## What's new in v0.1.3

- Improved attachment naming to prefer the original filename supplied by Microsoft 365. Japanese characters, spaces, and circled numbers are preserved; different files with the same name receive a numeric suffix.
- Fixed PDF, Office, image, audio, video, and archive attachments being saved without an extension. Missing extensions are filled using source metadata and supported file-format signatures.
- Improved media-type detection when reading files saved without an extension by an earlier version through MCP.
- Improved guidance for AI clients on reading saved PDFs and checking their rendering.

See the [release notes](release-docs/CHANGELOG.md) for details.

## Requirements

- VS Code 1.101 or later, running locally with a single-folder workspace.
- Windows 11 with Microsoft Edge is the primary target. macOS is intended for development and verification, using Edge or Google Chrome.
- A Microsoft 365 work or school account with access to the selected agents. Required licenses and permissions must be obtained separately.
- An AI client that supports MCP.

You can install Node.js 22 or later to provide an explicit runtime. Otherwise, the extension attempts to use VS Code's built-in runtime. Building from source requires Node.js 22 or later and npm.

WSL, Remote SSH, Dev Containers, Codespaces, multi-root workspaces, remote MCP servers, and unattended operation are unsupported. Compatibility with every Microsoft 365 agent or interface layout is not guaranteed.

Public CI runs automated checks on Windows, macOS, and Ubuntu. Ubuntu remains experimental. CI does not verify a live Microsoft 365 tenant or the actual VS Code interface. See the [validation scope](release-docs/DEVELOPMENT.md).

## Installation

1. Download `agent-pick-link-0.1.3.vsix` from **Releases → v0.1.3 (Beta)** on GitHub.
2. In VS Code's Command Palette, run **Extensions: Install from VSIX…** and select the downloaded file.
3. Reload VS Code if prompted.

You can also install it from a terminal:

```sh
code --install-extension agent-pick-link-0.1.3.vsix
```

The VSIX includes the extension, CLI, local broker, and MCP server. Installation from npm or the Marketplace is not part of this beta's distribution procedure.

### Updating from v0.1.0 / v0.1.1 / v0.1.2

Install the v0.1.3 VSIX using the same steps, then reload VS Code. Your existing settings, workspace approvals, and dedicated browser profile can be reused. Check the connection in the panel and select **Connect and refresh** if needed. Restart external AI clients' MCP connections to load the new version as well.

## Update notifications

When VS Code starts, the extension checks the public GitHub releases and notifies you if a newer version is available, including beta releases. Each version is announced once. Open the release page from the notification, download its VSIX, and install it to update. Updates are not installed automatically.

Disable `agentpicklink.checkForUpdates` in VS Code settings to stop checking. If offline, normal startup continues and the extension retries on the next startup. This check does not send your questions or workspace contents.

## Initial setup

1. Open your folder in VS Code and grant workspace trust after reviewing its contents.
2. Open **AgentPickLink** in the activity bar and select **Set up environment**.
3. If a sign-in window opens, sign in with your work or school account. Complete any additional authentication in this dedicated browser window.
4. Select the agents this workspace may use.
5. Under **Client and file settings**, choose the client integrations and file-saving options you need.
6. Select **Approve and save**, then approve the selected agents in the confirmation dialog.

The extension provides a native VS Code MCP definition. Additional integrations you enable are written to their corresponding client configuration files. Restart an external client if it does not recognize the change.

Reopening a configured workspace restores its saved agents and checks its connection. Select **Connect and refresh** to retrieve newly available agents.

## Using an AI client

Enable the `m365-agents` MCP tools in your client. For example, ask it to list the available Microsoft 365 agents and send your question to the agent you select. Calls also follow the client's own tool settings and approval requirements.

| Tool                 | Purpose                                        |
| -------------------- | ---------------------------------------------- |
| `m365_agent_list`    | Check the requested agents and their readiness |
| `m365_agent_ask`     | Ask an approved agent a question               |
| `m365_agent_session` | Create, list, or close ongoing conversations   |

A single-use question automatically closes its conversation after the response is retrieved. For multiple turns, create a session, use it for subsequent questions, and close it when finished. Responses and file generation can take several minutes. Requests are not automatically resent when submission status is uncertain.

## Generated files

File saving is enabled by default. The default allowed download hosts are `*.sharepoint.com` and `onedrive.live.com`. Files are saved under `APL_downloads/<workspace-key>/<request-id>/` in the opened workspace.

Files are retrieved through file-sharing links or download controls in the response. SharePoint / OneDrive links require an authenticated session with permission to access the file. Ordinary page links are not all treated as downloadable files.

Default limits are 10 files per response, 25 MiB per file, and 100 MiB in total. Saved files are not automatically executed or converted. Check their accuracy and safety before use. They may contain sensitive information, so take care when committing files to Git or syncing them externally.

## Data and approval

Questions are sent to the selected Microsoft 365 agent, and retrieved responses are returned to the calling AI client. Follow your organization's policies and send only the information needed. A workspace configuration file alone does not grant access: explicit approval on this machine is required.

Sign-in uses a dedicated browser profile. Do not specify your everyday browser profile. The profile and approval records are stored locally. See [Security and data handling](release-docs/SECURITY.md) for details.

## Documentation and source

The following guides are currently in Japanese:

- [Configuration](release-docs/CONFIGURATION.md)
- [Troubleshooting](release-docs/TROUBLESHOOTING.md)
- [Developer build and test instructions](release-docs/DEVELOPMENT.md)
- [Release notes](release-docs/CHANGELOG.md)

License and dependency information:

- [MIT License](LICENSE)
- [Open-source and third-party software inventory](release-docs/OSS-LICENSES.md) — bilingual introduction and package tables
- [Third-party copyright and license texts](release-docs/THIRD-PARTY-NOTICES.txt)

Developers can download `agent-pick-link-0.1.3-source.zip`. Dependency versions are pinned in `package-lock.json`. From the extracted directory containing `package.json`, run:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run schemas:check
npm run package:vsix
```

The generated VSIX is `dist-vsix/agent-pick-link-0.1.3.vsix`. Browser tests require a locally installed Edge or Chrome; use `M365_AGENT_TEST_BROWSER` to specify a nonstandard executable path. Tests requiring a missing browser or a different operating system are skipped. Some interactive browser tests are skipped when `CI` is set. Tests use local fixtures and temporary data, without Microsoft 365 credentials.
