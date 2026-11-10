export function isDataTableRoute(routePath: string): boolean {
  return /\/p\/[^/]+\/(?:seo|products|inventory|edm|settings\/categories)$/.test(routePath);
}
