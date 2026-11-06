import { describe, expect, it } from "vitest";
import type { DesignTokens } from "../src/models";

const legacyTokens: DesignTokens = {
  extracted_at: "2026-11-06T00:00:00.000Z",
  source_pages: ["https://shop.example.test/"],
  css_variables: {},
  color: { primary: null, text: null, background: null, palette: [] },
  typography: { font_families: {}, scale: {} },
  spacing: [],
  radius: [],
  shadow: [],
  components: {},
  assets: {},
};

const tokensV2: DesignTokens = {
  ...legacyTokens,
  color: {
    ...legacyTokens.color,
    roles: {
      primary: { value: "#123456", source: "--brand-primary", confidence: 0.96 },
      secondary: null,
      text: { value: "#222222", source: "body", confidence: 0.93 },
      text_muted: null,
      background: { value: "#ffffff", source: "html", confidence: 0.99 },
      surface: null,
      border: null,
      sale: null,
      link: { value: "#0055aa", source: "a", confidence: 0.91 },
    },
  },
  typography: {
    font_families: { heading: "Demo Sans", body: "Demo Sans", mono: "Demo Mono" },
    scale: {
      h1: { size: "32px", weight: 700, line_height: "1.2", letter_spacing: "-0.02em" },
      h2: { size: "28px", weight: 700, line_height: "1.25" },
      h3: { size: "24px", weight: 600, line_height: "1.3" },
      h4: { size: "20px", weight: 600, line_height: "1.35" },
      h5: { size: "18px", weight: 600, line_height: "1.4" },
      h6: { size: "16px", weight: 600, line_height: "1.45" },
      body: { size: "14px", weight: 400, line_height: "1.5" },
      small: { size: "12px", weight: 400, line_height: "1.45" },
      caption: { size: "11px", weight: 400, line_height: "1.4" },
    },
  },
  buttons: {
    primary: {
      background: "#123456",
      text_color: "#ffffff",
      border: "1px solid #123456",
      border_radius: "4px",
      padding: "8px 12px",
      font_size: "14px",
      font_weight: 600,
      hover_background: "#102b45",
    },
    secondary: null,
    outline: {
      background: "transparent",
      text_color: "#123456",
      border: "1px solid #123456",
      border_radius: "4px",
      padding: "8px 12px",
      font_size: "14px",
      font_weight: 600,
    },
  },
  spacing: ["8px", "16px"],
  radius: ["4px", "8px"],
  shadow: ["none", "0 1px 2px rgb(0 0 0 / 0.1)"],
};

describe("DesignTokens v2 compatibility", () => {
  it("keeps legacy token files valid without any v2 properties", () => {
    expect(legacyTokens.color.palette).toEqual([]);
    expect(legacyTokens.buttons).toBeUndefined();
  });

  it("allows role colors, typography hierarchy and button variants with unavailable values", () => {
    expect(Object.keys(tokensV2.color.roles ?? {})).toHaveLength(9);
    expect(tokensV2.color.roles?.surface).toBeNull();
    expect(tokensV2.typography.scale.h1?.letter_spacing).toBe("-0.02em");
    expect(tokensV2.buttons?.secondary).toBeNull();
    expect(tokensV2.spacing).toHaveLength(2);
  });
});