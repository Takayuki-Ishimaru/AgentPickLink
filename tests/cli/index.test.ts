import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectInvocation } from "../../src/cli/index.js";

describe("CLI direct invocation detection", () => {
  it("recognizes a script launched through a symlink", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apl-cli-entry-"));
    const modulePath = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
    try {
      const linkPath = path.join(directory, "m365-agent.js");
      if (process.platform === "win32") {
        // A file symlink requires Developer Mode or elevated privileges on ordinary Windows
        // installations. A directory junction works without either and still exercises the
        // canonical-path comparison used by npm's package links.
        const linkDirectory = path.join(directory, "cli");
        await symlink(path.dirname(modulePath), linkDirectory, "junction");
        expect(isDirectInvocation(path.join(linkDirectory, path.basename(modulePath)), modulePath)).toBe(
          true
        );
      } else {
        await symlink(modulePath, linkPath);
        expect(isDirectInvocation(linkPath, modulePath)).toBe(true);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recognizes the regular path and rejects a different existing entry", () => {
    const modulePath = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
    const differentModulePath = fileURLToPath(new URL("../../src/cli/api.ts", import.meta.url));
    expect(isDirectInvocation(modulePath, modulePath)).toBe(true);
    expect(isDirectInvocation(differentModulePath, modulePath)).toBe(false);
    expect(isDirectInvocation(undefined, modulePath)).toBe(false);
  });
});
