import { createContext, useContext, type ReactNode } from "react";
import "./page-frame.css";

type PageFrameKind = "global" | "project";
const PageFrameKindContext = createContext<PageFrameKind | null>(null);

export function usePageFrameKind(): PageFrameKind | null {
  return useContext(PageFrameKindContext);
}

/** The shell owns viewport geometry; pages provide only their header and content. */
export function PageFrame({ kind, header, children, scroll = "content" }: {
  kind: PageFrameKind;
  header: ReactNode;
  children: ReactNode;
  scroll?: "content" | "table";
}) {
  return <PageFrameKindContext.Provider value={kind}><div className={`si-page-frame si-page-frame-${kind} is-${scroll}`}>
    <div className="si-page-frame-header">{header}</div>
    <div className="si-page-frame-body">{children}</div>
  </div></PageFrameKindContext.Provider>;
}
