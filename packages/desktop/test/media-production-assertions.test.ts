import { describe, expect, it } from "vitest";
import { hasMediaProgressEvidence } from "../src/main/media-production-assertions.js";

describe("packaged media E2E progress assertion", () => {
  it("requires utilityProcess progress to reach the renderer through preload", () => {
    expect(hasMediaProgressEvidence(3, 2)).toBe(true);
    expect(hasMediaProgressEvidence(0, 2)).toBe(false);
    expect(hasMediaProgressEvidence(3, 0)).toBe(false);
  });
});
