import type { Page } from "playwright-core";
import type { FrameMetrics } from "./frame-policy";

// Playwright evaluates this string in the page. A nested TS callback would acquire
// tsx's server-only __name helper when Vite runs visual/check.ts.
const frameProbe = String.raw`(() => {
  const frame = document.querySelector("main .si-page-frame");
  const header = frame?.querySelector(":scope > .si-page-frame-header");
  const body = frame?.querySelector(":scope > .si-page-frame-body");
  const content = document.querySelector("main.si-content");
  const kind = frame?.classList.contains("si-page-frame-project") ? "project"
    : frame?.classList.contains("si-page-frame-global") ? "global" : null;
  const rects = (selector, root = frame ?? document) =>
    Array.from(root.querySelectorAll(selector), (element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
  const gap = (rectangles) => rectangles
    .sort((a, b) => a.left - b.left)
    .slice(1)
    .map((rect, index) => ({ rect, previous: rectangles[index] }))
    .filter(({ rect, previous }) => Math.abs(rect.top - previous.top) <= 1)
    .map(({ rect, previous }) => Math.round((rect.left - previous.right) * 10) / 10);
  const actionRoot = frame?.querySelector(".si-project-header-actions");
  const actions = actionRoot ? rects(":scope > *", actionRoot) : [];
  const toolbars = frame ? Array.from(frame.querySelectorAll(".si-table-toolbar")) : [];
  const controls = toolbars.flatMap((toolbar) => rects(".si-search-input, .si-filter-pill, .si-button, .si-select-trigger", toolbar));
  const toolbarGaps = toolbars.flatMap((toolbar) => {
    const left = toolbar.querySelector(".si-table-toolbar-content");
    return left ? gap(rects(".si-search-input, .si-filter-pill, .si-button, .si-select-trigger", left)) : [];
  });
  const filterRows = frame ? Array.from(frame.querySelectorAll(".si-table-section-selected-filters")) : [];
  const selectedFilterGaps = filterRows.flatMap((row) => {
    const section = row.parentElement;
    const summary = section?.querySelector(":scope > .si-table-section-summary");
    const toolbar = section?.querySelector(".si-table-toolbar");
    return [summary ? row.getBoundingClientRect().top - summary.getBoundingClientRect().bottom : null,
      toolbar ? toolbar.getBoundingClientRect().top - row.getBoundingClientRect().bottom : null]
      .filter((value) => value !== null);
  });
  const tables = Array.from(document.querySelectorAll(".si-data-table"))
    .filter((table) => table.getBoundingClientRect().height > 0 && getComputedStyle(table).visibility !== "hidden")
    .map((table) => {
      const headers = Array.from(table.querySelectorAll("thead th"));
      return {
        id: (table.getAttribute("aria-label") ?? "").replace(/ 数据表$/, ""),
        firstHeader: headers.find((th) => !th.classList.contains("si-table-selection-cell"))?.textContent?.trim() ?? "",
        hasSkuHeader: headers.some((th) => th.textContent?.trim() === "SKU"),
      };
    });
  const headerRect = header?.getBoundingClientRect();
  const bodyFirst = body?.firstElementChild?.getBoundingClientRect();
  const projectHeaderText = frame?.querySelector(".si-project-header")?.textContent ?? "";
  const scrolls = (element) => Boolean(element && element.scrollHeight > element.clientHeight + 1);
  return {
    kind,
    headerOffset: headerRect && content ? headerRect.top - content.getBoundingClientRect().top : null,
    headerHeight: headerRect?.height ?? null,
    globalPaddingTop: header ? Number.parseFloat(getComputedStyle(header).paddingTop) : null,
    bodyStart: headerRect && bodyFirst ? bodyFirst.top - headerRect.bottom : null,
    buttonHeights: actionRoot ? rects("button, a[href]", actionRoot).map((rect) => rect.height) : [],
    buttonGaps: gap(actions),
    documentScroll: scrolls(document.scrollingElement),
    contentScroll: scrolls(content),
    bodyScroll: scrolls(body),
    toolbarControlHeights: controls.map((rect) => rect.height),
    toolbarGaps,
    selectedFilterGaps,
    tables,
    domainInProjectHeader: /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i.test(projectHeaderText),
  };
})()`;

export async function inspectFrame(page: Page): Promise<FrameMetrics> {
  return page.evaluate<FrameMetrics>(frameProbe);
}
