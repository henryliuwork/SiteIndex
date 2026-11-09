import { describe, expect, it } from "vitest";
import { formatDateTime } from "./date-time";

describe("formatDateTime", () => {
  it("formats a local timestamp as month-day and 24-hour time", () => {
    const date = new Date(2026, 10, 8, 17, 0);
    expect(formatDateTime(date.toISOString())).toBe("11-08 17:00");
  });

  it("shows a dash for missing or invalid timestamps", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });
});
