import { describe, expect, it } from "vitest";
import type { SyncState } from "@siteindex/shared";
import { feedConfigurationStatus, projectWarningAction } from "./feed-action";

function summary(state: SyncState, at: string | null = null, attention = 0) {
  return { sync: { state, at, job: null }, attention };
}

describe("project center feed warning actions", () => {
  it("uses the saved feed configuration, including multiple URLs", () => {
    expect(feedConfigurationStatus("")).toBe("missing");
    expect(feedConfigurationStatus("  ")).toBe("missing");
    expect(feedConfigurationStatus(["  ", "https://shop.example/feed.xml"])).toBe("configured");
    expect(feedConfigurationStatus(undefined)).toBe("unknown");
  });

  it("shows the feed action only when configuration confirms there is no feed", () => {
    expect(projectWarningAction(summary("failed"), "missing")).toBe("feed");
    expect(projectWarningAction(summary("failed"), "configured")).toBe("runs");
    expect(projectWarningAction(summary("partial"), "configured")).toBe("runs");
    expect(projectWarningAction(summary("never"), "configured")).toBe("runs");
    expect(projectWarningAction(summary("ok"), "configured")).toBe("project");
    expect(projectWarningAction(summary("failed"), "unknown")).toBeNull();
  });

  it("routes a stale project with a configured feed to its run history", () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    expect(projectWarningAction(summary("ok", "2026-10-28T00:00:00.000Z"), "configured", now)).toBe("runs");
  });
});
