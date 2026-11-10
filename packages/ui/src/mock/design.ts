import type { DesignTokens, SiteIndexApi } from "@siteindex/shared";
import { clone, designScreenshots, designTokens, reply } from "./context";

const designTokensV2: DesignTokens = {
  ...designTokens,
  color: {
    ...designTokens.color,
    roles: {
      primary: { value: "#2F5D3A", source: "--color-primary", confidence: 0.98 },
      secondary: null,
      text: { value: "#222222", source: "body color", confidence: 0.94 },
      text_muted: { value: "#6B6B6B", source: "--color-text-muted", confidence: 0.9 },
      background: { value: "#FFFFFF", source: "html background-color", confidence: 0.99 },
      surface: { value: "#F6F4EF", source: ".content-panel background-color", confidence: 0.82 },
      border: { value: "#E5E2DA", source: "--color-border", confidence: 0.95 },
      sale: { value: "#C0392B", source: ".price-sale color", confidence: 0.78 },
      link: { value: "#2B6480", source: "a color", confidence: 0.89 },
    },
  },
  typography: {
    ...designTokens.typography,
    font_families: { heading: "Lora, serif", body: "Inter, sans-serif", mono: "Consolas, monospace" },
    scale: {
      ...designTokens.typography.scale,
      h4: { size: "18px", weight: 600, line_height: "26px" },
      h5: { size: "16px", weight: 600, line_height: "24px" },
      h6: { size: "14px", weight: 600, line_height: "20px" },
      caption: { size: "12px", weight: 400, line_height: "18px", letter_spacing: "0.01em" },
    },
  },
  css_variables: {
    ...designTokens.css_variables,
    "--button-primary-background": "#2F5D3A",
    "--font-heading": "Lora, serif",
    "--space-4": "16px",
  },
  buttons: {
    primary: {
      background: "#2F5D3A", text_color: "#FFFFFF", border: "1px solid #2F5D3A",
      border_radius: "4px", padding: "12px 24px", font_size: "16px", font_weight: 600,
      hover_background: "#244B2E",
    },
    secondary: {
      background: "#FFFFFF", text_color: "#2F5D3A", border: "1px solid #2F5D3A",
      border_radius: "4px", padding: "12px 24px", font_size: "16px", font_weight: 600,
      hover_background: "#F6F4EF",
    },
    outline: {
      background: "transparent", text_color: "#2F5D3A", border: "1px solid #2F5D3A",
      border_radius: "4px", padding: "12px 24px", font_size: "16px", font_weight: 600,
      hover_background: "#F6F4EF",
    },
  },
};

export function createDesignMock(): SiteIndexApi["design"] {
  return { get: (id) => reply({ tokens: clone(designTokensV2), screenshots: designScreenshots(id) }) };
}
