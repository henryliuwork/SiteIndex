/** Turn comma-separated category prefixes into the URL rules understood by Core. */
export function categoryUrlRules(value: string): string[] {
  return [...new Set(value.split(/[,，]/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const path = (part.startsWith("/") ? part : `/${part}`).replace(/\/+$/, "");
    return path.includes("{slug}") ? path : `${path}/{slug}`;
  }))];
}

export function addCategoryUrlRule(current: string, candidate: string): string {
  return categoryUrlRules([current, candidate].filter(Boolean).join(", ")).join(", ");
}
