import { describe, expect, it } from "vitest";
import { compareSpacingFindings, hasMissingSpacingBaseline, validateSpacingExceptions, type SpacingException } from "../spacing-policy";
import type { SpacingFinding } from "../spacing-inspect";

const finding = (rule: SpacingFinding["rule"], key: string): SpacingFinding => ({ rule, key, message: key });

describe("spacing baseline", () => {
  const registeredException: SpacingException = {
    id: "fixture-explicit-exception", rule: "S3", reason: "仅用于验证显式注册的例外匹配逻辑",
  };

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

  it("allows only an explicitly registered rule/id pair; unrelated findings still fail", () => {
    const findings = [
      { ...finding("S3", "S3:registered"), exceptionId: registeredException.id },
      finding("S3", "S3:other"),
      { ...finding("S2", "S2:wrong-rule"), exceptionId: registeredException.id },
    ];
    const result = compareSpacingFindings(findings, [], [registeredException]);
    expect(result.introduced.map(({ key }) => key)).toEqual(["S3:other", "S2:wrong-rule"]);
    expect(result.legacyCount).toBe(0);
  });

  it("requires a reason and caps registered exceptions at two", () => {
    expect(() => validateSpacingExceptions({ version: 1, exceptions: [registeredException] })).not.toThrow();
    expect(() => validateSpacingExceptions({ version: 1, exceptions: [{ ...registeredException, reason: "" }] })).toThrow();
    expect(() => validateSpacingExceptions({ version: 1, exceptions: Array.from({ length: 3 }, (_, index) => ({ ...registeredException, id: `exception-${index}` })) })).toThrow();
  });

  it("does not require a baseline when all findings are registered exceptions", () => {
    const excepted = { ...finding("S3", "S3:registered"), exceptionId: registeredException.id };
    expect(hasMissingSpacingBaseline(undefined, compareSpacingFindings([excepted], undefined, [registeredException]).introduced)).toBe(false);
    expect(hasMissingSpacingBaseline(undefined, compareSpacingFindings([excepted, finding("S3", "S3:other")], undefined, [registeredException]).introduced)).toBe(true);
  });
});
