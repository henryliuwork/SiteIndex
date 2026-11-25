import type { Page } from "playwright-core";

export type SpacingRule = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S8" | "S9" | "S10";
export interface SpacingFinding { rule: SpacingRule; key: string; message: string; exceptionId?: string }

// Keep this probe as a string: Vite's TS transform adds a server-only helper to
// nested callbacks when a typed function is passed directly to page.evaluate.
const probe = String.raw`(() => {
  const routeName = __ROUTE__;
  const findings = [];
  const root = document.querySelector("main") || document.body;
  const rect = (element) => element.getBoundingClientRect();
  const visible = (element) => {
    if (!element || !element.isConnected) return false;
    const box = rect(element);
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const key = (element) => {
    const parts = [];
    for (let node = element; node && node !== root && node.parentElement; node = node.parentElement) {
      parts.unshift(Array.prototype.indexOf.call(node.parentElement.children, node).toString(36));
    }
    return parts.join(".");
  };
  const add = (rule, element, message, suffix = "", exceptionId) => {
    findings.push({ rule, key: rule + ":" + key(element) + suffix, message, ...(exceptionId ? { exceptionId } : {}) });
  };
  const round = (value) => Math.round(value * 10) / 10;
  const textRects = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const boxes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      boxes.push(...Array.from(range.getClientRects()).filter((box) => box.width > 0 && box.height > 0));
    }
    return boxes;
  };
  const controls = Array.from(document.querySelectorAll("main button, main input, main select, main [role='button']"))
    .filter((element) => visible(element) && !element.closest(".si-table tbody")
      && !element.closest("[role='tablist']")
      && !element.matches("input[type='checkbox'], input[type='radio'], input[type='hidden'], input[type='file'], input[type='range']"));
  for (const element of controls) {
    const box = rect(element);
    const style = getComputedStyle(element);
    const compact = box.height <= 28.5;
    const headerHelp = element.matches(".si-table-heading .si-info-tooltip-trigger")
      && Math.abs(box.width - 18) <= 1 && Math.abs(box.height - 18) <= 1;
    const headerSort = element.matches(".si-table-heading .si-sort-button")
      && Math.abs(box.height - 28) <= 1;
    if (Math.abs(box.height - 28) > 1 && Math.abs(box.height - 32) > 1) {
      add("S1", element, "控件高度 " + round(box.height) + "px，应为 28 或 32px。", "", headerHelp ? "table-heading-help-18px" : undefined);
    }
    const minimum = compact ? 8 : 12;
    if (parseFloat(style.paddingLeft) < minimum - 1 || parseFloat(style.paddingRight) < minimum - 1) {
      const noPadding = parseFloat(style.paddingLeft) === 0 && parseFloat(style.paddingRight) === 0;
      add("S2", element, "左右内边距 " + round(parseFloat(style.paddingLeft)) + "/" + round(parseFloat(style.paddingRight)) + "px，应至少 " + minimum + "px。", "", noPadding && (headerHelp || headerSort) ? "table-heading-controls-zero-padding" : undefined);
    }
  }
  for (const element of document.querySelectorAll("main .si-chip, main .si-summary-line-item, main .si-summary-line-more")) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    if (parseFloat(style.paddingLeft) < 11 || parseFloat(style.paddingRight) < 11
      || parseFloat(style.paddingTop) < 3 || parseFloat(style.paddingBottom) < 3) {
      add("S2", element, "摘要项/Chip 内边距应至少为 12×4px。");
    }
  }
  const byParent = new Map();
  for (const element of controls) {
    if (!element.parentElement) continue;
    const siblings = byParent.get(element.parentElement) || [];
    siblings.push(element);
    byParent.set(element.parentElement, siblings);
  }
  for (const [parent, siblings] of byParent) {
    if (parent.closest(".si-segmented, [role='group'], .si-button-group, [role='tablist']")) continue;
    const sorted = siblings.sort((left, right) => rect(left).left - rect(right).left);
    for (let index = 1; index < sorted.length; index += 1) {
      const left = rect(sorted[index - 1]);
      const right = rect(sorted[index]);
      const overlap = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      if (overlap < Math.min(left.height, right.height) / 2) continue;
      const gap = right.left - left.right;
      const minimum = parent.closest(".si-project-header-actions") ? 12 : 8;
      if (gap >= -0.5 && gap < minimum - 1) {
        const tableHeaderHelp = parent.matches(".si-table-heading")
          && sorted[index - 1].matches(".si-sort-button")
          && sorted[index].matches(".si-info-tooltip-trigger")
          && Math.abs(gap - 4) <= 1;
        add("S3", sorted[index], "相邻控件间距 " + round(gap) + "px，应至少 " + minimum + "px。", "~" + key(sorted[index - 1]), tableHeaderHelp ? "table-header-help-4px" : undefined);
      }
    }
  }
  for (const element of document.querySelectorAll("main .si-button, main .si-filter-pill, main .si-chip, main .si-notice, main .si-summary-line-item, main .si-summary-line-more")) {
    if (!visible(element)) continue;
    const box = rect(element);
    const boxes = textRects(element);
    if (!boxes.length) continue;
    const inset = {
      left: Math.min(...boxes.map((item) => item.left)) - box.left,
      right: box.right - Math.max(...boxes.map((item) => item.right)),
      top: Math.min(...boxes.map((item) => item.top)) - box.top,
      bottom: box.bottom - Math.max(...boxes.map((item) => item.bottom)),
    };
    const horizontal = element.matches(".si-button, .si-chip, .si-summary-line-item, .si-summary-line-more") ? 12 : 8;
    if (inset.left < horizontal - 1 || inset.right < horizontal - 1 || inset.top < 3 || inset.bottom < 3) {
      add("S4", element, "文字到边缘 L/R/T/B=" + [inset.left, inset.right, inset.top, inset.bottom].map(round).join("/") + "px。");
    }
  }
  for (const section of document.querySelectorAll("main .si-table-section")) {
    const regions = [".si-table-section-summary", ".si-table-section-selected-filters", ".si-table-toolbar", ".si-data-table"]
      .map((selector) => section.querySelector(selector)).filter(visible).sort((left, right) => rect(left).top - rect(right).top);
    for (let index = 1; index < regions.length; index += 1) {
      const gap = rect(regions[index]).top - rect(regions[index - 1]).bottom;
      if (gap >= -0.5 && gap < 11) add("S5", regions[index], "区域间距 " + round(gap) + "px，应至少 12px。", "~" + key(regions[index - 1]));
    }
  }
  const blocks = Array.from(document.querySelectorAll("main .si-card, main .si-kpi-card, main .si-notice"))
    .filter(visible);
  for (const block of blocks) {
    const siblings = blocks.filter((other) => other !== block && other.parentElement === block.parentElement);
    for (const other of siblings) {
      if (key(block) >= key(other)) continue;
      const a = rect(block), b = rect(other);
      const horizontalOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const gap = horizontalOverlap > 0 ? Math.max(a.top - b.bottom, b.top - a.bottom)
        : verticalOverlap > 0 ? Math.max(a.left - b.right, b.left - a.right) : Infinity;
      if (gap >= -0.5 && gap < 0.5) add("S6", other, "相邻带边框/背景块相贴。", "~" + key(block));
    }
  }
  const activeTab = document.querySelector(".si-project-header-single .si-tabs [role='tab'][aria-selected='true']");
  if (activeTab && visible(activeTab)) {
    const tab = rect(activeTab), header = rect(activeTab.closest(".si-project-header-single"));
    const text = textRects(activeTab);
    const indicator = getComputedStyle(activeTab, "::after");
    const indicatorWidth = parseFloat(indicator.width);
    const indicatorHeight = parseFloat(indicator.height);
    const textWidth = text.length ? Math.max(...text.map((item) => item.right)) - Math.min(...text.map((item) => item.left)) : 0;
    const textBottom = text.length ? Math.max(...text.map((item) => item.bottom)) : tab.bottom;
    if (!Number.isFinite(indicatorWidth) || !Number.isFinite(indicatorHeight)
      || Math.abs(indicatorWidth - textWidth - 24) > 2 || Math.abs(indicatorHeight - 2) > 0.5
      || Math.abs(header.bottom - tab.bottom) > 1.5 || tab.bottom - indicatorHeight - textBottom < 11) {
      add("S8", activeTab, "Tab 指示线 " + round(indicatorWidth) + "×" + round(indicatorHeight)
        + "px，文字宽 " + round(textWidth) + "px，距底 " + round(tab.bottom - indicatorHeight - textBottom) + "px。");
    }
  }
  const expectedActions = {
    overview: ["立即同步", "打开项目文件夹"], products: ["立即同步", "趋势与分类在线率", "导出 CSV"],
    seo: ["规则设置", "重新检查收录", "导出"], content: ["重新抓取博客", "博客识别设置"],
    edm: ["生成命令", "导出"], design: ["重新抓取设计规范", "复制 Token"],
    readme: ["刷新 README", "编辑"], runs: ["立即运行"],
    "project-settings-config": ["保存"], "project-settings-categories": ["保存"], "project-settings-files": ["保存"],
  };
  const actionSlot = document.querySelector(".si-project-header-actions");
  if (actionSlot) {
    const actions = Array.from(actionSlot.querySelectorAll("button, a[href]")).filter(visible);
    for (const label of expectedActions[routeName] || []) {
      if (!actions.some((button) => (button.getAttribute("aria-label") || button.textContent || "").trim().includes(label))) {
        add("S9", actionSlot, "页头一级操作缺少：" + label, ":" + label);
      }
    }
  } else if (expectedActions[routeName]) {
    add("S9", root, "页头操作区未渲染。", ":missing");
  }
  for (const element of document.querySelectorAll("main h1, main h2, main th, main td, main .si-chip, main .si-button")) {
    if (!visible(element) || element.scrollWidth <= element.clientWidth + 2 || !element.textContent.trim()) continue;
    const style = getComputedStyle(element);
    if (style.overflowX === "visible" || element.title || element.getAttribute("aria-label")
      || element.querySelector("[title], [role='tooltip']")) continue;
    add("S10", element, "文字被截断但没有 title 或 InfoTooltip。");
  }
  return findings;
})()`;

export async function inspectSpacing(page: Page, routeName: string): Promise<SpacingFinding[]> {
  return page.evaluate<SpacingFinding[]>(probe.replace("__ROUTE__", JSON.stringify(routeName)));
}
