import { describe, expect, it } from "vitest";
import { getVerticalScrollDelta } from "../../visual/readiness";

describe("ui:check scrollable content positioning", () => {
  it("scrolls a target down or up within its scroll viewport and leaves visible targets in place", () => {
    const viewport = { top: 100, bottom: 700 };

    expect(getVerticalScrollDelta({ top: 1200, bottom: 1400 }, viewport)).toBe(700);
    expect(getVerticalScrollDelta({ top: 50, bottom: 250 }, viewport)).toBe(-50);
    expect(getVerticalScrollDelta({ top: 200, bottom: 600 }, viewport)).toBe(0);
  });
});
