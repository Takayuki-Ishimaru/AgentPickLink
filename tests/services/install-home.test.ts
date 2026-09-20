import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  assertNotElevated,
  buildStamp,
  currentVersion,
  identityFor,
  installRuntime,
  integrationVariablesFor,
  listVersions,
  pruneVersions,
  readCurrentVersion,
  readInstallJson,
  resolveInstallHome,
  stageVersion,
  useVersion,
  writeInstallJson,
  writeLaunchers,
  type InstallJson
} from "../../src/services/install-home.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apl-install-home-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function fakeInstallJson(overrides: Partial<InstallJson> = {}): InstallJson {
  return {
    version: "0.2.0",
    installedBy: "archive",
    runtime: { path: "bin/node", source: "bundled", nodeVersion: "22.14.0" },
    identity: { command: "/home/bin/node", args: ["/home/bin/apl.js", "serve"] },
    clients: ["vscode"],
    workspaces: ["/workspace"],
    platform: "darwin",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides
  };
}

describe("resolveInstallHome", () => {
  it("prefers an explicit override over everything else", () => {
    // `override`/`M365_AGENT_INSTALL_ROOT` are resolved with the *host's* native `path.resolve`
    // (see resolveInstallHome's own doc comment: P1-11 resolves them against the real cwd, on
    // whatever machine is actually running), not `pathModuleFor(platform)` -- unlike every other
    // branch here, this one is deliberately impure with respect to the injected `platform`. So the
    // expectation has to go through the same host-native `path.resolve`, exactly like the P1-11
    // tests below already do, rather than a POSIX-literal string that only happens to match when
    // this suite runs on a POSIX host.
    expect(
      resolveInstallHome({
        env: { M365_AGENT_INSTALL_ROOT: "/env/root" },
        platform: "darwin",
        homedir: "/Users/tester",
        override: "/explicit/home"
      })
    ).toBe(path.resolve("/explicit/home"));
  });

  it("falls back to M365_AGENT_INSTALL_ROOT when there is no override", () => {
    expect(
      resolveInstallHome({
        env: { M365_AGENT_INSTALL_ROOT: "/env/root" },
        platform: "darwin",
        homedir: "/Users/tester"
      })
    ).toBe(path.resolve("/env/root"));
  });

  it("uses %LOCALAPPDATA%\\AgentPickLink on win32", () => {
    expect(
      resolveInstallHome({
        env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
        platform: "win32",
        homedir: "C:\\Users\\tester"
      })
    ).toBe("C:\\Users\\tester\\AppData\\Local\\AgentPickLink");
  });

  it("falls back to homedir\\AppData\\Local on win32 when LOCALAPPDATA is unset", () => {
    expect(resolveInstallHome({ env: {}, platform: "win32", homedir: "C:\\Users\\tester" })).toBe(
      "C:\\Users\\tester\\AppData\\Local\\AgentPickLink"
    );
  });

  it("uses ~/.local/share/AgentPickLink elsewhere", () => {
    expect(resolveInstallHome({ env: {}, platform: "darwin", homedir: "/Users/tester" })).toBe(
      "/Users/tester/.local/share/AgentPickLink"
    );
    expect(resolveInstallHome({ env: {}, platform: "linux", homedir: "/home/tester" })).toBe(
      "/home/tester/.local/share/AgentPickLink"
    );
  });

  it("§P1-11: resolves a relative --home override against the current working directory", () => {
    expect(
      resolveInstallHome({
        env: {},
        platform: "darwin",
        homedir: "/Users/tester",
        override: "relative/home"
      })
    ).toBe(path.resolve("relative/home"));
  });

  it("§P1-11: resolves a relative M365_AGENT_INSTALL_ROOT against the current working directory", () => {
    expect(
      resolveInstallHome({
        env: { M365_AGENT_INSTALL_ROOT: "relative/env-home" },
        platform: "darwin",
        homedir: "/Users/tester"
      })
    ).toBe(path.resolve("relative/env-home"));
  });
});

