import { describe, expect, it } from "vitest";
import { compareSpacingFindings } from "../spacing-policy";
import type { SpacingFinding } from "../spacing-inspect";

const finding = (rule: SpacingFinding["rule"], key: string): SpacingFinding => ({ rule, key, message: key });

describe("spacing baseline", () => {
  it("fails a new violation even if a different old violation was resolved", () => {
    const result = compareSpacingFindings([finding("S1", "S1:new")], ["S1:old"]);
    expect(result.introduced.map((item) => item.key)).toEqual(["S1:new"]);
    expect(result.resolvedKeys).toEqual(["S1:old"]);
  });

  it("keeps a known violation and reports stale keys for page migration", () => {
    const result = compareSpacingFindings([finding("S2", "S2:known")], ["S2:known", "S3:resolved"]);
    expect(result.introduced).toEqual([]);
    expect(result.legacyCount).toBe(1);
    expect(result.resolvedKeys).toEqual(["S3:resolved"]);
  });
});
