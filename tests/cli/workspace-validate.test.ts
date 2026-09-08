import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkspaceValidate } from "../../src/cli/commands/workspace-validate.js";
import { makeCommandDeps, makeTempPaths, makeWorkspaceRoot } from "./helpers.js";

describe("workspace validate", () => {
  it("reports assignments without writing to the repository configuration file", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot([{ alias: "requirements" }]);
    const configPath = path.join(root, ".m365-agents.json");
    const before = await readFile(configPath, "utf8");
    const beforeEntries = (await readdir(root)).sort();
    const { deps } = makeCommandDeps({ paths, root: () => root });

    const result = await runWorkspaceValidate(deps);

    expect(result).toHaveProperty("assignments");
    expect((result as { assignments: unknown[] }).assignments).toHaveLength(1);
    const after = await readFile(configPath, "utf8");
    expect(after).toBe(before);
    expect((await readdir(root)).sort()).toEqual(beforeEntries);
  });

  it("reports 'unresolved' for an alias with no matching local registry entry", async () => {
    const paths = await makeTempPaths();
    const root = await makeWorkspaceRoot([{ alias: "missing-agent" }]);
    const { deps } = makeCommandDeps({ paths, root: () => root });

    const result = (await runWorkspaceValidate(deps)) as {
      assignments: Array<{ alias: string; status: string }>;
    };

    expect(result.assignments[0]).toMatchObject({ alias: "missing-agent", status: "unresolved" });
  });
});
