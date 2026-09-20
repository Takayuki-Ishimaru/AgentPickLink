import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import {
  identityFor,
  pruneVersions,
  readInstallJson,
  useVersion,
  validateInstallation,
  writeInstallJson,
  writeLaunchers
} from "../../src/services/install-home.js";
import { runSelfPrune, runSelfUninstall } from "../../src/cli/commands/self.js";
import { stopOwnedInstallBroker, validatePurgeData } from "../../src/services/uninstall-safety.js";
import { makeCommandDeps, makeTempPaths } from "../cli/helpers.js";
import type { IpcClient } from "../../src/ipc/client.js";
import type { BrokerDescriptor } from "../../src/ipc/protocol.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "apl-review-"));
  roots.push(root);
  const home = path.join(root, "install");
  const version = "0.2.0";
  await fs.mkdir(path.join(home, "app", version, "dist", "cli"), { recursive: true });
  await fs.mkdir(path.join(home, "app", version, "dist", "broker"), { recursive: true });
  await fs.writeFile(
    path.join(home, "app", version, "package.json"),
    JSON.stringify({ name: "agent-pick-link", version, type: "module" })
  );
  await fs.writeFile(
    path.join(home, "app", version, "dist", "cli", "index.js"),
    'export function runCli() { process.stdout.write("launched"); }'
  );
  await fs.writeFile(path.join(home, "app", version, "dist", "broker", "process.js"), "// broker");
  await writeLaunchers({ home, version, platform: process.platform });
  const identity = identityFor({ home, platform: process.platform });
  await writeInstallJson(home, {
    version,
    installedBy: "archive",
    runtime: { path: identity.command, source: "bundled" },
    identity,
    clients: [],
    workspaces: [],
    platform: process.platform,
    updatedAt: new Date().toISOString()
  });
  const { deps } = makeCommandDeps({ paths: await makeTempPaths() });
  roots.push(path.dirname(deps.paths.root));
  return { root, home, version, deps };
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else
        result[path.relative(root, file)] = entry.isSymbolicLink()
          ? await fs.readlink(file)
          : (await fs.readFile(file)).toString("base64");
    }
  }
  await walk(root);
  return result;
}