describe("install.json", () => {
  it("readInstallJson resolves undefined when absent", async () => {
    await withTempDir(async (home) => {
      expect(await readInstallJson(home)).toBeUndefined();
    });
  });

  it("round-trips through writeInstallJson", async () => {
    await withTempDir(async (home) => {
      const data = fakeInstallJson();
      await writeInstallJson(home, data);
      expect(await readInstallJson(home)).toEqual(data);
    });
  });

  it("throws on a corrupt install.json", async () => {
    await withTempDir(async (home) => {
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(path.join(home, "install.json"), "{ not json", "utf8");
      await expect(readInstallJson(home)).rejects.toThrow();
    });
  });

  it("throws when the shape does not match the schema", async () => {
    await withTempDir(async (home) => {
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(path.join(home, "install.json"), JSON.stringify({ version: "1.0.0" }), "utf8");
      await expect(readInstallJson(home)).rejects.toThrow();
    });
  });

  it("rejects writing a value that does not match the schema", async () => {
    await withTempDir(async (home) => {
      await expect(
        writeInstallJson(home, { ...fakeInstallJson(), installedBy: "not-a-real-value" as never })
      ).rejects.toThrow();
    });
  });
});

describe("stageVersion", () => {
  it("copies the source tree, preserving the executable bit, and replaces an existing version atomically", async () => {
    await withTempDir(async (home) => {
      const source = await fs.mkdtemp(path.join(os.tmpdir(), "apl-stage-source-"));
      try {
        await fs.mkdir(path.join(source, "dist", "cli"), { recursive: true });
        await fs.writeFile(path.join(source, "dist", "cli", "index.js"), "// v1", "utf8");
        const script = path.join(source, "run.sh");
        await fs.writeFile(script, "#!/bin/sh\necho hi\n", { mode: 0o755 });

        const target = await stageVersion({ sourceDir: source, home, version: "1.0.0" });
        expect(target).toBe(path.join(home, "app", "1.0.0"));
        expect(await fs.readFile(path.join(target, "dist", "cli", "index.js"), "utf8")).toBe("// v1");
        // The executable bit is a POSIX permission concept; NTFS has no equivalent (a copied
        // file's "mode" on win32 reflects only the read-only attribute), so this half of the
        // assertion only makes sense off win32.
        if (process.platform !== "win32") {
          const copiedMode = (await fs.stat(path.join(target, "run.sh"))).mode;
          expect(copiedMode & 0o111).not.toBe(0);
        }

        // Re-staging the same version replaces it atomically: no leftover `.old-*`/`.tmp-*` siblings.
        await fs.writeFile(path.join(source, "dist", "cli", "index.js"), "// v2", "utf8");
        await stageVersion({ sourceDir: source, home, version: "1.0.0" });
        expect(await fs.readFile(path.join(target, "dist", "cli", "index.js"), "utf8")).toBe("// v2");
        const appEntries = await fs.readdir(path.join(home, "app"));
        expect(appEntries).toEqual(["1.0.0"]);
      } finally {
        await fs.rm(source, { recursive: true, force: true });
      }
    });
  });

  // Creating the fixture symlink itself needs SeCreateSymbolicLinkPrivilege or Developer Mode on
  // win32 (unlike on POSIX, where any user can `symlink()`); a normal, non-elevated CI/verification
  // account cannot set this fixture up at all. The behaviour under test -- copyTree in
  // src/services/install-home.ts never calling `fs.symlink` (which itself needs that same
  // privilege to recreate a link) and instead copying the resolved target's bytes -- is exercised
  // by every other stageVersion test that stages plain files, so nothing here is left unverified.
  it.skipIf(process.platform === "win32")(
    "§P2: copies a symlink's target contents instead of recreating the link",
    async () => {
      await withTempDir(async (home) => {
        const source = await fs.mkdtemp(path.join(os.tmpdir(), "apl-stage-symlink-"));
        try {
          await fs.mkdir(path.join(source, "node_modules", ".bin"), { recursive: true });
          await fs.writeFile(path.join(source, "real-script.js"), "console.log('hi')\n", { mode: 0o755 });
          await fs.symlink(
            path.join(source, "real-script.js"),
            path.join(source, "node_modules", ".bin", "real-script")
          );

          const target = await stageVersion({ sourceDir: source, home, version: "1.0.0" });
          const linkPath = path.join(target, "node_modules", ".bin", "real-script");
          const linkStat = await fs.lstat(linkPath);
          expect(linkStat.isSymbolicLink()).toBe(false);
          expect(await fs.readFile(linkPath, "utf8")).toBe("console.log('hi')\n");
        } finally {
          await fs.rm(source, { recursive: true, force: true });
        }
      });
    }
  );

  // Same Developer-Mode/privilege constraint as the symlink test above -- the fixture itself
  // cannot be created unprivileged on win32.
  it.skipIf(process.platform === "win32")(
    "§P2: skips a broken (dangling) symlink instead of failing the whole staging pass",
    async () => {
      await withTempDir(async (home) => {
        const source = await fs.mkdtemp(path.join(os.tmpdir(), "apl-stage-dangling-"));
        try {
          await fs.writeFile(path.join(source, "index.js"), "// ok\n", "utf8");
          await fs.symlink(path.join(source, "does-not-exist"), path.join(source, "dangling"));

          const target = await stageVersion({ sourceDir: source, home, version: "1.0.0" });
          expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("// ok\n");
          await expect(fs.access(path.join(target, "dangling"))).rejects.toThrow();
        } finally {
          await fs.rm(source, { recursive: true, force: true });
        }
      });
    }
  );
});

