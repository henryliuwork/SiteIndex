import { describe, expect, it } from "vitest";
import { formatFinding, inspectLine } from "../scripts/security-scan.mjs";

describe("public security scan output", () => {
  it("reports only path, line, category and count without echoing matched text", () => {
    const privateTerm = "HiddenBrand";
    const line = `Contact person@example.invalid for ${privateTerm}; SKU: ZX-12345`;
    const findings = inspectLine(line, [privateTerm]);
    const output = formatFinding("skills/sample/SKILL.md", 7, findings);

    expect(findings).toEqual([
      { category: "brand_term", count: 1 },
      { category: "email", count: 1 },
      { category: "sku", count: 1 },
    ]);
    expect(output).toBe("skills/sample/SKILL.md:7 brand_term=1 email=1 sku=1");
    expect(output).not.toContain(privateTerm);
    expect(output).not.toContain("person@example.invalid");
    expect(output).not.toContain("ZX-12345");
  });

  it("leaves safe generic guidance unreported", () => {
    expect(inspectLine("Resolve all folder paths from workspace.json.")).toEqual([]);
  });
});
