import {
  PATHS,
  dailyReportFile,
  type DailySummaryRow,
  type DesignTokens,
  type InventoryEvent,
  type RunLog,
  type SiteConfig,
} from "@siteindex/shared";

export const README_AUTO_BLOCK_TITLES = {
  "index-summary": "数据概况",
  "task-routing": "任务路由",
  "data-guide": "数据指南",
  "design-summary": "设计摘要",
  changelog: "最近变更",
} as const;

export type ReadmeAutoBlockId = keyof typeof README_AUTO_BLOCK_TITLES;
export type ReadmeAutoContent = Record<ReadmeAutoBlockId, string>;

interface AutoBlockRange {
  id: string;
  bodyStart: number;
  bodyEnd: number;
}

export interface ReadmeAutoContentInput {
  site: Pick<SiteConfig, "domain" | "platform">;
  asOf: string;
  activeSkus: number;
  activeProducts: number;
  categories: number;
  blogPosts: number;
  dailySummary: readonly DailySummaryRow[];
  events: readonly InventoryEvent[];
  designTokens: DesignTokens | null;
  runs: readonly RunLog[];
}

function markerError(): Error & { code: "CONFIG_INVALID" } {
  return Object.assign(new Error("README 自动区块标记未成对或存在嵌套。"), { code: "CONFIG_INVALID" as const });
}

function locateAutoBlocks(markdown: string): AutoBlockRange[] {
  const markerPattern = /<!-- siteindex:auto:(start|end) id="([^"]+)" -->/g;
  const markerCount = [...markdown.matchAll(/<!--\s*siteindex:auto:/g)].length
    - [...markdown.matchAll(/<!--\s*siteindex:auto:[^>]*id=(?:"folder-map"|folder-map)[^>]*-->/g)].length;
  const blocks: AutoBlockRange[] = [];
  let open: { id: string; bodyStart: number } | null = null;
  let parsedMarkers = 0;
  for (const marker of markdown.matchAll(markerPattern)) {
    const kind = marker[1];
    const id = marker[2]!;
    if (id === "folder-map") continue;
    parsedMarkers += 1;
    const start = marker.index!;
    if (kind === "start") {
      if (open) throw markerError();
      open = { id, bodyStart: start + marker[0].length };
    } else {
      if (!open || open.id !== id) throw markerError();
      blocks.push({ id, bodyStart: open.bodyStart, bodyEnd: start });
      open = null;
    }
  }
  if (open || parsedMarkers !== markerCount) throw markerError();
  return blocks;
}

/** 解析所有自动区块，保留重复区块的出现顺序供修复时一起替换。 */
export function parseReadmeAutoBlocks(markdown: string): { id: string; content: string }[] {
  return locateAutoBlocks(markdown).map(({ id, bodyStart, bodyEnd }) => ({
    id,
    content: markdown.slice(bodyStart, bodyEnd).replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
  }));
}

/** 只改自动区块标记之间的内容；缺少且未禁用的区块追加到文件末尾。 */
export function replaceReadmeAutoBlocks(
  markdown: string,
  contents: ReadmeAutoContent,
  disabledBlocks: ReadonlySet<string> = new Set(),
): string {
  const blocks = locateAutoBlocks(markdown);
  const existing = new Set(blocks.map((block) => block.id));
  let output = markdown;
  for (const block of [...blocks].reverse()) {
    if (!Object.hasOwn(contents, block.id)) continue;
    const content = contents[block.id as ReadmeAutoBlockId]!.trim();
    output = `${output.slice(0, block.bodyStart)}\n${content}\n${output.slice(block.bodyEnd)}`;
  }

  const appended = (Object.entries(contents) as [ReadmeAutoBlockId, string][])
    .filter(([id]) => !existing.has(id) && !disabledBlocks.has(id))
    .map(([id, content]) => `<!-- siteindex:auto:start id="${id}" -->\n${content.trim()}\n<!-- siteindex:auto:end id="${id}" -->`);
  if (!appended.length) return output;
  const separator = output.length === 0 ? "" : output.endsWith("\n\n") ? "" : output.endsWith("\n") ? "\n" : "\n\n";
  return `${output}${separator}${appended.join("\n\n")}\n`;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function stockRate(row: DailySummaryRow | undefined): number | null {
  return !row || row.total <= 0 ? null : (row.in_stock / row.total) * 100;
}

function summaryForDate(rows: readonly DailySummaryRow[], date: string): DailySummaryRow | undefined {
  const dayRows = rows.filter((row) => row.date === date);
  const all = dayRows.find((row) => row.category === "_all");
  if (all) return all;
  if (!dayRows.length) return undefined;
  return dayRows.reduce<DailySummaryRow>((total, row) => ({
    date,
    category: "_all",
    total: total.total + row.total,
    in_stock: total.in_stock + row.in_stock,
    out_of_stock: total.out_of_stock + row.out_of_stock,
    preorder: total.preorder + row.preorder,
    unknown: total.unknown + row.unknown,
  }), { date, category: "_all", total: 0, in_stock: 0, out_of_stock: 0, preorder: 0, unknown: 0 });
}

function dateOffset(date: string, offset: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + offset);
  return result.toISOString().slice(0, 10);
}

