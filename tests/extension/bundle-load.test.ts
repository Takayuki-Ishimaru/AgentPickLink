// Regression guard for the packaged extension bundle load check (scripts/check-extension-bundle.mjs).
// The released extension.cjs once failed at load with MODULE_NOT_FOUND './impl/format' because the
// bundler left shadowed require() calls unbundled; these tiny fake bundles exercise exactly that
// class of failure. The check copies ONLY the entry into a fresh temporary directory, so nothing
// beside the original entry can satisfy an unresolved runtime import.
//
// The check is a plain Node script, so it is imported directly; the vitest `vscode` alias only
// matches the exact specifier "vscode" and never reaches the child process.
import { strict as assert } from "node:assert";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
// @ts-expect-error JavaScript helper without type declarations
import { assertExtensionBundleLoads } from "../../scripts/check-extension-bundle.mjs";

const HELPER_PREFIX = "apl-bundle-load-";
const GOOD_BUNDLE = `"use strict";
const vscode = require("vscode");
module.exports = {
  activate: () => { throw new Error("activate must not be called by the load check"); },
  deactivate: () => { throw new Error("deactivate must not be called by the load check"); }
};
`;

function listHelperDirs(): string[] {
  return readdirSync(os.tmpdir()).filter((name) => name.startsWith(HELPER_PREFIX));
}

async function withFixture<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function expectLoadFailure(entry: string, ...matches: string[]): Promise<void> {
  let failure: Error | undefined;
  try {
    await assertExtensionBundleLoads(entry);
  } catch (error) {
    failure = error as Error;
  }
  assert.ok(failure, "expected the load check to reject");
  const message = String(failure.message);
  assert.match(message, /Packaged extension bundle failed to load/);
  for (const match of matches) {
    assert.ok(message.includes(match), `expected "${match}" in:\n${message}`);
  }
}

test("a bundle with correct exports loads without being activated, and cleans up its temp dir", async () => {
  const before = listHelperDirs();
  await withFixture("apl-bundle-good-", async (dir) => {
    const entry = path.join(dir, "extension.cjs");
    await writeFile(entry, GOOD_BUNDLE);
    await assert.doesNotReject(assertExtensionBundleLoads(entry));
  });
  assert.deepEqual(
    listHelperDirs().filter((name) => !before.includes(name)),
    []
  );
});

test("require('vscode') is stubbed with an object in the child, not resolved", async () => {
  await withFixture("apl-bundle-vscode-", async (dir) => {
    const entry = path.join(dir, "extension.cjs");
    await writeFile(
      entry,
      `"use strict";
const vscode = require("vscode");
if (typeof vscode !== "object" || vscode === null) throw new Error("vscode stub is not an object");
if (typeof require("vscode").someCommand !== "undefined") throw new Error("vscode stub is not empty");
module.exports = { activate: () => {}, deactivate: () => {} };
`
    );
    await assert.doesNotReject(assertExtensionBundleLoads(entry));
  });
});

test("missing ./impl/format fails even when the sibling module exists next to the original entry", async () => {
  await withFixture("apl-bundle-relative-", async (dir) => {
    await mkdir(path.join(dir, "impl"));
    await writeFile(path.join(dir, "impl", "format.js"), "module.exports = {};\n");
    const entry = path.join(dir, "extension.cjs");
    await writeFile(
      entry,
      `"use strict";
const format = require("./impl/format");
module.exports = { activate: () => format, deactivate: () => format };
`
    );
    await expectLoadFailure(entry, "Cannot find module './impl/format'", "MODULE_NOT_FOUND");
  });
});

test("missing bare dependency fails even when available in node_modules beside the original entry", async () => {
  await withFixture("apl-bundle-bare-", async (dir) => {
    const packageDir = path.join(dir, "node_modules", "apl-fake-dep");
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), '{"name":"apl-fake-dep","main":"index.js"}\n');
    await writeFile(path.join(packageDir, "index.js"), "module.exports = {};\n");
    const entry = path.join(dir, "extension.cjs");
    await writeFile(
      entry,
      `"use strict";
const dep = require("apl-fake-dep");
module.exports = { activate: () => dep, deactivate: () => dep };
`
    );
    await expectLoadFailure(entry, "Cannot find module 'apl-fake-dep'", "MODULE_NOT_FOUND");
  });
});

test("incorrect exports fail: missing exports, non-function exports, and a throwing bundle", async () => {
  await withFixture("apl-bundle-exports-", async (dir) => {
    const empty = path.join(dir, "empty.cjs");
    await writeFile(empty, "module.exports = {};\n");
    await expectLoadFailure(empty, "must export activate as a function");

    const notFunctions = path.join(dir, "not-functions.cjs");
    await writeFile(notFunctions, 'module.exports = { activate: "yes", deactivate: 42 };\n');
    await expectLoadFailure(notFunctions, "must export activate as a function");

    const throwing = path.join(dir, "throwing.cjs");
    await writeFile(throwing, 'throw new Error("boom at load");\n');
    await expectLoadFailure(throwing, "boom at load");
  });
});