describe("installRuntime", () => {
  it("copies the runtime to bin/node on POSIX with the executable bit set", async () => {
    await withTempDir(async (home) => {
      const nodeBinary = path.join(home, "fake-node-source");
      await fs.writeFile(nodeBinary, "binary-v1", { mode: 0o755 });
      const target = await installRuntime({ nodeBinary, home, platform: "darwin" });
      expect(target).toBe(path.join(home, "bin", "node"));
      expect(await fs.readFile(target, "utf8")).toBe("binary-v1");
      // The executable bit is a POSIX permission concept the underlying NTFS disk has no
      // equivalent for (only meaningful when this suite actually runs on a POSIX host, regardless
      // of the "darwin" platform injected above -- see the same note on stageVersion's test).
      if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o100).not.toBe(0);
    });
  });

  it("removes the quarantine attribute on darwin, and only from the copied binary", async () => {
    await withTempDir(async (home) => {
      const nodeBinary = path.join(home, "fake-node-source");
      await fs.writeFile(nodeBinary, "binary-v1", { mode: 0o755 });
      const calls: Array<{ command: string; args: string[] }> = [];
      const target = await installRuntime({
        nodeBinary,
        home,
        platform: "darwin",
        exec: async (command, args) => {
          calls.push({ command, args });
          return { stdout: "" };
        }
      });
      expect(calls).toEqual([{ command: "xattr", args: ["-d", "com.apple.quarantine", target] }]);
    });
  });

  it("never invokes exec on POSIX platforms other than darwin", async () => {
    await withTempDir(async (home) => {
      const nodeBinary = path.join(home, "fake-node-source");
      await fs.writeFile(nodeBinary, "binary-v1", { mode: 0o755 });
      let called = false;
      await installRuntime({
        nodeBinary,
        home,
        platform: "linux",
        exec: async () => {
          called = true;
          return { stdout: "" };
        }
      });
      expect(called).toBe(false);
    });
  });

  it("on win32, retains the previous binary as node.exe.old and deletes an older .old first", async () => {
    await withTempDir(async (home) => {
      await fs.mkdir(path.join(home, "bin"), { recursive: true });
      await fs.writeFile(path.join(home, "bin", "node.exe.old"), "stale-old", "utf8");
      await fs.writeFile(path.join(home, "bin", "node.exe"), "binary-v1", "utf8");

      const nodeBinaryV2 = path.join(home, "fake-node-v2");
      await fs.writeFile(nodeBinaryV2, "binary-v2", { mode: 0o755 });
      const target = await installRuntime({ nodeBinary: nodeBinaryV2, home, platform: "win32" });

      expect(target).toBe(path.join(home, "bin", "node.exe"));
      expect(await fs.readFile(target, "utf8")).toBe("binary-v2");
      expect(await fs.readFile(path.join(home, "bin", "node.exe.old"), "utf8")).toBe("binary-v1");
    });
  });

  it("on win32, works when there is no existing binary to retain", async () => {
    await withTempDir(async (home) => {
      const nodeBinary = path.join(home, "fake-node-v1");
      await fs.writeFile(nodeBinary, "binary-v1", { mode: 0o755 });
      const target = await installRuntime({ nodeBinary, home, platform: "win32" });
      expect(await fs.readFile(target, "utf8")).toBe("binary-v1");
      await expect(fs.access(path.join(home, "bin", "node.exe.old"))).rejects.toThrow();
    });
  });

  it("§P1-5: falls back to a uniquely named aside when node.exe.old cannot be replaced", async () => {
    await withTempDir(async (home) => {
      await fs.mkdir(path.join(home, "bin"), { recursive: true });
      await fs.writeFile(path.join(home, "bin", "node.exe"), "binary-v1", "utf8");
      // A non-empty directory standing where node.exe.old should go: both the best-effort delete
      // and the plain rename-aside fail (EISDIR/ENOTEMPTY), forcing the unique-name fallback.
      await fs.mkdir(path.join(home, "bin", "node.exe.old"), { recursive: true });
      await fs.writeFile(path.join(home, "bin", "node.exe.old", "locked.txt"), "x", "utf8");

      const nodeBinaryV2 = path.join(home, "fake-node-v2");
      await fs.writeFile(nodeBinaryV2, "binary-v2", { mode: 0o755 });
      const target = await installRuntime({ nodeBinary: nodeBinaryV2, home, platform: "win32" });

      expect(await fs.readFile(target, "utf8")).toBe("binary-v2");
      const binEntries = await fs.readdir(path.join(home, "bin"));
      const fallbackAside = binEntries.find((name) => /^node\.exe\.old-[0-9a-f]+$/.test(name));
      expect(fallbackAside).toBeTruthy();
      expect(await fs.readFile(path.join(home, "bin", fallbackAside!), "utf8")).toBe("binary-v1");
      // The stale directory that blocked the plain path is untouched, not deleted.
      expect((await fs.stat(path.join(home, "bin", "node.exe.old"))).isDirectory()).toBe(true);
    });
  });

  it("§P1-5: surfaces the underlying error when the final rename still fails", async () => {
    await withTempDir(async (home) => {
      const nodeBinary = path.join(home, "fake-node-source");
      await fs.writeFile(nodeBinary, "binary-v1", { mode: 0o755 });
      await expect(
        installRuntime({
          nodeBinary,
          home,
          platform: "win32",
          rename: async () => {
            throw new Error("EBUSY: resource busy or locked");
          }
        })
      ).rejects.toThrow(/Could not install the AgentPickLink runtime.*EBUSY/);
    });
  });
});

