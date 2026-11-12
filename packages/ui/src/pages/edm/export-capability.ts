import { PENDING_HANDLERS, type SiteIndexApi } from "@siteindex/shared";
import { EDM_EXPORT_RECONCILIATION_VERIFIED } from "./export-retry-state";

export interface EdmExportCapability {
  available: boolean;
  reconciliationVerified: boolean;
}

export function getEdmExportCapability(
  api: SiteIndexApi,
  pendingHandlers: readonly string[] = PENDING_HANDLERS,
): EdmExportCapability {
  if (pendingHandlers.includes("edm.exportIndex")) return { available: false, reconciliationVerified: EDM_EXPORT_RECONCILIATION_VERIFIED };
  return { available: typeof api.edm.exportIndex === "function", reconciliationVerified: EDM_EXPORT_RECONCILIATION_VERIFIED };
}

export function isEdmExportOutcomeUnknown(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EDM_EXPORT_OUTCOME_UNKNOWN";
}

export function isEdmExportDefinitiveNoWrite(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "NOT_IMPLEMENTED" || error.code === "EDM_INDEX_CONFLICT" || error.code === "WRITE_FAILED");
}
