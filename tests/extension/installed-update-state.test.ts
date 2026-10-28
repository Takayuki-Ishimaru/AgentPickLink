import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readInstalledExtensionVersion } from "../../src/extension/installed-extension.js";
import { installExtensionRelease } from "../../src/extension/extension-update.js";
// These tests exercise installation/receipt behavior; cryptographic trust is covered by the
// attestation service's real signed-bundle tests.
vi.mock("../../src/services/extension-attestation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/extension-attestation.js")>();
  return {
    ...actual,
    verifyExtensionAttestation: vi.fn(async (release: { tag: string; sha256: string }) => ({
      version: 1 as const,
      tag: release.tag,
      sha256: release.sha256,
      sourceCommit: "c".repeat(40),
      workflow: actual.ATTESTATION_WORKFLOW,
      verifiedAt: new Date().toISOString()
    }))
  };
});
import { createRuntimeHarness, type RuntimeHarness } from "./harness.js";
import { resetVscodeMock, vscodeMock, Uri } from "./vscode-mock.js";

let h: RuntimeHarness;
const release = (version: string) => ({
  tag: `v${version}`,
  name: `agent-pick-link-${version}.vsix`,
  url: `https://github.com/Takayuki-Ishimaru/AgentPickLink/releases/download/v${version}/agent-pick-link-${version}.vsix`,
  sha256: "a".repeat(64),
  size: 4
});
const inventory = () => path.join(path.dirname(h.extensionRoot), "extensions.json");
async function installed(version: string) {
  const folder = `agentpicklink.agent-pick-link-${version}`;
  const root = path.join(path.dirname(h.extensionRoot), folder);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ publisher: "agentpicklink", name: "agent-pick-link", version })
  );
  await writeFile(
    inventory(),
    JSON.stringify([
      { identifier: { id: "agentpicklink.agent-pick-link" }, version, relativeLocation: folder }
    ])
  );
}
beforeEach(async () => {
  resetVscodeMock();
  h = await createRuntimeHarness();
  await installed("0.2.13");
  vscodeMock.commands.set("workbench.extensions.installExtension", async (uri: unknown) => {
    const version = path
      .basename((uri as { fsPath: string }).fsPath)
      .replace(/^agent-pick-link-/, "")
      .replace(/\.vsix$/, "");
    await installed(version);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});
const run = (version: string, download = vi.fn(async () => Buffer.from("vsix"))) =>
  installExtensionRelease(
    h.context as never,
    release(version),
    new AbortController().signal,
    () => true,
    download
  );

describe("v0.2.13 receipt and actual installed state", () => {
  it("repairs an external downgrade despite an exact old success receipt", async () => {
    const download = vi.fn(async () => Buffer.from("vsix"));
    expect(await run("0.2.14", download)).toBe(true);
    await installed("0.2.13");
    expect(await run("0.2.14", download)).toBe(true);
    expect(download).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(inventory(), "utf8"))[0].version).toBe("0.2.14");
  });

  it("protects an externally installed newer version from an old window's update", async () => {
    const download = vi.fn(async () => Buffer.from("vsix"));
    expect(await run("0.2.14", download)).toBe(true);
    await installed("0.2.16");
    expect(await run("0.2.15", download)).toBe(false);
    expect(download).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(inventory(), "utf8"))[0].version).toBe("0.2.16");
  });

  it("deduplicates reload-pending windows using disk state despite the old runtime version", async () => {
    const download = vi.fn(async () => Buffer.from("vsix"));
    expect(h.runtime.version).toBe("0.1.0");
    expect(await run("0.2.14", download)).toBe(true);
    expect(await run("0.2.14", download)).toBe(true);
    expect(download).toHaveBeenCalledOnce();
  });

  it("checks installed state again after a download before issuing native install", async () => {
    const download = vi.fn(async () => {
      await installed("0.2.16");
      return Buffer.from("vsix");
    });
    expect(await run("0.2.14", download)).toBe(false);
    expect(vscodeMock.executedCommands).toHaveLength(0);
  });

  it.each([
    "missing",
    "malformed",
    "absent",
    "duplicate",
    "manifest-missing",
    "manifest-mismatch",
    "traversal"
  ])("does not trust unavailable or inconsistent installation data: %s", async (mode) => {
    expect(await run("0.2.14")).toBe(true);
    vscodeMock.executedCommands.length = 0;
    if (mode === "missing") await rm(inventory());
    if (mode === "malformed") await writeFile(inventory(), "{");
    if (mode === "absent") await writeFile(inventory(), "[]");
    if (mode === "duplicate") {
      const entries = JSON.parse(await readFile(inventory(), "utf8"));
      await writeFile(inventory(), JSON.stringify([...entries, ...entries]));
    }
    if (mode === "manifest-missing")
      await rm(path.join(path.dirname(h.extensionRoot), "agentpicklink.agent-pick-link-0.2.14/package.json"));
    if (mode === "manifest-mismatch")
      await writeFile(
        path.join(path.dirname(h.extensionRoot), "agentpicklink.agent-pick-link-0.2.14/package.json"),
        JSON.stringify({ publisher: "agentpicklink", name: "agent-pick-link", version: "0.2.13" })
      );
    if (mode === "traversal")
      await writeFile(
        inventory(),
        JSON.stringify([
          {
            identifier: { id: "agentpicklink.agent-pick-link" },
            version: "0.2.14",
            relativeLocation: "../unrelated"
          }
        ])
      );
    const download = vi.fn(async () => Buffer.from("vsix"));
    expect(await run("0.2.14", download)).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(vscodeMock.executedCommands).toHaveLength(0);
  });
});

