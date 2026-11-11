import type { SkuStockView } from "@siteindex/shared";
import { StatusCells } from "../../components";

type InventoryDuration = Pick<SkuStockView, "is_parent" | "days_in_status">;

export function formatInventoryTableDuration(row: InventoryDuration): string {
  if (row.is_parent) return "—";
  return row.days_in_status >= 60 ? "60 天+" : row.days_in_status <= 1 ? "今天" : row.days_in_status + " 天";
}

export function formatInventoryDetailDuration(row: InventoryDuration): string {
  return row.is_parent ? "—" : `${row.days_in_status} 天`;
}

export function InventoryRateCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="si-muted">—</span>;
  return <span className="si-rate-cell"><span className="si-rate-track"><span className={value < 0.6 ? "is-low" : ""} style={{ width: value * 100 + "%" }} /></span><span>{(value * 100).toFixed(0)}%</span></span>;
}

export function InventoryHistoryCell({ row }: { row: SkuStockView }) {
  const history = row.history_30d;
  if (!history || !/[iop]/.test(history)) return <span className="si-muted">—</span>;
  return <StatusCells history={history} />;
}
