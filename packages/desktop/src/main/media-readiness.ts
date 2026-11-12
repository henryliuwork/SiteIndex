import { PENDING_HANDLERS } from "@siteindex/shared";
import type { CoreService } from "@siteindex/core";

/**
 * Keep production media preparation closed until both the Core service is
 * available and the shared contract no longer marks the public IPC as pending.
 */
export function isMediaPrepareReady(
  core: Pick<CoreService, "runJob"> | null,
  pendingHandlers: readonly string[] = PENDING_HANDLERS,
): boolean {
  return core !== null && !pendingHandlers.includes("media.prepare");
}
