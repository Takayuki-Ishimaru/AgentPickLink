import { expect, it } from "vitest";
import { parseVscodeSettings } from "../../src/services/jsonc-settings.js";
import {
  mergeVscodeMcpJson,
  mergeVscodeUserMcpJson,
  removeVscodeMcpJson,
  parseJsonEntry,
  mergeClaudeMcpJson
} from "../../src/services/integrations.js";
const definition = { command: "/node", args: ["apl.js", "serve"], env: { M365_AGENT_MANAGED: "1" } };
it.each(["\n", "\r\n"])(
  "keeps comments, trailing commas, sibling formatting and inputs through add/update/remove (%j)",
  (eol) => {
    const source = [
      "// file comment",
      "{",
      '\t"servers": {',
      "\t\t// another server",
      '\t\t"other" : { "command" : "x", }, // keep inline',
      "\t},",
      '\t"inputs": [{ "id": "secret", }],',
      "}"
    ].join(eol);
    for (const merge of [mergeVscodeMcpJson, mergeVscodeUserMcpJson]) {
      const added = merge(source, definition);
      const updated = merge(added, { ...definition, command: "/new-node" });
      const removed = removeVscodeMcpJson(updated);
      for (const text of [added, updated, removed]) {
        expect(text).toContain(
          "// another server" + eol + '\t\t"other" : { "command" : "x", }, // keep inline'
        );
        expect(text).toContain('\t"inputs": [{ "id": "secret", }],');
      }
      expect(parseJsonEntry(updated, "vscodeMcpJson")?.command).toBe("/new-node");
      expect(parseVscodeSettings(removed).value).toEqual(parseVscodeSettings(source).value);
      expect(merge(updated, { ...definition, command: "/new-node" })).toBe(updated);
    }
  }
);
it.each(['{"servers": {oops}}', '{"servers": {}, "servers": {}}', '{"servers": null}'])(
  "refuses ambiguous or invalid configuration %s",
  (source) => {
    expect(() => mergeVscodeMcpJson(source, definition)).toThrow();
  }
);
it("keeps Claude's strict JSON contract", () => {
  expect(() => mergeClaudeMcpJson("// comment\n{}", definition)).toThrow(/plain JSON/);
});
it.each([
  '{"servers":{"m365-agents":{"env":{"M365_AGENT_MANAGED":"1"}},}}',
  '{"servers":{"other":{}, /* keep */ "m365-agents":{"env":{"M365_AGENT_MANAGED":"1"}}}}',
  '{"servers":{"m365-agents":{"env":{"M365_AGENT_MANAGED":"1"}}, /* keep */ "other":{},}}'
])("removes only the target and one adjacent comma: %s", (source) => {
  const result = removeVscodeMcpJson(source);
  expect(
    (parseVscodeSettings(result).value.servers as Record<string, unknown>)["m365-agents"]
  ).toBeUndefined();
  if (source.includes("/* keep */")) expect(result).toContain("/* keep */");
});
