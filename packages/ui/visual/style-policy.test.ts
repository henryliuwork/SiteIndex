import { describe, expect, it } from "vitest";
import { collectFontTokens, compareStyleFindings, countTimeDisplays, scanCssText } from "./style-policy";

describe("ui:check stylesheet policy", () => {
  it("rejects naked font sizes and reports values below 10px", () => {
    const tokens = collectFontTokens(":root { --fs-micro: 10px; --fs-body: 12px; }");
    const findings = scanCssText("page.css", ".label { font-size: 9px; } .body { font-size: var(--fs-body); }", tokens);

    expect(findings.map((finding) => finding.rule)).toEqual(["bare-font-size", "font-below-minimum"]);
  });

  it("enforces the 10px floor for font tokens", () => {
    const css = ":root { --fs-micro: 9px; }";
    const findings = scanCssText("styles/tokens.css", css, collectFontTokens(css));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("font-below-minimum");
  });

  it("rejects raw colors and spacing while allowing semantic colors, zero, and 1px borders", () => {
    const css = `
      .bad { color: #fff; gap: 8px; margin: 1px; --custom-shadow: 0 1px 2px rgba(0, 0, 0, .2); }
      .ok { color: var(--color-ink); padding: 0; border: 1px solid var(--color-line); }
    `;
    const findings = scanCssText("page.css", css);

    expect(findings.map((finding) => finding.rule)).toEqual(["bare-color", "bare-spacing", "bare-spacing", "bare-color"]);
  });

  it("does not count comments and compares against the legacy baseline", () => {
    const findings = scanCssText("page.css", "/* gap: 9px; */ .item { gap: 8px; }");
    const baseline = { "page.css|bare-spacing|gap:8px (8px)": 1 };
    const result = compareStyleFindings(findings, baseline);

    expect(result).toEqual({ introduced: [], legacyCount: 1, remainingBaselineCount: 0 });
  });

  it("warns heuristically when a page displays more than one date or time", () => {
    expect(countTimeDisplays("最近同步：11-16 17:00")).toBe(1);
    expect(countTimeDisplays("最近同步：11-16 17:00；GSC 数据截至 11-15")).toBe(2);
  });
});
