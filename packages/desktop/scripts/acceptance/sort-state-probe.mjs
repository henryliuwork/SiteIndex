import { isDeepStrictEqual } from "node:util";

function mismatch(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

// Pass snapshots read from the packaged app and two runner-managed isolated profiles.
// This file does not create profiles or start the app; the unified runner owns that lifecycle.
export function assertSortScopeSnapshots({ primary, otherProject, otherDevice, tableId, peerTableId, expected,
  peerTableExpected = null, otherProjectExpected = null, otherDeviceExpected = null }) {
  if (!tableId || !peerTableId || tableId === peerTableId || !expected) {
    throw new Error("Sort acceptance needs two distinct table ids and the saved sort");
  }
  if (!isDeepStrictEqual(primary?.sorts?.[tableId], expected)) {
    throw mismatch(`Sort for ${tableId} was not retained after restart`);
  }
  for (const [scope, snapshot, ownSort] of [["other table", primary?.sorts?.[peerTableId], peerTableExpected],
    ["other project", otherProject?.sorts?.[tableId], otherProjectExpected],
    ["other device", otherDevice?.sorts?.[tableId], otherDeviceExpected]]) {
    if (!isDeepStrictEqual(snapshot ?? null, ownSort)) {
      throw mismatch(`Sort for ${tableId} changed in ${scope}`);
    }
  }
}
