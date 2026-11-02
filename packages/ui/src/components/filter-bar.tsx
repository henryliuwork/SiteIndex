import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "./primitives";

interface FilterRowMetric {
  top: number;
  height: number;
}

export function calculateFilterBarCollapseHeight(items: readonly FilterRowMetric[]): number | null {
  const rows = new Map<number, number>();
  items.forEach(({ top, height }) => rows.set(top, Math.max(rows.get(top) ?? 0, height)));
  const rowTops = [...rows.keys()].sort((a, b) => a - b);
  const secondRowTop = rowTops[1];
  return rowTops.length > 2 && secondRowTop !== undefined
    ? secondRowTop + rows.get(secondRowTop)!
    : null;
}

export function FilterBar({ children, className = "" }: { children: ReactNode; className?: string }) {
  const itemsRef = useRef<HTMLDivElement>(null);
  const [collapseHeight, setCollapseHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const itemsId = useId();

  const measureRows = useCallback(() => {
    const items = itemsRef.current;
    if (!items) return;

    const containerTop = items.getBoundingClientRect().top;
    const metrics = Array.from(items.children).map((child) => {
      const rect = child.getBoundingClientRect();
      return { top: Math.round(rect.top - containerTop), height: Math.ceil(rect.height) };
    });
    setCollapseHeight(calculateFilterBarCollapseHeight(metrics));
  }, []);

  useEffect(() => {
    measureRows();
    const items = itemsRef.current;
    if (!items || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureRows);
    observer.observe(items);
    Array.from(items.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [children, measureRows]);

  const canCollapse = collapseHeight !== null;
  return (
    <div role="group" aria-label="筛选条件" className={"si-filter-bar" + (className ? " " + className : "") + (canCollapse && !expanded ? " is-collapsed" : "")}>
      <div
        className="si-filter-bar-items"
        id={itemsId}
        ref={itemsRef}
        style={collapseHeight === null ? undefined : { "--si-filter-bar-collapse-height": `${collapseHeight}px` } as CSSProperties}
      >{children}</div>
      {canCollapse && <Button
        className="si-filter-bar-toggle"
        size="small"
        variant="quiet"
        type="button"
        aria-expanded={expanded}
        aria-controls={itemsId}
        onClick={() => setExpanded((value) => !value)}
      >{expanded ? "收起筛选" : "更多筛选"}</Button>}
    </div>
  );
}
