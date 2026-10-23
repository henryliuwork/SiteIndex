import { lazy, Suspense, type ComponentType } from "react";
import type { RouteObject } from "react-router-dom";

type PageModule = { default: ComponentType };

export function createPageRoute(path: string, loadingText: string, load: () => Promise<PageModule>): RouteObject {
  const Page = lazy(load);
  return {
    path,
    element: <Suspense fallback={<div className="si-page-loading" role="status">{loadingText}</div>}><Page /></Suspense>,
  };
}