describe("native VS Code installation inventory", () => {
  it("prefers current User inventory over a stale legacy inventory", async () => {
    await installed("0.2.16");
    const primary = path.join(path.dirname(h.extensionRoot), "User/extensions.json");
    await mkdir(path.dirname(primary), { recursive: true });
    await writeFile(primary, await readFile(inventory(), "utf8"));
    await installed("0.2.13");
    const context = {
      ...h.context,
      globalStorageUri: Uri.file(
        path.join(path.dirname(primary), "globalStorage/agentpicklink.agent-pick-link")
      )
    };
    expect(await readInstalledExtensionVersion(context as never)).toBe("0.2.16");
    await writeFile(primary, "{");
    expect(await readInstalledExtensionVersion(context as never)).toBeUndefined();
    await writeFile(primary, "[]");
    expect(await readInstalledExtensionVersion(context as never)).toBeUndefined();
    await rm(primary);
    expect(await readInstalledExtensionVersion(context as never)).toBe("0.2.13");
  });

  it("accepts a case-insensitive ID but refuses invalid version data", async () => {
    const entries = JSON.parse(await readFile(inventory(), "utf8"));
    entries[0].identifier.id = "AgentPickLink.Agent-Pick-Link";
    await writeFile(inventory(), JSON.stringify(entries));
    expect(await readInstalledExtensionVersion(h.context as never)).toBe("0.2.13");
    entries[0].version = "latest";
    await writeFile(inventory(), JSON.stringify(entries));
    expect(await readInstalledExtensionVersion(h.context as never)).toBeUndefined();
  });
});

describe("native installation locations", () => {
  it("accepts legacy file URI components and rejects a non-file location", async () => {
    const entries = JSON.parse(await readFile(inventory(), "utf8"));
    const directory = path.join(path.dirname(h.extensionRoot), entries[0].relativeLocation);
    delete entries[0].relativeLocation;
    entries[0].location = { scheme: "file", path: directory };
    await writeFile(inventory(), JSON.stringify(entries));
    expect(await readInstalledExtensionVersion(h.context as never)).toBe("0.2.13");
    entries[0].location.scheme = "https";
    await writeFile(inventory(), JSON.stringify(entries));
    expect(await readInstalledExtensionVersion(h.context as never)).toBeUndefined();
  });
});

describe("installed state asynchronous boundaries", () => {
  it.each(["abort", "preference"])("checks %s after the last asynchronous inventory read", async (mode) => {
    const controller = new AbortController();
    let active = true;
    let reads = 0;
    const reader = async () => {
      if (++reads === 2) {
        if (mode === "abort") controller.abort();
        else active = false;
      }
      return "0.2.13";
    };
    expect(
      await installExtensionRelease(
        h.context as never,
        release("0.2.14"),
        controller.signal,
        () => active,
        async () => Buffer.from("vsix"),
        reader
      )
    ).toBe(false);
    expect(vscodeMock.executedCommands).toHaveLength(0);
  });

  it("does not fallback to legacy data if the primary inventory's package is missing", async () => {
    await installed("0.2.16");
    const primary = path.join(path.dirname(h.extensionRoot), "User/extensions.json");
    await mkdir(path.dirname(primary), { recursive: true });
    await writeFile(primary, await readFile(inventory(), "utf8"));
    await rm(path.join(path.dirname(h.extensionRoot), "agentpicklink.agent-pick-link-0.2.16/package.json"));
    await installed("0.2.13");
    const context = {
      ...h.context,
      globalStorageUri: Uri.file(
        path.join(path.dirname(primary), "globalStorage/agentpicklink.agent-pick-link")
      )
    };
    expect(await readInstalledExtensionVersion(context as never)).toBeUndefined();
  });

  it("rejects absolute relativeLocation values even when they name a child folder", async () => {
    const entries = JSON.parse(await readFile(inventory(), "utf8"));
    entries[0].relativeLocation = path.join(path.dirname(h.extensionRoot), entries[0].relativeLocation);
    await writeFile(inventory(), JSON.stringify(entries));
    expect(await readInstalledExtensionVersion(h.context as never)).toBeUndefined();
  });
});

describe("native installation already in progress", () => {
  it.each(["abort", "preference"])(
    "records a completed native installation after %s without abandoning its receipt",
    async (mode) => {
      const controller = new AbortController();
      let active = true;
      vscodeMock.commands.set("workbench.extensions.installExtension", async () => {
        await installed("0.2.14");
        if (mode === "abort") controller.abort();
        else active = false;
      });
      expect(
        await installExtensionRelease(
          h.context as never,
          release("0.2.14"),
          controller.signal,
          () => active,
          async () => Buffer.from("vsix")
        )
      ).toBe(true);
      const receipt = JSON.parse(
        await readFile(path.join(h.context.globalStorageUri.fsPath, "installed-release.json"), "utf8")
      );
      expect(receipt).toMatchObject({ tag: "v0.2.14", sha256: "a".repeat(64) });
    }
  );
});
