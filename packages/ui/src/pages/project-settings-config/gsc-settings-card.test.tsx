// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GscSyncResult, SiteIndexApi } from "@siteindex/shared";
import { ToastProvider } from "../../components/overlays";
import { createGscMock } from "../../mock/gsc";
import { GscSettingsCard } from "./gsc-settings-card";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCard(gsc: SiteIndexApi["gsc"], isDemo = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider><GscSettingsCard projectId="demo" gsc={gsc} isDemo={isDemo} /></ToastProvider>
    </QueryClientProvider>,
  );
}

async function connectChoosePropertyAndMode() {
  await screen.findByText("尚未配置");
  fireEvent.click(screen.getByRole("button", { name: "模拟连接" }));
  await screen.findByText("已连接");

  const propertySelect = await screen.findByRole("combobox", { name: "Search Console 属性" });
  expect(screen.getByRole("button", { name: "运行演示同步" })).toHaveProperty("disabled", true);
  fireEvent.click(propertySelect);
  fireEvent.click(await screen.findByRole("option", { name: "sc-domain:demo.example.test · 所有者" }));

  fireEvent.click(await screen.findByRole("combobox", { name: "GSC 同步方式" }));
  fireEvent.click(await screen.findByRole("option", { name: "首次导入：最近 90 天可用数据" }));
}

describe("GSC 项目设置", () => {
  it("旧 Desktop bridge 没有 GSC 命名空间时显示边界提示且不暴露操作", () => {
    renderCard(undefined);

    expect(screen.getByRole("status").textContent).toContain("当前 Desktop bridge 尚未接入 Search Console");
    expect(screen.queryByRole("button", { name: "连接 Search Console" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开始只读同步" })).toBeNull();
    expect(screen.getByText(/不会显示授权令牌或账号邮箱/)).toBeTruthy();
  });

  it("演示模式要求明确选择属性后才同步，并标明结果是合成数据", async () => {
    const gsc = createGscMock();
    const sync = vi.spyOn(gsc, "sync");
    renderCard(gsc, true);

    expect(screen.getByText(/不会连接 Google/)).toBeTruthy();
    await connectChoosePropertyAndMode();
    fireEvent.click(screen.getByRole("button", { name: "运行演示同步" }));

    expect(await screen.findByRole("status", { name: "本次同步结果" })).toBeTruthy();
    expect(screen.getByText("部分完成")).toBeTruthy();
    expect(screen.getByText(/收到 18 条，写入 18 条/)).toBeTruthy();
    expect(sync).toHaveBeenCalledWith("demo", { mode: "initial_90_days" });
    expect(screen.getByText(/当前契约没有读取已保存同步历史状态的方法/)).toBeTruthy();
  });

  it("明确展示 Core 返回的失败状态、错误和历史保留结果", async () => {
    const gsc = createGscMock();
    const failed: GscSyncResult = {
      state: "failed",
      mode: "initial_90_days",
      history_effect: "preserved",
      records_received: 0,
      records_written: 0,
      error: { code: "demo_network_error", message: "虚构演示错误：无法读取属性数据。" },
      metadata: {
        data_source: "google_search_console",
        property_site_url: "sc-domain:demo.example.test",
        requested_at: "2026-11-13T08:00:00.000Z",
        collected_at: null,
        data_through: null,
        requested_range: null,
        missing_ranges: [],
        missing_fields: ["daily_metrics"],
        quality: "unreliable",
        anomalies: [],
      },
    };
    vi.spyOn(gsc, "sync").mockResolvedValue(failed);
    renderCard(gsc, true);

    await connectChoosePropertyAndMode();
    fireEvent.click(screen.getByRole("button", { name: "运行演示同步" }));

    expect(await screen.findByText("同步错误：demo_network_error")).toBeTruthy();
    expect(screen.getByText("虚构演示错误：无法读取属性数据。")).toBeTruthy();
    expect(screen.getByText("本次失败，已有历史数据保持不变。")).toBeTruthy();
  });
});
