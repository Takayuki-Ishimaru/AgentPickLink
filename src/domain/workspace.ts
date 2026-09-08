import { createHash } from "node:crypto";
import { z } from "zod";
import { AliasSchema, BindingFingerprintSchema } from "./agent.js";
export const WorkspaceAgentRequestSchema = z
  .object({ alias: AliasSchema, bindingFingerprint: BindingFingerprintSchema.optional() })
  .strict();
export const WorkspaceConfigSchema = z
  .object({ version: z.literal(1), agents: z.array(WorkspaceAgentRequestSchema).max(20) })
  .strict()
  .superRefine((value, ctx) => {
    const aliases = new Set<string>();
    value.agents.forEach((a, i) => {
      if (aliases.has(a.alias))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", i, "alias"],
          message: "Agent aliases must be unique"
        });
      aliases.add(a.alias);
    });
  });
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type WorkspaceContext = {
  root: string;
  workspaceKey: string;
  config: WorkspaceConfig;
  configDigest: string;
};
export function canonicalWorkspaceConfig(config: WorkspaceConfig): string {
  return JSON.stringify({
    version: config.version,
    agents: [...config.agents]
      .sort((a, b) => a.alias.localeCompare(b.alias))
      .map((a) =>
        a.bindingFingerprint
          ? { alias: a.alias, bindingFingerprint: a.bindingFingerprint }
          : { alias: a.alias }
      )
  });
}
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
export function workspaceKey(root: string): string {
  return sha256(root).slice(0, 24);
}
export function configDigest(config: WorkspaceConfig): string {
  return sha256(canonicalWorkspaceConfig(config));
}