describe("writeLaunchers", () => {
  it("regenerates bin/apl.js pointing at the given version (POSIX)", async () => {
    await withTempDir(async (home) => {
      await writeLaunchers({ home, version: "1.2.3", platform: "darwin" });
      const content = await fs.readFile(path.join(home, "bin", "apl.js"), "utf8");
      expect(content).toContain('"1.2.3"');
      expect(content).toContain("mod.runCli(process.argv)");
      expect(content).not.toMatch(/^import /m);

      // The executable bit is a POSIX permission concept with no NTFS equivalent -- only
      // meaningful when this suite actually runs on a POSIX host.
      if (process.platform !== "win32") {
        const shimStat = await fs.stat(path.join(home, "bin", "apl"));
        expect(shimStat.mode & 0o100).not.toBe(0);
      }
      const shim = await fs.readFile(path.join(home, "bin", "apl"), "utf8");
      expect(shim).toContain('exec "$DIR/node" "$DIR/apl.js" "$@"');

      await expect(fs.access(path.join(home, "bin", "apl.cmd"))).rejects.toThrow();
    });
  });

  it("writes the CRLF Windows shim instead of the POSIX one", async () => {
    await withTempDir(async (home) => {
      await writeLaunchers({ home, version: "2.0.0", platform: "win32" });
      const cmd = await fs.readFile(path.join(home, "bin", "apl.cmd"), "utf8");
      expect(cmd).toBe('@echo off\r\n"%~dp0node.exe" "%~dp0apl.js" %*\r\n');
      await expect(fs.access(path.join(home, "bin", "apl"))).rejects.toThrow();
    });
  });

  it("regenerates apl.js on every call, replacing the referenced version", async () => {
    await withTempDir(async (home) => {
      await writeLaunchers({ home, version: "1.0.0", platform: "darwin" });
      await writeLaunchers({ home, version: "1.1.0", platform: "darwin" });
      const content = await fs.readFile(path.join(home, "bin", "apl.js"), "utf8");
      expect(content).toContain('"1.1.0"');
      expect(content).not.toContain('"1.0.0"');
    });
  });

  it("§4.7 C2 install --dev: devEntry is imported verbatim instead of app/<version>", async () => {
    await withTempDir(async (home) => {
      const devEntry = "/Users/dev/checkout/dist/cli/index.js";
      await writeLaunchers({ home, version: "9.9.9", platform: "darwin", devEntry });
      const content = await fs.readFile(path.join(home, "bin", "apl.js"), "utf8");
      expect(content).toContain(JSON.stringify(devEntry));
      expect(content).not.toContain("app");
      expect(content).not.toContain('"9.9.9"');
    });
  });

  it("§P1-7: also writes the bin/current-version sidecar, replaced on every call", async () => {
    await withTempDir(async (home) => {
      await writeLaunchers({ home, version: "1.0.0", platform: "darwin" });
      expect(await fs.readFile(path.join(home, "bin", "current-version"), "utf8")).toBe("1.0.0\n");
      await writeLaunchers({ home, version: "1.1.0", platform: "darwin" });
      expect(await fs.readFile(path.join(home, "bin", "current-version"), "utf8")).toBe("1.1.0\n");
    });
  });
});