it.each([
  "unknown-directory",
  "missing-current",
  "launcher-mismatch",
  "record-mismatch",
  "corrupt-manifest",
  "missing-manifest",
  "foreign-manifest",
  "corrupt-old-package",
  "foreign-old-package",
  "linked-old-package",
  "linked-app",
  "linked-current"
])("prune rejects %s without changing any files, even with --yes", async (mode) => {
  const { home, root, deps, version } = await fixture();
  const old = path.join(home, "app", "0.1.0");
  await fs.cp(path.join(home, "app", version), old, { recursive: true });
  await fs.writeFile(
    path.join(old, "package.json"),
    JSON.stringify({ name: "agent-pick-link", version: "0.1.0", type: "module" })
  );
  if (mode === "unknown-directory") {
    await fs.mkdir(path.join(home, "app", "customer-backup"));
    await fs.writeFile(path.join(home, "app", "customer-backup", "sentinel.txt"), "keep");
  }
  if (mode === "missing-current") await fs.writeFile(path.join(home, "bin", "current-version"), "9.9.9\n");
  if (mode === "launcher-mismatch") await fs.writeFile(path.join(home, "bin", "current-version"), "0.1.0\n");
  if (mode === "record-mismatch")
    await writeInstallJson(home, { ...(await readInstallJson(home))!, version: "0.1.0" });
  if (mode === "corrupt-manifest") await fs.writeFile(path.join(home, "install.json"), "{broken");
  if (mode === "missing-manifest") await fs.unlink(path.join(home, "install.json"));
  if (mode === "foreign-manifest")
    await writeInstallJson(home, {
      ...(await readInstallJson(home))!,
      identity: identityFor({ home: path.join(root, "other"), platform: deps.platform })
    });
  if (mode === "corrupt-old-package") await fs.writeFile(path.join(old, "package.json"), "{broken");
  if (mode === "foreign-old-package")
    await fs.writeFile(
      path.join(old, "package.json"),
      JSON.stringify({ name: "other", version: "0.1.0", type: "module" })
    );
  if (mode === "linked-old-package" || mode === "linked-app") {
    const target = mode === "linked-app" ? path.join(home, "app") : old;
    const external = path.join(root, "external");
    await fs.rename(target, external);
    await fs.symlink(external, target, process.platform === "win32" ? "junction" : "dir");
  }
  if (mode === "linked-current") {
    const target = path.join(home, "bin", "current-version");
    await fs.rename(target, path.join(root, "current-version"));
    await fs.symlink(path.join(root, "current-version"), target);
  }
  const before = await snapshot(root);
  await expect(runSelfPrune(deps, { home, yes: true })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(await snapshot(root)).toEqual(before);
  // The service entry point must enforce the same checks as the CLI.
  await expect(pruneVersions({ home, keep: version })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(await snapshot(root)).toEqual(before);
});

it("prune revalidates the deletion plan after confirmation", async () => {
  const { home, deps, version } = await fixture();
  const old = path.join(home, "app", "0.1.0");
  await fs.cp(path.join(home, "app", version), old, { recursive: true });
  await fs.writeFile(
    path.join(old, "package.json"),
    JSON.stringify({ name: "agent-pick-link", version: "0.1.0", type: "module" })
  );
  let before: Record<string, string>;
  deps.prompter = {
    interactive: true,
    question: async () => "",
    confirm: async () => {
      await fs.mkdir(path.join(home, "app", "customer-backup"));
      await fs.writeFile(path.join(home, "app", "customer-backup", "sentinel.txt"), "keep");
      before = await snapshot(home);
      return true;
    }
  };
  await expect(runSelfPrune(deps, { home })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(await snapshot(home)).toEqual(before!);
});

it("prune supports an older installation without a current-version sidecar", async () => {
  const { home, deps, version } = await fixture();
  await fs.unlink(path.join(home, "bin", "current-version"));
  await expect(runSelfPrune(deps, { home, yes: true })).resolves.toMatchObject({
    removed: [],
    kept: version
  });
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(home, "bin", "apl.js")]);
  expect(stdout).toBe("launched");
});

it.each(["missing", "corrupt", "copied", "foreign-bin", "wrong-package", "linked-app"])(
  "refuses %s ownership evidence without changing any existing bytes",
  async (mode) => {
    const { home, root, deps, version } = await fixture();
    if (mode === "missing") await fs.unlink(path.join(home, "install.json"));
    if (mode === "corrupt") await fs.writeFile(path.join(home, "install.json"), "{broken");
    if (mode === "copied") {
      const manifest = (await readInstallJson(home))!;
      await writeInstallJson(home, {
        ...manifest,
        identity: identityFor({ home: path.join(root, "other"), platform: process.platform })
      });
    }
    if (mode === "foreign-bin") await fs.writeFile(path.join(home, "bin", "sentinel.txt"), "unrelated");
    if (mode === "wrong-package")
      await fs.writeFile(path.join(home, "app", version, "package.json"), '{"name":"foreign"}');
    if (mode === "linked-app") {
      await fs.rename(path.join(home, "app"), path.join(root, "external"));
      await fs.symlink(
        path.join(root, "external"),
        path.join(home, "app"),
        process.platform === "win32" ? "junction" : "dir"
      );
    }
    const before = await snapshot(root);
    await expect(runSelfUninstall(deps, { home, yes: true })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT"
    });
    expect(await snapshot(root)).toEqual(before);
  }
);

it.each([".", "..", "1.0.0.", "CON", "missing", "incomplete", "linked"])(
  "rejects version %s before changing the current launcher or manifest",
  async (version) => {
    const { home, root } = await fixture();
    if (version === "incomplete") await fs.mkdir(path.join(home, "app", version));
    if (version === "linked")
      await fs.symlink(
        path.join(home, "app", "0.2.0"),
        path.join(home, "app", version),
        process.platform === "win32" ? "junction" : "dir"
      );
    const before = await snapshot(root);
    await expect(useVersion({ home, version, platform: process.platform })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT"
    });
    expect(await snapshot(root)).toEqual(before);
  }
);

