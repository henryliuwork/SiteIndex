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

  it("keeps structured diagnostic details optional and IPC-serializable", () => {
    const legacy: SiteIndexError = { code: "WRITE_FAILED", message: "保存失败。", detail: "旧版详情" };
    const diagnostic: SiteIndexError = {
      code: "WRITE_FAILED",
      message: "保存失败。",
      error_detail: {
        code: "FILE_BUSY",
        operation: "settings.set",
        command: ["siteindex", "settings", "set", "--project", "~\\sample"],
        exitCode: 4,
        stderr: "resource temporarily unavailable",
        cause: "The target file is busy.",
      },
    };
    const roundTrip: unknown = JSON.parse(JSON.stringify(diagnostic));

    expect(legacy.error_detail).toBeUndefined();
    expect(isSiteIndexError(legacy)).toBe(true);
    expect(roundTrip).toEqual(diagnostic);
    expect(isSiteIndexError(roundTrip)).toBe(true);
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
