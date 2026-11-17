/** Match configured URL path templates in order; commas separate independent prefixes. */
export function categorySlug(value: string): string {
  return value.toLowerCase().replaceAll("&", " and ")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "uncategorized";
}

export function categorySlugForUrl(url: string, configured?: string): string | null {
  let pathname: string;
  try { pathname = decodeURI(new URL(url).pathname); }
  catch { return null; }
  for (const value of (configured ?? "").split(",")) {
    const template = value.trim();
    if (!template.startsWith("/")) continue;
    const withSlug = template.includes("{slug}") ? template : `${template.replace(/\/$/, "")}/{slug}`;
    const escaped = withSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{slug\\}", "([^/]+)");
    const matched = new RegExp(`^${escaped}(?:/|$)`, "iu").exec(pathname);
    if (!matched?.[1]) continue;
    return categorySlug(matched[1]);
  }
  return null;
}
