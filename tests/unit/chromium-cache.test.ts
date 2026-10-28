import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { expectedChromiumExecutable } from "../../src/services/chromium-cache.js";

const run = promisify(execFile);

describe("bundled chromium deployment metadata", () => {
  it.each([undefined, "0", "relative-browser-cache"])(
    "matches the runtime executable path for cache override %s without loading it in the host",
    async (override) => {
      const env = { ...process.env };
      if (override === undefined) delete env.PLAYWRIGHT_BROWSERS_PATH;
      else env.PLAYWRIGHT_BROWSERS_PATH = override;
      // Only this isolated Node child loads the browser package. No browser is launched.
      // This detects dependency/layout drift while preserving the extension's import boundary.
      const { stdout } = await run(
        process.execPath,
        ["-e", "process.stdout.write(require('playwright-core').chromium.executablePath())"],
        { env, windowsHide: true }
      );
      expect(await expectedChromiumExecutable(env)).toBe(stdout);
    }
  );
});
