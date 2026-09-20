import {
  applyEdits,
  createScanner,
  parseTree,
  getNodeValue,
  SyntaxKind,
  type Node,
  type ParseError
} from "jsonc-parser";

/** VS Code only. Fault-tolerant parsing must never turn malformed settings into a write. */
export function parseVscodeSettings(text: string): { tree: Node; value: Record<string, unknown> } {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || !tree || tree.type !== "object")
    throw new Error(
      `VS Code mcp.json contains invalid JSONC${errors[0] ? ` at offset ${errors[0].offset}` : " (expected an object)"}; file was not written.`
    );
  function check(node: Node): void {
    if (node.type === "object") {
      const keys = node.children?.map((property) => property.children![0].value) ?? [];
      if (new Set(keys).size !== keys.length)
        throw new Error("VS Code mcp.json contains duplicate keys; file was not written.");
    }
    node.children?.forEach(check);
  }
  check(tree);
  return { tree, value: getNodeValue(tree) as Record<string, unknown> };
}

/** Edit AST property/value and comma tokens only. Keep all surrounding comments and whitespace. */
export function editVscodeServer(
  text: string | undefined,
  value: Record<string, unknown> | undefined
): string {
  const source = text?.trim() ? text : "{}\n";
  const { tree } = parseVscodeSettings(source);
  const find = (node: Node, key: string) => node.children?.find((p) => p.children?.[0].value === key);
  const servers = find(tree, "servers")?.children?.[1];
  if (servers && servers.type !== "object")
    throw new Error("VS Code mcp.json servers must be an object; file was not written.");
  if (!servers && value === undefined) return source;
  const container = servers ?? tree;
  const key = servers ? "m365-agents" : "servers";
  const replacement = servers ? value : { "m365-agents": value };
  const property = find(container, key);
  if (!property && value === undefined) return source;
  const edits: Array<{ offset: number; length: number; content: string }> = [];
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const unit = /\n([\t ]+)"/.exec(source)?.[1] ?? "  ";
  const indent = (offset: number) =>
    /^[\t ]*/.exec(source.slice(source.lastIndexOf("\n", offset - 1) + 1))![0];
  const render = (item: unknown, prefix: string) =>
    JSON.stringify(item, null, unit).replace(/\n/g, `${eol}${prefix}`);
  if (property && value !== undefined) {
    const old = property.children![1];
    edits.push({ offset: old.offset, length: old.length, content: render(value, indent(property.offset)) });
  } else if (property) {
    edits.push({ offset: property.offset, length: property.length, content: "" });
    const scanner = createScanner(source, true);
    scanner.setPosition(container.offset + 1);
    const commas: number[] = [];
    while (
      scanner.scan() !== SyntaxKind.EOF &&
      scanner.getTokenOffset() < container.offset + container.length - 1
    )
      if (scanner.getToken() === SyntaxKind.CommaToken) commas.push(scanner.getTokenOffset());
    const next = container.children?.find((p) => p.offset > property.offset);
    const following = commas.find(
      (offset) =>
        offset >= property.offset + property.length &&
        offset < (next?.offset ?? container.offset + container.length - 1)
    );
    const previous = container.children?.filter((p) => p.offset < property.offset).at(-1);
    const preceding = previous
      ? commas.find((offset) => offset >= previous.offset + previous.length && offset < property.offset)
      : undefined;
    const comma = following ?? preceding;
    if (comma !== undefined) edits.push({ offset: comma, length: 1, content: "" });
  } else {
    const last = container.children?.at(-1);
    const close = container.offset + container.length - 1;
    let trailingComma = false;
    if (last) {
      const scanner = createScanner(source, true);
      scanner.setPosition(last.offset + last.length);
      trailingComma = scanner.scan() === SyntaxKind.CommaToken;
      if (!trailingComma) edits.push({ offset: last.offset + last.length, length: 0, content: "," });
    }
    const outer = servers ? indent(find(tree, "servers")!.offset) : "";
    const prefix = last ? indent(last.offset) || outer + unit : outer + unit;
    edits.push({
      offset: close,
      length: 0,
      content: `${eol}${prefix}${JSON.stringify(key)}: ${render(replacement, prefix)}${trailingComma ? "," : ""}${eol}${outer}`
    });
  }
  const result = applyEdits(source, edits);
  parseVscodeSettings(result);
  return result;
}
