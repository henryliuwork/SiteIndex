export type EdmExportSafetyState = "ready" | "blocked" | "unavailable";

const STORAGE_PREFIX = "siteindex:edm-export-attempt:";
const STORAGE_EVENT = "siteindex:edm-export-safety-change";
const inMemoryAttempts = new Map<string, { state: "pending" | "unknown" | "unavailable"; attemptId?: string }>();

/** Enable only after backend preflight re-reads and validates marker, contents and expected output on every call. */
export const EDM_EXPORT_RECONCILIATION_VERIFIED = false;

function storageKey(projectId: string): string {
  return STORAGE_PREFIX + encodeURIComponent(projectId);
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function createAttemptId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* fall through to a local identifier */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function publish(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(STORAGE_EVENT, { detail: { projectId } }));
}

function storedAttemptId(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "attemptId" in parsed && typeof parsed.attemptId === "string") return parsed.attemptId;
  } catch { /* Legacy or malformed markers remain blocked, but cannot be cleared by an unrelated attempt. */ }
  return undefined;
}

export function subscribeEdmExportSafety(projectId: string, listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey(projectId) || event.key === null) listener();
  };
  const onLocalChange = (event: Event) => {
    if (event instanceof CustomEvent && event.detail?.projectId === projectId) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(STORAGE_EVENT, onLocalChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(STORAGE_EVENT, onLocalChange);
  };
}

export function getEdmExportSafetyState(
  projectId: string,
  reconciliationVerified = EDM_EXPORT_RECONCILIATION_VERIFIED,
): EdmExportSafetyState {
  if (reconciliationVerified) return "ready";
  const memoryState = inMemoryAttempts.get(projectId)?.state;
  if (memoryState === "pending" || memoryState === "unknown") return "blocked";
  const storage = getStorage();
  if (!storage) return "unavailable";
  if (memoryState === "unavailable") {
    try {
      const probeKey = `${STORAGE_PREFIX}__probe__:${createAttemptId()}`;
      storage.setItem(probeKey, "1");
      storage.removeItem(probeKey);
      inMemoryAttempts.delete(projectId);
    } catch {
      return "unavailable";
    }
  }
  try {
    return storage.getItem(storageKey(projectId)) === null ? "ready" : "blocked";
  } catch {
    return "unavailable";
  }
}

/** Persist an in-flight marker before calling IPC, so a renderer exit fails closed. */
export function beginEdmExportAttempt(
  projectId: string,
  reconciliationVerified = EDM_EXPORT_RECONCILIATION_VERIFIED,
): string | null {
  if (getEdmExportSafetyState(projectId, reconciliationVerified) !== "ready") return null;
  const attemptId = createAttemptId();
  if (reconciliationVerified) return attemptId;
  const storage = getStorage();
  if (!storage) return null;
  try {
    const marker = JSON.stringify({ version: 1, state: "pending", attemptId, startedAt: new Date().toISOString() });
    storage.setItem(storageKey(projectId), marker);
    if (storedAttemptId(storage.getItem(storageKey(projectId))) !== attemptId) return null;
    inMemoryAttempts.set(projectId, { state: "pending", attemptId });
    publish(projectId);
    return attemptId;
  } catch {
    inMemoryAttempts.set(projectId, { state: "unavailable" });
    publish(projectId);
    return null;
  }
}

/** Keep the marker after an uncertain write; UI has no safe reconciliation API yet. */
export function keepEdmExportAttemptBlocked(projectId: string, attemptId: string): void {
  const current = inMemoryAttempts.get(projectId);
  if (current?.attemptId !== attemptId) return;
  inMemoryAttempts.set(projectId, { state: "unknown", attemptId });
  try {
    const storage = getStorage();
    if (storage && storedAttemptId(storage.getItem(storageKey(projectId))) === attemptId) {
      storage.setItem(storageKey(projectId), JSON.stringify({ version: 1, state: "unknown", attemptId }));
    }
  } catch {
    // The in-memory marker still blocks retries for this renderer lifetime.
  }
  publish(projectId);
}

/** Clear only this execution's marker after a confirmed result or contract-defined no-write error. */
export function resolveEdmExportAttempt(
  projectId: string,
  attemptId: string,
  reconciliationVerified = EDM_EXPORT_RECONCILIATION_VERIFIED,
): boolean {
  if (reconciliationVerified) {
    inMemoryAttempts.delete(projectId);
    try { getStorage()?.removeItem(storageKey(projectId)); } catch { /* backend now reconciles every call */ }
    publish(projectId);
    return true;
  }
  const storage = getStorage();
  if (!storage) {
    inMemoryAttempts.set(projectId, { state: "unknown", attemptId });
    publish(projectId);
    return false;
  }
  try {
    if (storedAttemptId(storage.getItem(storageKey(projectId))) !== attemptId) {
      inMemoryAttempts.set(projectId, { state: "unknown", attemptId });
      publish(projectId);
      return false;
    }
    storage.removeItem(storageKey(projectId));
    inMemoryAttempts.delete(projectId);
    publish(projectId);
    return true;
  } catch {
    inMemoryAttempts.set(projectId, { state: "unknown", attemptId });
    publish(projectId);
    return false;
  }
}
