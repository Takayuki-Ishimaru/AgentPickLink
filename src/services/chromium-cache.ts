import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/** Read installation metadata without loading the browser runtime in the extension host.
 * Package-relative data paths and executable layouts are deployment metadata in package.json;
 * the revision always comes from the browser dependency actually bundled with this installation. */
export async function expectedChromiumExecutable(
  environment: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const packageFile = requireFromHere.resolve("../../package.json");
    const metadata = (
      JSON.parse(await readFile(packageFile, "utf8")) as {
        browserRuntimeMetadata?: { manifest: string; chromiumExecutables: Record<string, string[]> };
      }
    ).browserRuntimeMetadata;
    if (!metadata) return undefined;
    const manifestFile = path.resolve(path.dirname(packageFile), metadata.manifest);
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
      browsers: Array<{ name: string; revision: string; revisionOverrides?: Record<string, string> }>;
    };
    const chromium = manifest.browsers.find((browser) => browser.name === "chromium");
    if (!chromium || !/^\d+$/.test(chromium.revision)) return undefined;
    // Chromium currently uses one revision on all supported hosts. Fail closed if a future
    // dependency introduces OS-specific overrides rather than claiming the wrong build is ready.
    if (chromium.revisionOverrides && Object.keys(chromium.revisionOverrides).length) return undefined;
    const platform = process.platform;
    const executable =
      metadata.chromiumExecutables[`${platform}-${platform === "win32" ? "x64" : process.arch}`];
    if (!executable) return undefined;
    const env = (name: string) =>
      environment[name] ||
      environment[`npm_config_${name.toLowerCase()}`] ||
      environment[`npm_package_config_${name.toLowerCase()}`];
    const override = env("PLAYWRIGHT_BROWSERS_PATH");
    const cache =
      override === "0"
        ? path.join(path.dirname(manifestFile), ".local-browsers")
        : override ||
          path.join(
            platform === "win32"
              ? environment.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
              : platform === "darwin"
                ? path.join(os.homedir(), "Library", "Caches")
                : environment.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
            "ms-playwright"
          );
    return path.join(
      path.resolve(env("INIT_CWD") || process.cwd(), cache),
      `chromium-${chromium.revision}`,
      ...executable
    );
  } catch {
    return undefined;
  }
}

export async function chromiumCacheHasBrowser(): Promise<boolean> {
  const executable = await expectedChromiumExecutable();
  if (!executable) return false;
  try {
    return (await stat(executable)).isFile();
  } catch {
    return false;
  }
}
