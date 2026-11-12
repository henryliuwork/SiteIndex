import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "../src/api";
import { isSiteIndexError, type SiteIndexError } from "../src/errors";

describe("project storage error contract", () => {
  it("supports a stable error for known cloud sync project locations", () => {
    const error: SiteIndexError = {
      code: "PROJECT_CLOUD_SYNC_UNSUPPORTED",
      message: "当前版本仅支持本机项目数据。",
    };

    expect(isSiteIndexError(error)).toBe(true);
  });

  it("marks known sync roots without claiming unknown roots are local", () => {
    const knownSyncLocation: Pick<ProjectSummary, "storage_location"> = {
      storage_location: "known_cloud_sync",
    };
    const unknownLocation: Pick<ProjectSummary, "storage_location"> = {};

    expect(knownSyncLocation.storage_location).toBe("known_cloud_sync");
    expect(unknownLocation.storage_location).toBeUndefined();
  });
});
