export function isDataTableRoute(routePath: string): boolean {
  return /\/p\/[^/]+\/(?:seo|products|inventory|edm|content|settings\/categories)$/.test(routePath);
}
