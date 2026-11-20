export type FrameKind = "global" | "project";

export interface FrameMetrics {
  kind: FrameKind | null;
  headerOffset: number | null;
  headerHeight: number | null;
  globalPaddingTop: number | null;
  bodyStart: number | null;
  buttonHeights: number[];
  buttonGaps: number[];
  documentScroll: boolean;
  contentScroll: boolean;
  bodyScroll: boolean;
  toolbarControlHeights: number[];
  toolbarGaps: number[];
  selectedFilterGaps: number[];
  tables: Array<{ id: string; firstHeader: string; hasSkuHeader: boolean }>;
  domainInProjectHeader: boolean;
}

export interface FrameBaseline {
  version: 1;
  legacyRoutes: Record<string, FrameKind>;
}

export interface FrameFinding { rule: string; message: string }

export function checkSkuTables(routeName: string, tables: FrameMetrics["tables"]): FrameFinding[] {
  const findings: FrameFinding[] = [];
  const requiredSkuTables = new Set(["products.merged", "products.variant-stock", "edm.images"]);
  const primaryTableId = routeName === "products" ? "products.merged" : routeName === "edm" ? "edm.images" : null;
  if (primaryTableId && tables.length && !tables.some((table) => table.id === primaryTableId)) {
    findings.push({ rule: "sku-table-missing", message: `当前页面未找到应有的 ${primaryTableId} 表格。` });
  }
  for (const table of tables) {
    if ((requiredSkuTables.has(table.id) || table.hasSkuHeader) && table.firstHeader !== "SKU") {
      findings.push({ rule: "sku-first-column", message: `${table.id} 首个数据列表头应为 SKU，实际 ${table.firstHeader || "缺失"}。` });
    }
  }
  return findings;
}

export function checkFrameMetrics(
  routeName: string,
  expectedKind: FrameKind,
  hasDataTable: boolean,
  metrics: FrameMetrics,
  baseline: FrameBaseline,
): { status: "strict" | "legacy"; findings: FrameFinding[] } {
  const findings: FrameFinding[] = [];
  const legacyKind = baseline.legacyRoutes[routeName];
  if (!metrics.kind) {
    if (legacyKind !== expectedKind) findings.push({ rule: "frame-missing", message: `未接入 PageFrame，且 ${routeName} 不在正确的旧页面基线中。` });
    return { status: "legacy", findings };
  }
  if (legacyKind) findings.push({ rule: "frame-stale-baseline", message: `${routeName} 已接入 PageFrame，须移除旧页面基线。` });
  if (metrics.kind !== expectedKind) findings.push({ rule: "frame-kind", message: `外框类型应为 ${expectedKind}，实际 ${metrics.kind}。` });
  const near = (rule: string, actual: number | null, target: number) => {
    if (actual == null || Math.abs(actual - target) > 1) findings.push({ rule, message: `预期 ${target}±1px，实际 ${actual ?? "未渲染"}。` });
  };
  if (expectedKind === "project") {
    near("project-header-top", metrics.headerOffset, 0);
    near("project-header-height", metrics.headerHeight, 48);
    if (metrics.domainInProjectHeader) findings.push({ rule: "project-header-domain", message: "项目头仍显示域名。" });
    for (const height of metrics.buttonHeights) near("project-header-button-height", height, 32);
    for (const gap of metrics.buttonGaps) near("project-header-button-gap", gap, 12);
  } else {
    near("global-title-height", metrics.headerHeight, 56);
    near("global-title-padding", metrics.globalPaddingTop, 24);
  }
  near("frame-body-start", metrics.bodyStart, 16);
  if (hasDataTable && (metrics.documentScroll || metrics.contentScroll || metrics.bodyScroll)) {
    findings.push({ rule: "frame-table-scroll", message: "表格页的 document、内容区或外框主体出现纵向滚动。" });
  }
  for (const height of metrics.toolbarControlHeights) near("toolbar-control-height", height, 32);
  for (const gap of metrics.toolbarGaps) near("toolbar-control-gap", gap, 8);
  for (const gap of metrics.selectedFilterGaps) {
    if (gap < 11) findings.push({ rule: "selected-filter-gap", message: `已选筛选标签与相邻区域至少间隔 12±1px，实际 ${gap}px。` });
  }
  findings.push(...checkSkuTables(routeName, metrics.tables));
  return { status: "strict", findings };
}