test("a hanging bundle fails on a short timeout and cleans up its temp dir", async () => {
  const before = listHelperDirs();
  await withFixture("apl-bundle-hang-", async (dir) => {
    const entry = path.join(dir, "extension.cjs");
    await writeFile(
      entry,
      "module.exports = { activate: () => {}, deactivate: () => {} };\nsetInterval(() => {}, 1000);\n"
    );
    const startedAt = Date.now();
    await assert.rejects(() => assertExtensionBundleLoads(entry, { timeoutMs: 200 }), /200ms time limit/);
    assert.ok(Date.now() - startedAt < 4_000, "timeout was not enforced promptly");
  });
  assert.deepEqual(
    listHelperDirs().filter((name) => !before.includes(name)),
    []
  );
});

test("a missing entry fails and cleans up its temp dir", async () => {
  const before = listHelperDirs();
  await assert.rejects(
    () => assertExtensionBundleLoads(path.join(os.tmpdir(), "apl-bundle-load-no-such-dir", "extension.cjs")),
    /failed to load/
  );
  assert.deepEqual(
    listHelperDirs().filter((name) => !before.includes(name)),
    []
  );
});

test("NODE_PATH cannot rescue an unresolved import in the child", async () => {
  await withFixture("apl-bundle-nodepath-", async (dir) => {
    const rescue = path.join(dir, "rescue");
    await mkdir(rescue);
    await writeFile(path.join(rescue, "apl-rescued.js"), "module.exports = {};\n");
    const entry = path.join(dir, "extension.cjs");
    await writeFile(
      entry,
      `"use strict";
const rescued = require("apl-rescued");
module.exports = { activate: () => rescued, deactivate: () => rescued };
`
    );
    const previous = process.env.NODE_PATH;
    process.env.NODE_PATH = rescue;
    try {
      await expectLoadFailure(entry, "Cannot find module 'apl-rescued'");
    } finally {
      if (previous === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = previous;
    }
    // Control: the same rescue directory is reachable when NODE_PATH is not stripped, proving the
    // fixture is valid and the failure above comes from the env cleanup.
    const reachable = await import("node:child_process").then(
      ({ execFile }) =>
        new Promise<boolean>((resolve) => {
          execFile(
            process.execPath,
            ["-e", "require('apl-rescued'); process.stdout.write('ok')"],
            { cwd: dir, env: { ...process.env, NODE_PATH: rescue } },
            (error, stdout) => resolve(!error && stdout === "ok")
          );
        })
    );
    assert.equal(reachable, true, "NODE_PATH control child failed");
  });
});

test("two concurrent calls use isolated temp directories", async () => {
  const before = listHelperDirs();
  await withFixture("apl-bundle-iso-a-", async (dirA) => {
    await withFixture("apl-bundle-iso-b-", async (dirB) => {
      // Each entry needs what it requires from its own directory only: A is self-contained and
      // must pass while B requires a sibling that exists nowhere, proving independent temp dirs.
      await writeFile(
        path.join(dirB, "extension.cjs"),
        `"use strict";
const value = require("./only-b");
module.exports = { activate: () => value, deactivate: () => value };
`
      );
      const entryA = path.join(dirA, "extension.cjs");
      await writeFile(entryA, GOOD_BUNDLE);
      const [resultA, resultB] = await Promise.allSettled([
        assertExtensionBundleLoads(entryA),
        assertExtensionBundleLoads(path.join(dirB, "extension.cjs"))
      ]);
      assert.equal(resultA.status, "fulfilled", String(resultA.reason));
      assert.equal(resultB.status, "rejected");
      assert.match(String(resultB.reason), /Cannot find module '\.\/only-b'/);
    });
  });
  assert.deepEqual(
    listHelperDirs().filter((name) => !before.includes(name)),
    []
  );
});

test("the child runs with a stripped environment: NODE_OPTIONS is not inherited", async () => {
  await withFixture("apl-bundle-nodeoptions-", async (dir) => {
    const entry = path.join(dir, "extension.cjs");
    await writeFile(entry, GOOD_BUNDLE);
    const previous = process.env.NODE_OPTIONS;
    // --frozen-lockfile does not exist: if NODE_OPTIONS leaked into the child, Node would refuse
    // to start and the load check would fail.
    process.env.NODE_OPTIONS = "--frozen-lockfile";
    try {
      await assert.doesNotReject(assertExtensionBundleLoads(entry));
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });
});
