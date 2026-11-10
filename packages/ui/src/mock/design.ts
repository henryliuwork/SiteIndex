import type { SiteIndexApi } from "@siteindex/shared";
import type { DesignTokens } from "@siteindex/shared";
import { clone, designScreenshots, designTokens as legacyDesignTokens, reply } from "./context";

const designTokens: DesignTokens = {
  ...legacyDesignTokens,
  css_variables: {
    ...legacyDesignTokens.css_variables,
    "--color-secondary": "#B26A35",
    "--color-link": "#2B6480",
  },
  color: {
    ...legacyDesignTokens.color,
    secondary: "#B26A35",
    roles: {
      primary: { value: "#2F5D3A", source: "--color-primary", confidence: 0.98 },
      secondary: { value: "#B26A35", source: "button.secondary background", confidence: 0.84 },
      text: { value: "#222222", source: "body color", confidence: 0.99 },
      text_muted: { value: "#6B6B6B", source: "--color-text-muted", confidence: 0.94 },
      background: { value: "#FFFFFF", source: "html background-color", confidence: 0.99 },
      surface: { value: "#F6F4EF", source: ".content-panel background-color", confidence: 0.82 },
      border: { value: "#E5E2DA", source: "--color-border", confidence: 0.95 },
      sale: { value: "#C0392B", source: ".price-sale color", confidence: 0.78 },
      link: { value: "#2B6480", source: "a color", confidence: 0.89 },
    },
  },
  typography: {
    font_families: { heading: "Lora, serif", body: "Inter, sans-serif", mono: "Consolas, monospace" },
    scale: {
      h1: { size: "40px", weight: 700, line_height: "48px", letter_spacing: "-0.02em" },
      h2: { size: "28px", weight: 600, line_height: "36px" },
      h3: { size: "20px", weight: 600, line_height: "28px" },
      h4: { size: "18px", weight: 600, line_height: "26px" },
      h5: { size: "16px", weight: 600, line_height: "24px" },
      h6: { size: "14px", weight: 600, line_height: "20px" },
      body: { size: "16px", weight: 400, line_height: "26px" },
      small: { size: "13px", weight: 400, line_height: "20px" },
      caption: { size: "12px", weight: 400, line_height: "18px", letter_spacing: "0.01em" },
    },
  },
  buttons: {
    primary: { background: "#2F5D3A", text_color: "#FFFFFF", border: null, border_radius: "4px", padding: "12px 24px", font_size: "14px", font_weight: 600, hover_background: "#24482D" },
    secondary: { background: "#FFFFFF", text_color: "#2F5D3A", border: "1px solid #2F5D3A", border_radius: "4px", padding: "12px 24px", font_size: "14px", font_weight: 600 },
    outline: { background: null, text_color: "#2F5D3A", border: "1px solid #2F5D3A", border_radius: "4px", padding: "12px 24px", font_size: "14px", font_weight: 600 },
  },
};

export function createDesignMock(): SiteIndexApi["design"] {
  return { get: (id) => reply({ tokens: clone(designTokens), screenshots: designScreenshots(id) }) };
}
