// Indexed and excerpted text only. sources.text stays the immutable original.
const BEGIN = "<!-- CURSOR_AGENT_PR_BODY_BEGIN -->";
const END = "<!-- CURSOR_AGENT_PR_BODY_END -->";

function badgeCut(text: string): number {
  const patterns = [
    /<div>\s*<a\b[^>]*href="https:\/\/cursor\.com\/[^"]*"[^>]*>\s*<picture\b/iu,
    /<picture>\s*<source\b[^>]*open-in-(?:web|cursor)/iu,
    /<img\b[^>]*alt="Open in (?:Web|Cursor)"/iu,
  ];
  let cut = text.length;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match.index < cut) cut = match.index;
  }
  return cut;
}

function stripTrailingBadge(text: string): string {
  const cut = badgeCut(text);
  if (cut === text.length) return text;
  const prose = text
    .slice(cut)
    .replace(/<[^>]*>/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/Open in (?:Web|Cursor)/gu, " ")
    .replace(/\s+/gu, "");
  if (prose.length > 0) return text;
  return text.slice(0, cut);
}

export function visibleSourceText(text: string): string {
  if (
    !text.includes("CURSOR_AGENT_PR_BODY") &&
    !text.includes("Open in Web") &&
    !text.includes("Open in Cursor") &&
    !text.includes("cursor.com/assets/images/open-in-")
  )
    return text;
  const startedAtMarker = text.trimStart().startsWith(BEGIN);
  const end = text.indexOf(END);
  let value = end === -1 ? text : text.slice(0, end);
  if (value.includes(BEGIN)) value = value.replaceAll(BEGIN, "");
  value = stripTrailingBadge(value);
  if (value === text) return text;
  value = value.replace(/\s+$/u, "");
  return startedAtMarker ? value.trimStart() : value;
}
