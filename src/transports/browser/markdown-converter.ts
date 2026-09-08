/** Conservative HTML-to-Markdown conversion for one isolated assistant response. */
export function htmlToMarkdown(input: string): string {
  let value = input
    .replace(
      /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<svg\b[\s\S]*?<\/svg>|<button\b[\s\S]*?<\/button>/gi,
      ""
    )
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<[^>]+(?:aria-hidden=["']true["']|hidden)[^>]*>[\s\S]*?<\/[^>]+>/gi, "");
  value = value.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, table: string) => tableToMarkdown(table));
  value = value.replace(
    /<pre\b[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_, code: string) => `\n\`\`\`\n${decode(strip(code))}\n\`\`\`\n`
  );
  value = value.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level: string, content: string) => `\n${"#".repeat(Number(level))} ${decode(strip(content))}\n`
  );
  value = value.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, list: string) =>
    listItems(list)
      .map((item, index) => `${index + 1}. ${item}`)
      .join("\n")
  );
  value = value.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, list: string) =>
    listItems(list)
      .map((item) => `- ${item}`)
      .join("\n")
  );
  value = value.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, item: string) => `\n- ${decode(strip(item))}`);
  value = value.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
    (_, code: string) => `\`${decode(strip(code))}\``
  );
  value = value.replace(
    /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, _tag: string, content: string) => `**${decode(strip(content))}**`
  );
  value = value.replace(
    /<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, _tag: string, content: string) => `*${decode(strip(content))}*`
  );
  value = value.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, content: string) => {
      const label = decode(strip(content));
      try {
        const url = new URL(decode(href));
        return url.protocol === "https:" && !url.username && !url.password
          ? `[${label}](${url.toString()})`
          : label;
      } catch {
        return label;
      }
    }
  );
  value = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|section|article|blockquote)\b[^>]*>/gi, "\n");
  return decode(strip(value))
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tableToMarkdown(table: string): string {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) =>
      [...match[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) =>
        decode(strip(cell[1])).replace(/\|/g, "\\|").trim()
      )
    )
    .filter((row) => row.length);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array<string>(width - row.length).fill("")]);
  return `\n| ${normalized[0].join(" | ")} |\n| ${Array<string>(width).fill("---").join(" | ")} |\n${normalized
    .slice(1)
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n")}\n`;
}
function listItems(value: string): string[] {
  return [...value.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => decode(strip(match[1])).trim())
    .filter(Boolean);
}
function strip(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}
function decode(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}