describe("readCurrentVersion / currentVersion (§P1-7)", () => {
  it("readCurrentVersion resolves undefined when the sidecar does not exist", async () => {
    await withTempDir(async (home) => {
      expect(await readCurrentVersion(home)).toBeUndefined();
    });
  });

  it("readCurrentVersion reads and trims the sidecar written by writeLaunchers", async () => {
    await withTempDir(async (home) => {
      await writeLaunchers({ home, version: "3.2.1", platform: "darwin" });
      expect(await readCurrentVersion(home)).toBe("3.2.1");
    });
  });

  it("currentVersion prefers the sidecar over installJson.version when they disagree", async () => {
    await withTempDir(async (home) => {
      await writeLaunchers({ home, version: "2.0.0", platform: "darwin" });
      expect(await currentVersion(home, fakeInstallJson({ version: "1.0.0" }))).toBe("2.0.0");
    });
  });

  it("currentVersion falls back to installJson.version when the sidecar is absent", async () => {
    await withTempDir(async (home) => {
      expect(await currentVersion(home, fakeInstallJson({ version: "1.0.0" }))).toBe("1.0.0");
    });
  });

  it("currentVersion resolves undefined when neither is available", async () => {
    await withTempDir(async (home) => {
      expect(await currentVersion(home)).toBeUndefined();
    });
  });
});

describe("identityFor", () => {
  it("returns bin/node + apl.js serve on POSIX", () => {
    expect(identityFor({ home: "/opt/home", platform: "darwin" })).toEqual({
      command: "/opt/home/bin/node",
      args: ["/opt/home/bin/apl.js", "serve"]
    });
  });

  it("returns bin/node.exe + apl.js serve on win32", () => {
    expect(
      identityFor({ home: "C:\\Users\\tester\\AppData\\Local\\AgentPickLink", platform: "win32" })
    ).toEqual({
      command: "C:\\Users\\tester\\AppData\\Local\\AgentPickLink\\bin\\node.exe",
      args: ["C:\\Users\\tester\\AppData\\Local\\AgentPickLink\\bin\\apl.js", "serve"]
    });
  });
});

