import { afterEach, expect, it, vi } from "vitest";
import { assertSupportedTopology } from "../../src/services/workspace-service.js";
const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.restoreAllMocks();
});
it("distinguishes unsupported local Linux from remote execution and keeps remote restrictions with opt-in", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  expect(() => assertSupportedTopology({ NODE_ENV: "production" })).toThrow(
    expect.objectContaining({ code: "PLATFORM_UNSUPPORTED" })
  );
  expect(() =>
    assertSupportedTopology({ NODE_ENV: "production", M365_AGENT_ALLOW_UNSUPPORTED_OS: "1" })
  ).not.toThrow();
  for (const remote of [
    { WSL_DISTRO_NAME: "Ubuntu" },
    { VSCODE_REMOTE_NAME: "ssh-remote" },
    { REMOTE_CONTAINERS: "1" },
    { CODESPACES: "true" }
  ])
    expect(() =>
      assertSupportedTopology({ NODE_ENV: "production", M365_AGENT_ALLOW_UNSUPPORTED_OS: "1", ...remote })
    ).toThrow(expect.objectContaining({ code: "REMOTE_HOST_UNSUPPORTED" }));
});