it.each(["module", "commonjs", undefined])(
  "launches below an ancestor package with type %s and preserves apl.js references",
  async (type) => {
    const { home, root } = await fixture();
    if (type) await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type }));
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(home, "bin", "apl.js")]);
    expect(stdout).toBe("launched");
  }
);

it("recognizes source and Electron installations without deleting their external runtime or source", async () => {
  const { home, root, version } = await fixture();
  const manifest = (await readInstallJson(home))!;
  const source = path.join(root, "checkout", "dist", "cli", "index.js");
  await writeLaunchers({ home, version, platform: process.platform, devEntry: source });
  await writeInstallJson(home, {
    ...manifest,
    installedBy: "source",
    runtime: { path: process.execPath, source: "node" }
  });
  await fs.rm(path.join(home, "app"), { recursive: true });
  const launcher = path.join(home, "bin", "apl.js");
  await fs.writeFile(
    launcher,
    (await fs.readFile(launcher, "utf8")).replace(
      "// bin/package.json establishes CommonJS even below an ESM project; a dynamic",
      "// This file is always CommonJS (no ancestor package.json under <home>), so a dynamic"
    )
  );
  await expect(validateInstallation(home, process.platform)).resolves.toMatchObject({
    installedBy: "source"
  });
  // Electron uses the staged CLI entry directly, rather than bin/apl.js, in its MCP identity.
  const another = await fixture();
  const electron = (await readInstallJson(another.home))!;
  await writeInstallJson(another.home, {
    ...electron,
    runtime: { path: process.execPath, source: "electron" },
    identity: {
      command: process.execPath,
      args: [path.join(another.home, "app", version, "dist", "cli", "index.js"), "serve"]
    }
  });
  await expect(validateInstallation(another.home, process.platform)).resolves.toMatchObject({
    runtime: { source: "electron" }
  });
});

