import path from "node:path";
import os from "node:os";
export type AppPaths = {
  root: string;
  config: string;
  registry: string;
  approvals: string;
  profile: string;
  broker: string;
  descriptor: string;
  startupLock: string;
  logs: string;
  diagnostics: string;
  attachments: string;
};
export function appPaths(
  base = process.env.M365_AGENT_APP_DATA ??
    (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "M365AgentWorkspace")
      : path.join(os.homedir(), ".local", "share", "M365AgentWorkspace"))
): AppPaths {
  return {
    root: base,
    config: path.join(base, "config.yaml"),
    registry: path.join(base, "agents.yaml"),
    approvals: path.join(base, "approvals.json"),
    profile: path.join(base, "browser-profile"),
    broker: path.join(base, "broker"),
    descriptor: path.join(base, "broker", "descriptor.json"),
    startupLock: path.join(base, "broker", "startup.lock"),
    logs: path.join(base, "logs"),
    diagnostics: path.join(base, "diagnostics"),
    attachments: path.join(base, "attachments")
  };
}
