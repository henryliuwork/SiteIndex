// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { DesignTokens, SiteIndexApi } from "@siteindex/shared";

const tokensFixture: DesignTokens = {
  extracted_at: "2026-11-10T10:00:00Z",
  source_pages: ["https://demo.example.test/"],
  css_variables: { "--color-primary": "#2F5D3A", "--font-body": "Inter" },
  color: {
    primary: "#2F5D3A", text: "#222222", background: "#FFFFFF", palette: [],
    roles: {
      primary: { value: "#2F5D3A", source: "--color-primary", confidence: 0.98 },
      secondary: null,
      text: { value: "#222222", source: "body color", confidence: 0.9 },
      text_muted: null,
      background: { value: "#FFFFFF", source: "html background-color", confidence: 0.96 },
      surface: null,
      border: null,
      sale: null,
      link: { value: "#2B6480", source: "a color", confidence: 0.88 },
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
      caption: { size: "12px", weight: 400, line_height: "18px" },
    },
  },
  spacing: [], radius: [], shadow: [], components: {}, assets: {},
  buttons: {
    primary: { background: "#2F5D3A", text_color: "#FFFFFF", border: null, border_radius: "4px", padding: "12px 24px", font_size: "14px", font_weight: 600 },
    secondary: { background: null, text_color: "#2F5D3A", border: "1px solid #2F5D3A", border_radius: "4px", padding: "12px 24px", font_size: "14px", font_weight: 600 },
    outline: { background: null, text_color: "#2F5D3A", border: "1px solid #2F5D3A", border_radius: "4px", padding: "12px 24px", font_size: "14px", font_weight: 600 },
  },
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

function createDesignApi(tokens: DesignTokens | null = tokensFixture) {
  const copyText = vi.fn(async () => undefined);
  const api = {
    projects: { get: vi.fn(async () => ({ summary: { id: "demo", name: "演示项目", domain: "demo.example.test", platform: "other", path: "C:/demo" } })) },
    design: { get: vi.fn(async () => ({ tokens, screenshots: [] })) },
    jobs: { onProgress: vi.fn(() => () => undefined), onFinished: vi.fn(() => () => undefined), run: vi.fn(async () => ({ runId: "run-1" })) },
    shell: { copyText, openPath: vi.fn(async () => undefined) },
  } as unknown as SiteIndexApi;
  return { api, copyText };
}

async function renderDesignPage(api: SiteIndexApi) {
  vi.doMock("../api", () => ({
    api,
    apiErrorMessage: (error: unknown, fallback: string) =>
      typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : fallback,
  }));
  const [{ DesignPage }, { ToastProvider }] = await Promise.all([import("./DesignPage"), import("../components")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ToastProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/p/demo/design"]}>
          <Routes><Route path="/p/:id/design" element={<DesignPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>,
  );
}

describe("DesignPage Token v2", () => {
  it("展示颜色角色来源与置信度、完整字号层级、按钮规范和可折叠 CSS 变量", async () => {
    const { api } = createDesignApi();
    await renderDesignPage(api);

    expect(await screen.findByRole("heading", { name: "颜色角色" })).toBeTruthy();
    expect(document.querySelector(".si-design-role-content code")?.textContent).toBe("--color-primary");
    expect(screen.getByText("置信度：98%")).toBeTruthy();
    expect(screen.getByText("一级标题 H1")).toBeTruthy();
    expect(screen.getByText("六级标题 H6")).toBeTruthy();
    expect(screen.getByText("说明 Caption")).toBeTruthy();
    expect(document.querySelector(".si-design-type-row .si-design-type-metrics")?.textContent).toContain("字距 -0.02em");
    expect(screen.getByRole("heading", { name: "按钮规范" })).toBeTruthy();
    expect(screen.getByText("描边按钮")).toBeTruthy();

    const variables = document.querySelector<HTMLDetailsElement>(".si-design-css-variables");
    expect(variables?.open).toBe(false);
    fireEvent.click(screen.getByText("原始 CSS 变量"));
    expect(variables?.open).toBe(true);
    expect(variables?.textContent).toContain("--color-primary");
    expect(screen.queryByRole("heading", { name: "间距 · 圆角 · 阴影" })).toBeNull();
  });

  it("缺失的 Token v2 字段显示未识别状态，不用旧值补造", async () => {
    const tokens = structuredClone(tokensFixture);
    if (tokens.color.roles) tokens.color.roles.link = null;
    delete tokens.typography.scale.h5;
    if (tokens.buttons) tokens.buttons.outline = null;
    const { api } = createDesignApi(tokens);
    await renderDesignPage(api);

    expect(await screen.findByRole("heading", { name: "颜色角色" })).toBeTruthy();
    expect(screen.getAllByText("当前页面未识别此颜色角色。").length).toBeGreaterThan(0);
    expect(screen.getByText("未识别此层级")).toBeTruthy();
    expect(screen.getByText("未识别此按钮变体")).toBeTruthy();
    expect(screen.getAllByText("未识别", { selector: ".si-design-role-value" }).length).toBeGreaterThan(0);
  });

  it("复制按钮会把当前完整 Token JSON 交给剪贴板 API", async () => {
    const { api, copyText } = createDesignApi();
    await renderDesignPage(api);

    expect(await screen.findByRole("heading", { name: "颜色角色" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "复制 Token（JSON）" }));

    expect(copyText).toHaveBeenCalledWith(JSON.stringify(tokensFixture, null, 2));
    expect(await screen.findByText("Token JSON 已复制，可交给 agent 使用。")).toBeTruthy();
  });
});
