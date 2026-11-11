import { PENDING_HANDLERS, type SiteIndexApi } from "@siteindex/shared";

export interface EdmExportCapability {
  available: boolean;
}

export function getEdmExportCapability(
  api: SiteIndexApi,
  pendingHandlers: readonly string[] = PENDING_HANDLERS,
): EdmExportCapability {
  if (pendingHandlers.includes("edm.exportIndex")) return { available: false };
  return { available: typeof api.edm.exportIndex === "function" };
}

export function isEdmExportOutcomeUnknown(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EDM_EXPORT_OUTCOME_UNKNOWN";
}
