import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { defaultGlobalConfig } from "../../src/config/global-config.js";
import { SetupService } from "../../src/services/setup-service.js";
import { runInstall } from "../../src/cli/commands/install.js";
import { makeCommandDeps, makeTempPaths } from "./helpers.js";

describe("install dry-run uses read-only browser detection", () => {
  it.each([false, true])("does not initialize or migrate app data (legacy=%s)", async (legacy) => {
    const paths = await makeTempPaths();
    const workspace = path.join(path.dirname(paths.root), "workspace");
    await mkdir(workspace);
    let before: string | undefined;
    if (legacy) {
      await mkdir(paths.root);
      const config = {
        ...defaultGlobalConfig(paths.profile),
        downloadDefaultsVersion: undefined,
        headlessDefaultsVersion: undefined
      };
      before = YAML.stringify(config);
      await writeFile(paths.config, before);
    }
    const { deps } = makeCommandDeps({
      paths,
      packageRoot: async () => workspace,
      createSetupService: (deps, root) =>
        new SetupService({
          paths,
          root,
          preparer: deps.preparer,
          connect: async () => {
            throw new Error("must not connect");
          },
          detectBrowser: async () => ({
            channel: "msedge",
            installed: false,
            alternatives: [{ channel: "chrome", installed: true }]
          })
        })
    });
    const result = await runInstall(deps, { workspaces: [workspace], dryRun: true, clients: "none" });
    expect(result.dryRun).toBe(true);
    if (legacy) expect(await readFile(paths.config, "utf8")).toBe(before);
    else await expect(stat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