function eventCounts(events: readonly InventoryEvent[], date: string) {
  const today = events.filter((event) => event.date === date);
  return {
    restocked: today.filter((event) => event.type === "stock_change" && event.to === "in_stock" && event.from !== "in_stock").length,
    outOfStock: today.filter((event) => event.type === "stock_change" && event.to === "out_of_stock" && event.from !== "out_of_stock").length,
    priceDrops: today.filter((event) => event.type === "price_change" && Number(event.to) < Number(event.from)).length,
    newSkus: today.filter((event) => event.type === "new_sku").length,
  };
}

function cell(value: string | number): string {
  return String(value).replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

function taskRouting(): string {
  const skill = (name: string) => `\`${PATHS.skillsDir}/${name}/SKILL.md\``;
  return [
    "## 任务路由",
    "",
    "| 任务 | Skill | 读取 | 产出 |",
    "|---|---|---|---|",
    `| 写 EDM | ${skill("edm-builder")} | \`${PATHS.productsView}\`、\`${PATHS.edmCampaigns}\` | 用户指定的目录 |`,
    `| 录入图片 / 打标签 | ${skill("sku-media-enrich")} | \`${PATHS.skus}\` | \`${PATHS.skuMedia}\`、\`${PATHS.skuTags}\` |`,
    `| 库存汇报 | ${skill("stock-report")} | \`${PATHS.dailyReportsDir}/\`、\`${PATHS.inventoryLatest}\` | 回复或用户指定的目录 |`,
    `| 写博客 | ${skill("blog-writer")} | \`${PATHS.blogIndex}\`、\`${PATHS.productsView}\` | 用户指定的目录 |`,
    `| 外链搜集 | ${skill("link-prospect")} | \`${PATHS.outreach}\` | LinkFlow + \`${PATHS.outreach}\` |`,
    `| 页面 / 视觉设计 | ${skill("page-design")} | \`${PATHS.designTokens}\` | 用户指定的目录 |`,
    `| 补充项目说明 | ${skill("project-readme")} | README 用户区块 | README 用户区块 |`,
  ].join("\n");
}

function dataGuide(): string {
  const rows = [
    [PATHS.site, "站点配置、品牌、抓取与 EDM 设置", "—", "用户 / SiteIndex"],
    [PATHS.skus, "SKU 主表（一行一个变体）", "sku", "SiteIndex"],
    [PATHS.productDetails, "产品详情、图集与相关产品", "handle", "SiteIndex"],
    [PATHS.categories, "分类树", "slug", "SiteIndex"],
    [PATHS.inventoryLatest, "当前库存与持续天数", "sku", "SiteIndex"],
    [`${PATHS.eventsDir}/YYYY-MM.jsonl`, "到货、缺货、调价、上新、下架事件", "date+sku+type", "SiteIndex"],
    [PATHS.dailySummary, "每日分类库存汇总", "date+category", "SiteIndex"],
    [PATHS.seoPages, "SEO 页面", "url", "SiteIndex"],
    [PATHS.seoIssues, "SEO 问题", "url+rule", "SiteIndex"],
    [PATHS.seoLinks, "站内链接", "from+to+anchor", "SiteIndex"],
    [PATHS.blogIndex, "博客索引与内链", "url", "SiteIndex"],
    [PATHS.keywords, "关键词 → 目标页面", "keyword", "agent / 用户"],
    [PATHS.skuMedia, "手动产品图片", "sku+image_role", "agent / 用户"],
    [PATHS.skuTags, "主题标签、优先级、EDM 排除", "sku", "agent / 用户"],
    [PATHS.edmCampaigns, "EDM 记录（推品冷却期）", "campaign_id", "agent / 用户"],
    [PATHS.outreach, "外链去重名单", "domain", "agent / 用户"],
    [PATHS.productsView, "产品级合并视图，选品首选", "handle", "SiteIndex"],
    [PATHS.skuStockView, "SKU 库存视图与 30 天历史", "sku", "SiteIndex"],
    [PATHS.designTokens, "设计规范 tokens", "—", "SiteIndex"],
    [PATHS.designBrand, "品牌视觉规范说明", "—", "SiteIndex"],
    [PATHS.designScreenshots, "首页、分类页与产品页截图", "—", "SiteIndex"],
  ];
  return [
    `## 数据指南（${PATHS.index}/）`,
    "",
    "| 路径 | 内容 | 主键 | 写入 |",
    "|---|---|---|---|",
    ...rows.map(([relativePath, description, key, writer]) =>
      `| \`${relativePath}\` | ${cell(description!)} | ${cell(key!)} | ${cell(writer!)} |`,
    ),
    "",
    `写入台账：\`siteindex ledger upsert <project> <ledger> --rows <file|->\`。命令不可用时，严格按 \`${PATHS.index}/\` 现有文件的格式与排序手写。`,
    `查询产品：\`siteindex query <project> products --in-stock --json\``,
  ].join("\n");
}

function designSummary(tokens: DesignTokens | null): string {
  if (!tokens) return "## 设计规范速览\n\n尚未提取设计规范。运行设计规范 Job 后，此处会显示品牌颜色和字体。";
  const date = tokens.extracted_at.slice(0, 10);
  const colors = [
    tokens.color.primary ? `主色 \`${tokens.color.primary}\`` : null,
    tokens.color.text ? `文字 \`${tokens.color.text}\`` : null,
    tokens.color.background ? `背景 \`${tokens.color.background}\`` : null,
    tokens.color.sale ? `促销 \`${tokens.color.sale}\`` : null,
  ].filter((value): value is string => value !== null);
  const fonts = [tokens.typography.font_families.heading, tokens.typography.font_families.body]
    .filter((value): value is string => Boolean(value));
  return [
    "## 设计规范速览",
    `_提取于 ${date}_`,
    "",
    colors.length ? `- ${colors.join(" · ")}` : "- 尚无颜色数据",
    fonts.length ? `- 字体：${fonts.map((font) => `\`${font}\``).join(" · ")}` : "- 尚无字体数据",
    `- 完整规范：\`${PATHS.designTokens}\`、\`${PATHS.designBrand}\``,
  ].join("\n");
}

