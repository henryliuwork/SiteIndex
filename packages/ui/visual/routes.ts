export function isDataTableRoute(routePath: string): boolean {
  return /\/p\/[^/]+\/(?:seo|products|inventory|edm|content|settings\/categories)$/.test(routePath);
}

export function routeCaseUrl(baseUrl: string, mockQuery: string, routePath: string, routeName: string): string {
  const url = new URL(mockQuery, baseUrl);
  // Distinct URLs force a fresh document when two cases share the same hash route.
  url.searchParams.set("ui_check_case", routeName);
  url.hash = routePath;
  return url.href;
}
