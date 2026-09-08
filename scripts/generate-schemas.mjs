#!/usr/bin/env node
// Regenerates schemas/*.json from the same zod schemas that validate the local config,
// registry, approvals, and workspace-config files at runtime (src/config/schema.ts,
// src/domain/workspace.ts), instead of hand-maintaining a second copy that can drift from
// what is actually enforced. Run `npm run build` first (both `schemas:generate` and
// `schemas:check` do this for you) so dist/ reflects the current source.
//
// Usage:
//   node scripts/generate-schemas.mjs          write schemas/*.json
//   node scripts/generate-schemas.mjs --check   fail (exit 1) if the checked-in files would change

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RegistrySchema, ApprovalStoreSchema, toDocumentedJsonSchema } from "../dist/config/schema.js";
import { WorkspaceConfigSchema } from "../dist/domain/workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(here, "..", "schemas");

const targets = [
  {
    file: "agent-registry.schema.json",
    id: "agent-registry.schema.json",
    title: "AgentPickLink local registry",
    schema: RegistrySchema
  },
  {
    file: "approvals.schema.json",
    id: "approvals.schema.json",
    title: "AgentPickLink local approvals",
    schema: ApprovalStoreSchema
  },
  {
    file: "workspace-config.schema.json",
    id: "workspace-config.schema.json",
    title: "AgentPickLink workspace request",
    schema: WorkspaceConfigSchema
  }
];

function render(target) {
  return `${JSON.stringify(toDocumentedJsonSchema(target.id, target.title, target.schema), null, 2)}\n`;
}

async function main() {
  const check = process.argv.includes("--check");
  const drifted = [];
  for (const target of targets) {
    const rendered = render(target);
    const filePath = path.join(schemasDir, target.file);
    if (check) {
      const existing = await readFile(filePath, "utf8").catch(() => undefined);
      if (existing !== rendered) drifted.push(target.file);
    } else {
      await writeFile(filePath, rendered, "utf8");
    }
  }
  if (check) {
    if (drifted.length) {
      process.stderr.write(
        `schemas/*.json is out of date with the zod schemas it is generated from: ${drifted.join(", ")}\nRun: npm run schemas:generate\n`
      );
      process.exitCode = 1;
    }
    return;
  }
  process.stdout.write(`Generated ${targets.map((target) => target.file).join(", ")}\n`);
}

await main();
