import type { ReactNode } from "react";
import "./page-frame.css";

/** The shell owns viewport geometry; pages provide only their header and content. */
export function PageFrame({ kind, header, children, scroll = "content" }: {
  kind: "global" | "project";
  header: ReactNode;
  children: ReactNode;
  scroll?: "content" | "table";
}) {
  return <div className={`si-page-frame si-page-frame-${kind} is-${scroll}`}>
    <div className="si-page-frame-header">{header}</div>
    <div className="si-page-frame-body">{children}</div>
  </div>;
}
