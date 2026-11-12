export function isMediaPrepareContractOpen(pendingHandlers: readonly string[]): boolean {
  return !pendingHandlers.includes("media.prepare");
}
