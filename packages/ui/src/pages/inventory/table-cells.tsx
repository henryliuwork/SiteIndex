import type { SkuStockView } from "@siteindex/shared";
import { StatusCells } from "../../components";

export function InventoryRateCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="si-muted">—</span>;
  return <span className="si-rate-cell"><span className="si-rate-track"><span className={value < 0.6 ? "is-low" : ""} style={{ width: value * 100 + "%" }} /></span><span>{(value * 100).toFixed(0)}%</span></span>;
}

export function InventoryHistoryCell({ row }: { row: SkuStockView }) {
  const history = row.history_30d;
  if (!history || !/[iop]/.test(history)) return <span className="si-muted">—</span>;
  return <StatusCells history={history} />;
}
