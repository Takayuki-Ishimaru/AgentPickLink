/**
 * Run-wide backstop for tests/setup/isolate-home.ts, which removes each test file's temp
 * directories in an `afterAll`. That hook never runs for a file whose tests were all skipped, or
 * for a worker vitest killed after a timeout, so every tracked directory is also listed in a
 * per-run manifest, and whatever is still listed when the run ends is removed here.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    aplTempManifest: string;
  }
}

export default function setup(project: TestProject): () => void {
  const manifest = path.join(os.tmpdir(), `apl-test-run-${randomUUID()}.list`);
  project.provide("aplTempManifest", manifest);
  return () => {
    let listed: string[] = [];
    try {
      listed = readFileSync(manifest, "utf8").split("\n").filter(Boolean);
    } catch {
      // Nothing was tracked.
    }
    for (const directory of new Set(listed)) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Still busy (e.g. a process a test left running on Windows): leave it.
      }
    }
    rmSync(manifest, { force: true });
  };
}
