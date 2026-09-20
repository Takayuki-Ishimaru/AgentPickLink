/**
 * The running package's own `version`, read from `package.json` at run time instead of duplicated
 * as a literal in every module that reports a version.
 *
 * docs/extension-less-onboarding.md §4.7 C13 makes this load-bearing rather than cosmetic: the
 * broker's reported `packageVersion` is compared against `install.json`'s version on every `serve`
 * and every activation, so a literal left behind after a release bump would make every entry point
 * restart the broker forever.
 *
 * `createRequire(import.meta.url)` resolves `package.json` relative to *this module*, so it works
 * from a source checkout (`src/config/`), from `dist/config/`, and from a staged machine install
 * (`<home>/app/<version>/dist/config/`) alike -- each of which has the matching `package.json` two
 * directories up. The esbuild extension bundle rewrites `import.meta.url` to the bundle's own file
 * URL (`dist/extension/extension.cjs`), which lands on the same `package.json`; the local
 * `requireFromHere` binding is deliberately not named `require`, so esbuild treats the call as
 * opaque and never tries to inline `package.json` into the bundle.
 */
import { createRequire } from "node:module";

function readPackageVersion(): string {
  try {
    const requireFromHere = createRequire(import.meta.url);
    return (requireFromHere("../../package.json") as { version: string }).version;
  } catch {
    // A tree without a readable package.json is not a shape we ship; report an obviously-invalid
    // version rather than throwing at import time and taking the whole process down.
    return "0.0.0";
  }
}

export const PACKAGE_VERSION: string = readPackageVersion();
