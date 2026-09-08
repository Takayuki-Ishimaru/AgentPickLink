import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFailureDiagnostic } from "../../src/observability/diagnostics.js";

describe("failure diagnostics", () => {
  it("never uses an unsafe request ID as a path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-diagnostics-"));
    await writeFailureDiagnostic(directory, {
      requestId: "../../outside",
      errorCode: "UI_CHANGED",
      stateTransitions: [],
      uiFingerprint: { hasComposer: false },
      hostname: "tenant.example"
    });
    expect(await readdir(directory)).toEqual(expect.arrayContaining(["failure.json"]));
  });
});
