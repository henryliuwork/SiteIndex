import type { ReactNode } from "react";
import "./table-section.css";

/** Shared vertical order above a DataTable. Pass null when no filters are selected. */
export function TableSection({ summary, selectedFilters, children }: {
  summary?: ReactNode;
  selectedFilters?: ReactNode;
  children: ReactNode;
}) {
  return <div className="si-table-section">
    {summary != null && summary !== false && <div className="si-table-section-summary">{summary}</div>}
    {selectedFilters != null && selectedFilters !== false && <div className="si-table-section-selected-filters">{selectedFilters}</div>}
    {children}
  </div>;
}