describe("listVersions / useVersion / pruneVersions", () => {
  it("lists nothing when app/ does not exist", async () => {
    await withTempDir(async (home) => {
      expect(await listVersions(home)).toEqual([]);
    });
  });

  it("lists installed versions newest first, ignoring staging directories and files", async () => {
    await withTempDir(async (home) => {
      for (const version of ["1.0.0", "2.0.0", "1.5.3"])
        await fs.mkdir(path.join(home, "app", version), { recursive: true });
      await fs.mkdir(path.join(home, "app", "1.9.0.tmp-abcdef"), { recursive: true });
      await fs.writeFile(path.join(home, "app", "readme.txt"), "not a version", "utf8");
      expect(await listVersions(home)).toEqual(["2.0.0", "1.5.3", "1.0.0"]);
    });
  });

  it("useVersion refuses to point at a version that is not staged", async () => {
    await withTempDir(async (home) => {
      await expect(useVersion({ home, version: "9.9.9", platform: "darwin" })).rejects.toThrow(DomainError);
      await expect(useVersion({ home, version: "9.9.9", platform: "darwin" })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT"
      });
    });
  });

  it("§P2: useVersion rejects a version outside the safe character set", async () => {
    await withTempDir(async (home) => {
      await expect(useVersion({ home, version: "../../etc", platform: "darwin" })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT"
      });
      await expect(useVersion({ home, version: "1.0.0 ; rm -rf", platform: "darwin" })).rejects.toMatchObject(
        { code: "INVALID_ARGUMENT" }
      );
    });
  });

  it("useVersion re-points bin/apl.js at an already-staged version", async () => {
    await withTempDir(async (home) => {
      await fs.mkdir(path.join(home, "app", "3.0.0", "dist", "cli"), { recursive: true });
      await fs.writeFile(
        path.join(home, "app", "3.0.0", "package.json"),
        JSON.stringify({ name: "agent-pick-link", version: "3.0.0", type: "module" })
      );
      await fs.writeFile(
        path.join(home, "app", "3.0.0", "dist", "cli", "index.js"),
        "export function runCli() {}\n"
      );
      await useVersion({ home, version: "3.0.0", platform: "darwin" });
      const content = await fs.readFile(path.join(home, "bin", "apl.js"), "utf8");
      expect(content).toContain('"3.0.0"');
    });
  });

  it("pruneVersions deletes every version other than the one kept", async () => {
    await withTempDir(async (home) => {
      for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
        await fs.mkdir(path.join(home, "app", version, "dist", "cli"), { recursive: true });
        await fs.writeFile(
          path.join(home, "app", version, "package.json"),
          JSON.stringify({ name: "agent-pick-link", version, type: "module" })
        );
        await fs.writeFile(
          path.join(home, "app", version, "dist", "cli", "index.js"),
          "export function runCli() {}"
        );
      }
      await writeLaunchers({ home, version: "2.0.0", platform: process.platform });
      const identity = identityFor({ home, platform: process.platform });
      await writeInstallJson(home, {
        version: "2.0.0",
        installedBy: "archive",
        runtime: { path: identity.command, source: "bundled" },
        identity,
        clients: [],
        workspaces: [],
        platform: process.platform,
        updatedAt: new Date().toISOString()
      });
      const removed = await pruneVersions({ home, keep: "2.0.0" });
      expect(removed.sort()).toEqual(["1.0.0", "3.0.0"]);
      expect(await listVersions(home)).toEqual(["2.0.0"]);
    });
  });
});

describe("assertNotElevated", () => {
  it("throws on win32 when whoami /groups reports the High Mandatory Level SID", async () => {
    await expect(
      assertNotElevated({
        platform: "win32",
        exec: async () => ({ stdout: "Mandatory Label\\High Mandatory Level  Label  S-1-16-12288\n" })
      })
    ).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  });

  it("resolves on win32 for a normal (non-elevated) token", async () => {
    await expect(
      assertNotElevated({
        platform: "win32",
        exec: async () => ({ stdout: "Mandatory Label\\Medium Mandatory Level  Label  S-1-16-8192\n" })
      })
    ).resolves.toBeUndefined();
  });

  it("fails open on win32 when the probe itself cannot run", async () => {
    await expect(
      assertNotElevated({
        platform: "win32",
        exec: async () => {
          throw new Error("ENOENT: whoami");
        }
      })
    ).resolves.toBeUndefined();
  });

  it("throws on POSIX when running as uid 0", async () => {
    await expect(assertNotElevated({ platform: "darwin", getuid: () => 0 })).rejects.toMatchObject({
      code: "POLICY_BLOCKED"
    });
  });

  it("resolves on POSIX for a non-root uid", async () => {
    await expect(assertNotElevated({ platform: "darwin", getuid: () => 501 })).resolves.toBeUndefined();
  });
});

describe("integrationVariablesFor", () => {
  it("reports both localAppData and userHome on win32", () => {
    expect(
      integrationVariablesFor({
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        platform: "win32",
        homedir: "C:\\Users\\me"
      })
    ).toEqual({ localAppData: "C:\\Users\\me\\AppData\\Local", userHome: "C:\\Users\\me" });
  });

  it("derives localAppData from the home directory on win32 when LOCALAPPDATA is unset", () => {
    expect(integrationVariablesFor({ env: {}, platform: "win32", homedir: "C:\\Users\\me" })).toEqual({
      localAppData: "C:\\Users\\me\\AppData\\Local",
      userHome: "C:\\Users\\me"
    });
  });

  it("reports only userHome on macOS/Linux", () => {
    expect(integrationVariablesFor({ env: {}, platform: "darwin", homedir: "/Users/me" })).toEqual({
      userHome: "/Users/me"
    });
  });
});

describe("buildStamp", () => {
  it("returns the bare version with no build", () => {
    expect(buildStamp("1.2.3")).toBe("1.2.3");
  });

  it("appends +build when given", () => {
    expect(buildStamp("1.2.3", "abc123")).toBe("1.2.3+abc123");
  });
});