function changelog(runs: readonly RunLog[]): string {
  const jobNames: Record<string, string> = {
    daily: "每日同步", weekly: "每周同步", monthly: "每月归档", validate: "数据校验",
    readme: "README 刷新", design: "设计规范提取", "index-check": "Google 收录检查",
  };
  const statuses: Record<RunLog["status"], string> = {
    ok: "成功", partial: "部分完成", failed: "失败", skipped: "跳过",
  };
  const rows = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 8);
  return [
    "## 变更记录",
    "",
    "| 日期 | 事件 |",
    "|---|---|",
    ...(rows.length
      ? rows.map((run) => `| ${run.started_at.slice(0, 10)} | ${jobNames[run.job] ?? run.job}：${statuses[run.status]} |`)
      : ["| — | 暂无同步记录 |"]),
  ].join("\n");
}

export function buildReadmeAutoContent(input: ReadmeAutoContentInput): ReadmeAutoContent {
  const current = summaryForDate(input.dailySummary, input.asOf);
  const previousDate = dateOffset(input.asOf, -7);
  const previous = summaryForDate(input.dailySummary, previousDate);
  const currentRate = stockRate(current);
  const previousRate = stockRate(previous);
  const delta = currentRate === null || previousRate === null
    ? "暂无 7 天前对比"
    : `${currentRate - previousRate < 0 ? "−" : "+"}${Math.abs(currentRate - previousRate).toFixed(1)}pt`;
  const dailyRuns = input.runs.filter((run) => run.job === "daily").sort((a, b) => b.started_at.localeCompare(a.started_at));
  const latestDaily = dailyRuns[0];
  const changes = eventCounts(input.events, input.asOf);
  const updatedAt = latestDaily?.started_at.slice(0, 16).replace("T", " ") ?? input.asOf;
  const dailyStatus: Record<RunLog["status"], string> = { ok: "成功", partial: "部分完成", failed: "失败", skipped: "跳过" };
  const dailyReport = dailyReportFile(input.asOf);
  const indexSummary = [
    "## 网站数据速览",
    `_更新于 ${updatedAt} · 每日同步：${latestDaily ? dailyStatus[latestDaily.status] : "暂无记录"}_`,
    `- 网站：${input.site.domain}（${input.site.platform}）`,
    "",
    "| 指标 | 数值 |",
    "|---|---|",
    `| 在售 SKU / 产品 | ${input.activeSkus} / ${input.activeProducts} |`,
    `| 有货率 | ${formatPercent(currentRate)}（较 7 天前 ${delta}） |`,
    `| 分类 | ${input.categories} |`,
    `| 博客文章 | ${input.blogPosts} |`,
    `| 今日变化 | 新到货 ${changes.restocked} · 新缺货 ${changes.outOfStock} · 调价 ${changes.priceDrops} · 上新 ${changes.newSkus} |`,
    "",
    `今日日报：[${dailyReport}](${dailyReport})`,
  ].join("\n");

  return {
    "index-summary": indexSummary,
    "task-routing": taskRouting(),
    "data-guide": dataGuide(),
    "design-summary": designSummary(input.designTokens),
    changelog: changelog(input.runs),
  };
}
