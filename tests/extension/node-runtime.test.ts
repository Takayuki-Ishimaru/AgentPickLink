import { describe, expect, it } from "vitest";
import { parseNodeMajor, resolveNodeRuntime, type NodeProbe } from "../../src/extension/node-runtime.js";

type ProbeOverrides = Partial<NodeProbe> & { versions?: Record<string, string> };

function probe(overrides: ProbeOverrides = {}): NodeProbe {
  const versions = overrides.versions ?? {};
  return {
    run: async (command, args) => {
      expect(args).toEqual(["--version"]);
      const version = versions[command];
      if (version === undefined) throw new Error(`ENOENT ${command}`);
      return `${version}\n`;
    },
    listDirectory: async () => [],
    platform: "darwin",
    env: {},
    homedir: "/Users/tester",
    execPath: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    ...overrides
  };
}

describe("parseNodeMajor", () => {
  it("reads the major version with or without the v prefix", () => {
    expect(parseNodeMajor("v22.14.0")).toBe(22);
    expect(parseNodeMajor("24.0.1\n")).toBe(24);
  });

  it("returns undefined for unparseable output", () => {
    expect(parseNodeMajor("not a version")).toBeUndefined();
  });
});

describe("resolveNodeRuntime", () => {
  it("prefers the configured path when it satisfies the minimum version", async () => {
    const resolution = await resolveNodeRuntime(
      "/custom/node",
      probe({ versions: { "/custom/node": "v22.14.0", node: "v22.14.0" } })
    );
    expect(resolution).toMatchObject({ command: "/custom/node", kind: "configured", version: "22.14.0" });
    expect(resolution.env).toEqual({});
    expect(resolution.warnings).toEqual([]);
  });

  it("falls through to PATH and warns when the configured path is too old", async () => {
    const resolution = await resolveNodeRuntime(
      "/custom/node",
      probe({ versions: { "/custom/node": "v18.20.0", node: "v22.14.0" } })
    );
    expect(resolution.kind).toBe("path");
    expect(resolution.command).toBe("node");
    expect(resolution.warnings.join(" ")).toContain("agentpicklink.nodePath");
  });

  it("uses a well-known macOS location when node is not on PATH", async () => {
    const resolution = await resolveNodeRuntime(
      undefined,
      probe({ versions: { "/opt/homebrew/bin/node": "v23.1.0" } })
    );
    expect(resolution).toMatchObject({ command: "/opt/homebrew/bin/node", kind: "known-location" });
  });

  it("picks the newest nvm install that satisfies the minimum", async () => {
    const resolution = await resolveNodeRuntime(
      undefined,
      probe({
        listDirectory: async (directory) => {
          expect(directory).toBe("/Users/tester/.nvm/versions/node");
          return ["v20.11.0", "v22.9.0", "v24.2.0"];
        },
        versions: {
          "/Users/tester/.nvm/versions/node/v24.2.0/bin/node": "v24.2.0",
          "/Users/tester/.nvm/versions/node/v22.9.0/bin/node": "v22.9.0"
        }
      })
    );
    expect(resolution.command).toBe("/Users/tester/.nvm/versions/node/v24.2.0/bin/node");
  });

  it("checks the Windows install locations on win32", async () => {
    const resolution = await resolveNodeRuntime(
      undefined,
      probe({
        platform: "win32",
        env: { ProgramFiles: "C:\\Program Files" },
        versions: { "C:\\Program Files\\nodejs\\node.exe": "v22.13.0" }
      })
    );
    expect(resolution).toMatchObject({
      command: "C:\\Program Files\\nodejs\\node.exe",
      kind: "known-location"
    });
  });

  it("falls back to the editor's Electron runtime with ELECTRON_RUN_AS_NODE", async () => {
    const resolution = await resolveNodeRuntime(undefined, probe());
    expect(resolution.kind).toBe("electron");
    expect(resolution.command).toBe("/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
    expect(resolution.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(resolution.warnings.at(-1)).toContain("No Node.js 22+");
  });
});
