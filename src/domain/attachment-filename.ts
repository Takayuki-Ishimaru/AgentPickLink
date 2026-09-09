/** Naming hints only. These helpers never authorize a download or interpret file content. */
export function isGenericAttachmentName(value: string): boolean {
  const leaf = value.trim().replace(/\\/g, "/").split("/").at(-1) ?? "";
  const stem = leaf.replace(/\.[^.]+$/, "");
  return (
    !leaf ||
    /^(?:attachment|download|file|document|untitled)(?:[-_ ]?\d+)?$/i.test(stem) ||
    /^[0-9a-f]{32}$/i.test(stem) ||
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stem) ||
    /^(?:(?:open|download|view|preview)(?:\s+(?:the\s+)?(?:file|result|document|pdf))?|ファイルを開く|開く|ダウンロード|プレビュー)(?:\s*[（(][^）)]+[）)])?$/i.test(
      leaf
    )
  );
}

/** Remove known button wording without normalizing the filename's Unicode or internal spaces. */
export function attachmentNameFromLabel(value: string): string | undefined {
  const label = value.trim();
  if (isGenericAttachmentName(label)) return undefined;
  const wrapped = label.match(/^[「『“"]([^」』”"]+)[」』”"](?:を)?(?:ダウンロード|開く|プレビュー)?$/)?.[1];
  const name =
    wrapped ??
    label
      .replace(/^(?:download|preview|open)\s+(?:file\s*[:：]\s*)?/i, "")
      .replace(/^(?:ダウンロード|プレビュー|ファイルを開く)\s*[:：]?\s+/, "")
      .replace(/(?:を)?(?:ダウンロード|プレビュー)(?:する)?$/, "")
      .trim();
  if (
    !name ||
    name.length > 240 ||
    /[\r\n<>:"/\\|?*]/.test(name) ||
    /^[A-Za-z0-9_-]{20,}$/.test(name) ||
    isGenericAttachmentName(name)
  )
    return undefined;
  return name;
}

export function filenameFromAttachmentUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    const values = [
      url.searchParams.get("filename"),
      url.searchParams.get("file"),
      url.searchParams.get("SourceUrl")
        ? decodeURIComponent(new URL(url.searchParams.get("SourceUrl")!, url).pathname)
        : undefined,
      decodeURIComponent(url.pathname)
    ];
    for (const item of values) {
      if (!item) continue;
      const leaf = item.replace(/\\/g, "/").split("/").at(-1)?.trim();
      if (
        !leaf ||
        !/\.[^./\\\s]+$/.test(leaf) ||
        /\.(?:aspx?|php)$/i.test(leaf) ||
        isGenericAttachmentName(leaf)
      )
        continue;
      return leaf;
    }
  } catch {
    /* Malformed URLs or percent encodings provide no naming hint. */
  }
  return undefined;
}