it.each(["foreign", "replacement", "timeout", "success"])(
  "handles a %s broker with real process liveness checks",
  async (mode) => {
    const { home, deps } = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    let descriptor: BrokerDescriptor | undefined = {
      pid: child.pid!,
      pipeName: "unused",
      protocolMajor: 1,
      protocolMinor: 3,
      packageVersion: "0.2.0",
      instanceId: "owned",
      authSecret: "unused",
      createdAt: new Date().toISOString(),
      build: {
        entry: path.join(
          home,
          mode === "foreign" ? "app-other" : "app",
          "0.2.0",
          "dist",
          "broker",
          "process.js"
        ),
        mtimeMs: 0
      }
    };
    const call = vi.fn(async () => {
      if (mode === "success") {
        child.kill();
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      descriptor = undefined; // disappearance alone is insufficient for the timeout case
    });
    deps.readDescriptor = async () => descriptor;
    deps.connectExistingBroker = async () =>
      ({
        connect: async () => ({ instanceId: mode === "replacement" ? "other" : "owned" }),
        call,
        close: () => undefined
      }) as unknown as IpcClient;
    try {
      if (mode === "success" || mode === "foreign") await stopOwnedInstallBroker(deps, home, false, 50);
      else
        await expect(stopOwnedInstallBroker(deps, home, false, 50)).rejects.toMatchObject({
          code: "POLICY_BLOCKED"
        });
      if (mode === "replacement" || mode === "foreign") expect(call).not.toHaveBeenCalled();
      if (mode === "foreign")
        await expect(stopOwnedInstallBroker(deps, home, true, 50)).rejects.toMatchObject({
          code: "POLICY_BLOCKED"
        });
      if (mode === "success") expect(() => process.kill(child.pid!, 0)).toThrow();
      else expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
    }
  }
);

it("purges normally initialized local state but rejects unrelated content", async () => {
  const { home, deps } = await fixture();
  const { initializeLocalState } = await import("../../src/config/init.js");
  const { ProfileManager } = await import("../../src/transports/browser/profile-manager.js");
  await initializeLocalState(deps.paths, {
    prepareLocalState: async (profile) => {
      await new ProfileManager(profile).prepare();
    }
  });
  await expect(validatePurgeData(deps, home)).resolves.toBeUndefined();
  await fs.writeFile(path.join(deps.paths.root, "sentinel.txt"), "keep");
  await expect(runSelfUninstall(deps, { home, yes: true, purgeData: true })).rejects.toMatchObject({
    code: "POLICY_BLOCKED"
  });
  expect(await fs.readFile(path.join(deps.paths.root, "sentinel.txt"), "utf8")).toBe("keep");
  await fs.unlink(path.join(deps.paths.root, "sentinel.txt"));
  await expect(runSelfUninstall(deps, { home, yes: true, purgeData: true })).resolves.toMatchObject({
    uninstalled: true,
    purged: true
  });
  expect(await fs.readdir(deps.paths.root)).toEqual(["broker"]);
  expect(await fs.readdir(deps.paths.broker)).toEqual(["startup.lock"]);
});
it("refuses a dead broker's still-live browser before removing its descriptor", async () => {
  const { home, deps } = await fixture();
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const descriptor = {
    pid: child.pid!,
    browserPid: process.pid,
    instanceId: "dead",
    build: { entry: path.join(home, "app", "0.2.0", "dist", "broker", "process.js") }
  } as BrokerDescriptor;
  deps.readDescriptor = async () => descriptor;
  await expect(stopOwnedInstallBroker(deps, home, true)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
});

it("rechecks files created while the user is confirming, before removing any installation files", async () => {
  const { home, deps } = await fixture();
  const { initializeLocalState } = await import("../../src/config/init.js");
  await initializeLocalState(deps.paths, { prepareLocalState: async () => undefined });
  deps.prompter = {
    interactive: true,
    question: async () => "",
    confirm: async () => {
      await fs.writeFile(path.join(deps.paths.root, "unrelated.txt"), "keep");
      return true;
    }
  };
  const before = await snapshot(home);
  await expect(runSelfUninstall(deps, { home, purgeData: true })).rejects.toMatchObject({
    code: "POLICY_BLOCKED"
  });
  expect(await snapshot(home)).toEqual(before);
  expect(await fs.readFile(path.join(deps.paths.root, "unrelated.txt"), "utf8")).toBe("keep");
});

it("keeps another installation's managed VS Code configuration byte-identical", async () => {
  const { home, root, deps } = await fixture();
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, ".vscode"), { recursive: true });
  const manifest = (await readInstallJson(home))!;
  await writeInstallJson(home, { ...manifest, workspaces: [workspace] });
  const { mergeVscodeMcpJson } = await import("../../src/services/integrations.js");
  const text = mergeVscodeMcpJson("// preserve\n{}", {
    ...identityFor({ home: path.join(root, "other-install"), platform: process.platform }),
    env: { M365_AGENT_MANAGED: "1" }
  });
  const file = path.join(workspace, ".vscode", "mcp.json");
  await fs.writeFile(file, text);
  const result = await runSelfUninstall(deps, { home, yes: true });
  expect(result.uninstalled).toBe(true);
  expect(await fs.readFile(file, "utf8")).toBe(text);
  expect(result.skippedIntegrations).toEqual(
    expect.arrayContaining([expect.stringContaining("another installation")])
  );
});

it("does not treat a generic config.yaml and logs folder as owned application data", async () => {
  const { home, deps } = await fixture();
  await fs.mkdir(deps.paths.logs, { recursive: true });
  await fs.writeFile(deps.paths.config, "{}");
  await fs.writeFile(path.join(deps.paths.logs, "sentinel.txt"), "unrelated logs");
  const before = await snapshot(deps.paths.root);
  await expect(runSelfUninstall(deps, { home, yes: true, purgeData: true })).rejects.toMatchObject({
    code: "POLICY_BLOCKED"
  });
  expect(await snapshot(deps.paths.root)).toEqual(before);
});
