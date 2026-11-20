import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  pathsFor,
  SEO_RULE_LABELS,
  type Category,
  type DailySummaryRow,
  type DesignTokens,
  type EdmCampaign,
  type InventoryEvent,
  type ProductView,
  type ProjectLayout,
  type ProjectPaths,
  type RunLog,
  type SeoIssue,
  type SiteConfig,
  type SitePolicyFact,
  type SiteTechProfile,
} from "@siteindex/shared";
import { compareKeys } from "./io/compare";

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

export interface WorkspaceAssetFile {
  relativePath: string;
  modifiedDate: string;
  title: string | null;
}

export interface WorkspaceAssetSection {
  dir: string;
  files: WorkspaceAssetFile[];
}

export interface ReadmeAutoContentInput {
  site: Pick<SiteConfig, "domain" | "platform"> & Partial<Pick<SiteConfig, "base_url" | "currency" | "markets" | "brand" | "seo" | "policies" | "edm">>;
  layout?: ProjectLayout;
  asOf: string;
  activeSkus: number;
  activeProducts: number;
  categories: number;
  blogPosts: number;
  dailySummary: readonly DailySummaryRow[];
  events: readonly InventoryEvent[];
  designTokens: DesignTokens | null;
  runs: readonly RunLog[];
  categoryRows?: readonly Category[];
  productRows?: readonly ProductView[];
  techProfile?: SiteTechProfile | null;
  seoIssues?: readonly SeoIssue[];
  edmCampaigns?: readonly EdmCampaign[];
  workspaceAssets?: readonly WorkspaceAssetSection[];
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
export function replaceAutoBlocks(
  markdown: string,
  contents: Readonly<Record<string, string>>,
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

  const appended = Object.entries(contents)
    .filter(([id]) => !existing.has(id) && !disabledBlocks.has(id))
    .map(([id, content]) => `<!-- siteindex:auto:start id="${id}" -->\n${content.trim()}\n<!-- siteindex:auto:end id="${id}" -->`);
  if (!appended.length) return output;
  const separator = output.length === 0 ? "" : output.endsWith("\n\n") ? "" : output.endsWith("\n") ? "\n" : "\n\n";
  return `${output}${separator}${appended.join("\n\n")}\n`;
}

export function replaceReadmeAutoBlocks(
  markdown: string,
  contents: ReadmeAutoContent,
  disabledBlocks: ReadonlySet<string> = new Set(),
): string {
  return replaceAutoBlocks(markdown, contents, disabledBlocks);
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

function taskRouting(paths: ProjectPaths, layout: ProjectLayout = "legacy"): string {
  const skill = (name: string) => `\`${paths.skillsDir}/${name}/SKILL.md\``;
  const rows = [
    ["全局认知（5分钟必读）", skill("siteindex-data"), `\`README.md\`、\`${paths.contextBrief}\``, "进入项目先读此简报，掌握全站分类、政策、现有工作区文档与待办"],
    ["写 EDM（策划/制作/发送）", `${skill("siteindex-edm-plan")} · ${skill("siteindex-edm-build")} · ${skill("siteindex-edm-mc-send")}（旧：${skill("edm-builder")}）`, `\`${paths.productsView}\`、\`${paths.edmCampaigns}\`、\`${paths.designBrand}\``, layout === "workspace" ? "`04-edm/emails/` + campaign 台账" : "用户指定的目录"],
    ["录入图片 / 打标签", skill("sku-media-enrich"), `\`${paths.skus}\`、\`${paths.productDetails}\``, `\`${paths.skuMedia}\`、\`${paths.skuTags}\``],
    ["库存汇报", skill("stock-report"), `\`${paths.dailyReportsDir}/\`、\`${paths.inventoryLatest}\``, layout === "workspace" ? "`02-products/stock/` 或 `_outputs/`" : "回复或用户指定的目录"],
    ["写博客 / SEO 优化", skill("blog-writer"), `\`${paths.blogIndex}\`、\`${paths.productsView}\`、\`${paths.seoPages}\``, layout === "workspace" ? "`03-seo/blog/` 或 `_outputs/` + 关键词台账" : "用户指定的目录"],
    ["外链搜集", skill("link-prospect"), `\`${paths.outreach}\``, `LinkFlow + \`${paths.outreach}\``],
    ["页面 / 视觉设计", skill("page-design"), `\`${paths.designTokens}\`、\`${paths.designBrand}\``, layout === "workspace" ? "`06-site-updates/` 或 `_outputs/`" : "用户指定的目录"],
    ["补充项目说明", skill("project-readme"), "README 用户区块", "README 用户区块"],
  ];
  return [
    "## 任务路由",
    "",
    "| 任务 | Skill | 读取 | 产出 |",
    "|---|---|---|---|",
    ...rows.map(([task, sk, rd, out]) => `| ${task} | ${sk} | ${rd} | ${out} |`),
  ].join("\n");
}

function dataGuide(paths: ProjectPaths): string {
  const rows = [
    [paths.contextBrief, "5 分钟全局认知简报（品牌/分类价格带/政策/工作区资产/Top待办）", "—", "SiteIndex"],
    [paths.site, "站点配置、品牌、抓取与 EDM 设置", "—", "用户 / SiteIndex"],
    [paths.tech, "全站政策（免邮/退换/保修）、关键页面 URL、客服与社媒", "—", "SiteIndex"],
    [paths.skus, "SKU 主表（含变体属性、custom_labels、Feed 卖点）", "sku", "SiteIndex"],
    [paths.productDetails, "产品详情、真实短描述、核心卖点、规格表与 FAQ", "handle", "SiteIndex"],
    [paths.categories, "分类树、价格区间、导语摘要与代表产品", "slug", "SiteIndex"],
    [paths.inventoryLatest, "当前库存与持续天数", "sku", "SiteIndex"],
    [`${paths.eventsDir}/YYYY-MM.jsonl`, "到货、缺货、调价、上新、下架事件", "date+sku+type", "SiteIndex"],
    [paths.dailySummary, "每日分类库存汇总", "date+category", "SiteIndex"],
    [paths.seoPages, "SEO 页面", "url", "SiteIndex"],
    [paths.seoIssues, "SEO 问题", "url+rule", "SiteIndex"],
    [paths.seoLinks, "站内链接", "from+to+anchor", "SiteIndex"],
    [paths.blogIndex, "博客索引、正文首段摘要、FAQ 问题列表与内链", "url", "SiteIndex"],
    [paths.keywords, "关键词 → 目标页面", "keyword", "agent / 用户"],
    [paths.skuMedia, "手动产品图片", "sku+image_role", "agent / 用户"],
    [paths.skuTags, "主题标签、优先级、EDM 排除与短文案", "sku", "agent / 用户"],
    [paths.edmCampaigns, "EDM 记录（推品冷却期）", "campaign_id", "agent / 用户"],
    [paths.outreach, "外链去重名单", "domain", "agent / 用户"],
    [paths.productsView, "产品级合并视图（含卖点/规格/属性汇总），选品写稿一表直读", "handle", "SiteIndex"],
    [paths.skuStockView, "SKU 库存视图与 30 天历史", "sku", "SiteIndex"],
    [paths.designTokens, "设计规范 tokens", "—", "SiteIndex"],
    [paths.designBrand, "品牌视觉与 EDM 邮件安全内联样式规范手册", "—", "SiteIndex"],
    [paths.designScreenshots, "首页、分类页与产品页截图", "—", "SiteIndex"],
  ];
  return [
    `## 数据指南（${paths.index}/）`,
    "",
    "| 路径 | 内容 | 主键 | 写入 |",
    "|---|---|---|---|",
    ...rows.map(([relativePath, description, key, writer]) =>
      `| \`${relativePath}\` | ${cell(description!)} | ${cell(key!)} | ${cell(writer!)} |`,
    ),
    "",
    `写入台账：\`siteindex ledger upsert <project> <ledger> --rows <file|->\`。命令不可用时，严格按 \`${paths.index}/\` 现有文件的格式与排序手写。`,
    `查询产品：\`siteindex query <project> products --in-stock --json\``,
  ].join("\n");
}

function designSummary(tokens: DesignTokens | null, paths: ProjectPaths): string {
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
    `- 完整规范：\`${paths.designTokens}\`、\`${paths.designBrand}\``,
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

function formatPolicyFact(fact: SitePolicyFact | null | undefined, configuredFallback?: string | null): string | null {
  if (fact?.value) {
    const tag = fact.source === "config" ? "[配置]" : fact.source_url ? `[提取自 ${fact.source_url}]` : "[自动提取]";
    return `${fact.value} _${tag}_`;
  }
  if (typeof configuredFallback === "string" && configuredFallback.trim()) {
    return `${configuredFallback.trim()} _[配置]_`;
  }
  return null;
}

function formatPriceRange(min: number | null | undefined, max: number | null | undefined, currency = ""): string {
  const prefix = currency ? `${currency} ` : "";
  if (typeof min === "number" && typeof max === "number") {
    return min === max ? `${prefix}${min.toFixed(2)}` : `${prefix}${min.toFixed(2)}–${max.toFixed(2)}`;
  }
  if (typeof min === "number") return `${prefix}${min.toFixed(2)}`;
  if (typeof max === "number") return `${prefix}${max.toFixed(2)}`;
  return "—";
}

export function buildReadmeAutoContent(input: ReadmeAutoContentInput): ReadmeAutoContent {
  const layout = input.layout ?? "legacy";
  const paths = pathsFor(layout);
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
  const dailyReport = `${paths.dailyReportsDir}/${input.asOf}.md`;

  const brand = input.site.brand;
  const brandBullets: string[] = [];
  if (brand?.tagline) brandBullets.push(`- 品牌定位：${brand.tagline}`);
  if (brand?.audience) brandBullets.push(`- 目标人群：${brand.audience}`);
  if (brand?.voice) brandBullets.push(`- 文案调性：${brand.voice}`);
  if (brand?.usp?.length) brandBullets.push(`- 核心卖点（USP）：${brand.usp.join(" · ")}`);
  if (input.site.seo?.core_keywords?.length) {
    brandBullets.push(`- 核心 SEO 关键词：${input.site.seo.core_keywords.slice(0, 10).join("、")}`);
  }

  const topCategories = [...(input.categoryRows ?? [])]
    .sort((a, b) => (b.product_count ?? b.sku_count ?? 0) - (a.product_count ?? a.sku_count ?? 0) || compareKeys(a.slug, b.slug))
    .slice(0, 8);
  const categoryBlock = topCategories.length
    ? [
      "",
      "### 主力分类与价格带",
      "| 分类 | 在售产品 | 有货/总 SKU | 价格带 | 代表商品 |",
      "|---|---:|---:|---|---|",
      ...topCategories.map((cat) => {
        const skuText = `${cat.in_stock_count ?? "—"}/${cat.sku_count ?? "—"}`;
        const range = formatPriceRange(cat.price_min, cat.price_max, input.site.currency);
        const handles = cat.top_handles?.slice(0, 3).map((h) => `\`${h}\``).join("、") || "—";
        return `| ${cell(cat.name)} (\`${cat.slug}\`) | ${cat.product_count ?? "—"} | ${skuText} | ${range} | ${handles} |`;
      }),
    ]
    : [];

  const tech = input.techProfile;
  const policies = input.site.policies;
  const policyLines = [
    formatPolicyFact(tech?.policies.free_shipping_threshold, policies?.free_shipping_threshold)
      ? `- 免邮/运费：${formatPolicyFact(tech?.policies.free_shipping_threshold, policies?.free_shipping_threshold)}`
      : null,
    formatPolicyFact(tech?.policies.return_summary, policies?.return_summary)
      ? `- 退换货政策：${formatPolicyFact(tech?.policies.return_summary, policies?.return_summary)}`
      : null,
    formatPolicyFact(tech?.policies.warranty_summary, policies?.warranty_summary)
      ? `- 保修承诺：${formatPolicyFact(tech?.policies.warranty_summary, policies?.warranty_summary)}`
      : null,
  ].filter((line): line is string => Boolean(line));

  const openHighIssues = (input.seoIssues ?? []).filter((issue) => issue.status === "open" && issue.severity === "high");
  const openMidIssues = (input.seoIssues ?? []).filter((issue) => issue.status === "open" && issue.severity === "mid");
  const pendingOutputs = input.workspaceAssets?.find((sec) => sec.dir === "_outputs")?.files ?? [];
  const quickActionLines: string[] = [];
  if (openHighIssues.length || openMidIssues.length) {
    quickActionLines.push(`- 待修复 SEO 问题：高优 **${openHighIssues.length}** 项 · 中优 **${openMidIssues.length}** 项`);
  }
  if (pendingOutputs.length) {
    quickActionLines.push(`- \`_outputs/\` 待审产物：**${pendingOutputs.length}** 个文件（详见全局认知简报）`);
  }

  const indexSummary = [
    "## 网站数据速览",
    `_更新于 ${updatedAt} · 每日同步：${latestDaily ? dailyStatus[latestDaily.status] : "暂无记录"}_`,
    `- 网站：${input.site.domain}（${input.site.platform}）`,
    ...brandBullets,
    "",
    "| 指标 | 数值 |",
    "|---|---|",
    `| 在售 SKU / 产品 | ${input.activeSkus} / ${input.activeProducts} |`,
    `| 有货率 | ${formatPercent(currentRate)}（较 7 天前 ${delta}） |`,
    `| 分类 | ${input.categories} |`,
    `| 博客文章 | ${input.blogPosts} |`,
    `| 今日变化 | 新到货 ${changes.restocked} · 新缺货 ${changes.outOfStock} · 调价 ${changes.priceDrops} · 上新 ${changes.newSkus} |`,
    ...categoryBlock,
    ...(policyLines.length ? ["", "### 全站政策与信任背书", ...policyLines] : []),
    ...(quickActionLines.length ? ["", "### 当前待办提醒", ...quickActionLines] : []),
    "",
    `今日日报：[${dailyReport}](${dailyReport}) · 5分钟全局认知简报：[${paths.contextBrief}](${paths.contextBrief})`,
  ].join("\n");

  return {
    "index-summary": indexSummary,
    "task-routing": taskRouting(paths, layout),
    "data-guide": dataGuide(paths),
    "design-summary": designSummary(input.designTokens, paths),
    changelog: changelog(input.runs),
  };
}

const DEFAULT_SCAN_SECTIONS = [
  "_outputs",
  "01-brand",
  "02-products",
  "03-seo",
  "04-edm",
  "05-affiliate",
  "06-site-updates",
  "07-reports",
] as const;

const IGNORED_SCAN_FILES = new Set([".gitkeep", ".ds_store", "thumbs.db", "desktop.ini"]);

const MAX_HEADING_READ_BYTES = 512 * 1024;

async function extractMarkdownHeading(filePath: string, fileSize: number): Promise<string | null> {
  if (!/\.md$/i.test(filePath) || fileSize > MAX_HEADING_READ_BYTES) return null;
  try {
    const content = await readFile(filePath, "utf8");
    const firstHeading = content
      .split(/\r?\n/, 20)
      .map((line) => line.trim())
      .find((line) => /^#\s+\S/.test(line));
    return firstHeading ? firstHeading.replace(/^#+\s+/, "").trim().slice(0, 100) : null;
  } catch {
    return null;
  }
}

/** 只读扫描工作区板块目录与 _outputs 下的现有文件，不跟随符号链接，绝不修改、校验或删除用户文件。 */
export async function scanWorkspaceAssets(
  projectPath: string,
  configuredSections?: readonly string[],
): Promise<WorkspaceAssetSection[]> {
  const dirs = ["_outputs", ...(configuredSections?.length ? configuredSections : DEFAULT_SCAN_SECTIONS.slice(1))];
  const uniqueDirs = [...new Set(dirs)];
  const sections: WorkspaceAssetSection[] = [];

  const walkDir = async (absDir: string, relDir: string, depth: number, results: WorkspaceAssetFile[]): Promise<void> => {
    if (depth > 2) return;
    try {
      const dirStat = await lstat(absDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;
    } catch {
      return;
    }
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = [...entries].sort((a, b) => compareKeys(a.name, b.name));
    for (const entry of sorted) {
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || IGNORED_SCAN_FILES.has(entry.name.toLowerCase())) continue;
      const absPath = path.join(absDir, entry.name);
      const relPath = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walkDir(absPath, relPath, depth + 1, results);
      } else if (entry.isFile()) {
        if (depth === 0 && entry.name.toLowerCase() === "readme.md") continue;
        try {
          const info = await lstat(absPath);
          if (info.isSymbolicLink() || !info.isFile()) continue;
          const modifiedDate = info.mtime.toISOString().slice(0, 10);
          const title = await extractMarkdownHeading(absPath, info.size);
          results.push({ relativePath: relPath, modifiedDate, title });
        } catch {
          // 跳过不可读文件
        }
      }
    }
  };

  for (const dir of uniqueDirs) {
    const files: WorkspaceAssetFile[] = [];
    await walkDir(path.join(projectPath, dir), dir, 0, files);
    sections.push({ dir, files: files.slice(0, 30) });
  }
  return sections;
}

/** 生成面向任意 AI Agent 的 5 分钟全局认知简报（context-brief.md）。 */
export function buildContextBriefMarkdown(input: ReadmeAutoContentInput): string {
  const layout = input.layout ?? "legacy";
  const paths = pathsFor(layout);
  const brandName = input.site.brand?.name || input.site.domain;
  const current = summaryForDate(input.dailySummary, input.asOf);
  const currentRate = stockRate(current);
  const currency = input.site.currency ?? "";

  const lines: string[] = [
    "<!-- siteindex:generated:context-brief:v1 -->",
    `# ${brandName} · AI Agent 5分钟全局认知简报`,
    "",
    `> 数据基准日期：${input.asOf} · 布局：\`${layout}\` · 数据根目录：\`${paths.index}/\``,
    "> 本文件由 SiteIndex 自动汇总，旨在帮助任何接入项目的 AI Agent 在 5 分钟内完整掌握品牌定位、全站政策、分类与主推商品、工作区已沉淀资产及当前高优待办。",
    "",
    "## 1. 站点与品牌核心档案",
    `- 域名与平台：\`${input.site.domain}\`（${input.site.platform}）${input.site.base_url ? ` · ${input.site.base_url}` : ""}`,
    `- 币种与目标市场：${currency || "—"} · ${(input.site.markets ?? []).join(", ") || "—"}`,
    `- 品牌标语（Tagline）：${input.site.brand?.tagline || "—"}`,
    `- 目标受众（Audience）：${input.site.brand?.audience || "—"}`,
    `- 文案调性（Voice）：${input.site.brand?.voice || "—"}`,
    `- 核心卖点（USP）：${input.site.brand?.usp?.length ? input.site.brand.usp.join(" · ") : "—"}`,
    `- 核心 SEO 关键词：${input.site.seo?.core_keywords?.length ? input.site.seo.core_keywords.join("、") : "—"}`,
    `- 关注竞品：${input.site.seo?.competitors?.length ? input.site.seo.competitors.join("、") : "—"}`,
    `- 在售规模：${input.activeProducts} 个产品 / ${input.activeSkus} 个 SKU（当前有货率 ${formatPercent(currentRate)}） · ${input.categories} 个分类 · ${input.blogPosts} 篇博客`,
  ];

  const tech = input.techProfile;
  const policies = input.site.policies;
  const freeShip = formatPolicyFact(tech?.policies.free_shipping_threshold, policies?.free_shipping_threshold);
  const shipSummary = formatPolicyFact(tech?.policies.shipping_summary, policies?.shipping_summary);
  const returnSummary = formatPolicyFact(tech?.policies.return_summary, policies?.return_summary);
  const warrantySummary = formatPolicyFact(tech?.policies.warranty_summary, policies?.warranty_summary);
  const emailFact = formatPolicyFact(tech?.contact.email, policies?.support_email);
  const phoneFact = formatPolicyFact(tech?.contact.phone, policies?.support_phone);
  const keyPages = { ...(tech?.key_pages ?? {}), ...(policies?.key_pages ?? {}) };
  const socialLinks = { ...(tech?.social_links ?? {}), ...(policies?.social_links ?? {}) };

  lines.push(
    "",
    "## 2. 全站政策、信任背书与关键页面",
    `- 免邮门槛：${freeShip ?? "未提取（撰写文案时请核实，勿编造）"}`,
    `- 配送政策：${shipSummary ?? "—"}`,
    `- 退换货政策：${returnSummary ?? "—"}`,
    `- 保修承诺：${warrantySummary ?? "—"}`,
    `- 官方客服：邮箱 ${emailFact ?? "—"} · 电话 ${phoneFact ?? "—"}`,
    `- 关键政策页 URL：${Object.keys(keyPages).length ? Object.entries(keyPages).sort(([a], [b]) => compareKeys(a, b)).map(([k, v]) => `${k}: ${v}`).join(" · ") : "—"}`,
    `- 官方社媒主页：${Object.keys(socialLinks).length ? Object.entries(socialLinks).sort(([a], [b]) => compareKeys(a, b)).map(([k, v]) => `${k}: ${v}`).join(" · ") : "—"}`,
  );

  if (input.workspaceAssets?.length) {
    lines.push("", "## 3. 工作区现有资产与待审清单（只读目录索引）");
    const outputsSec = input.workspaceAssets.find((s) => s.dir === "_outputs");
    if (outputsSec) {
      if (outputsSec.files.length === 0) {
        lines.push("- **`_outputs/`（待审产物）**：当前为空（无待办审核项）");
      } else {
        lines.push(`- **` + "`_outputs/`" + `（待审产物，共 ${outputsSec.files.length} 项）**：`);
        for (const f of outputsSec.files) {
          lines.push(`  - \`${f.relativePath}\`（${f.modifiedDate}）${f.title ? ` · ${f.title}` : ""}`);
        }
      }
    }
    for (const sec of input.workspaceAssets.filter((s) => s.dir !== "_outputs")) {
      if (sec.files.length === 0) {
        lines.push(`- **\`${sec.dir}/\`**：暂无用户或 Agent 归档文件（仅板块 README.md）`);
      } else {
        lines.push(`- **\`${sec.dir}/\`（已沉淀 ${sec.files.length} 个文件）**：`);
        for (const f of sec.files.slice(0, 15)) {
          lines.push(`  - \`${f.relativePath}\`（${f.modifiedDate}）${f.title ? ` · ${f.title}` : ""}`);
        }
      }
    }
  }

  const sortedCategories = [...(input.categoryRows ?? [])]
    .sort((a, b) => (b.product_count ?? b.sku_count ?? 0) - (a.product_count ?? a.sku_count ?? 0) || compareKeys(a.slug, b.slug));
  lines.push("", "## 4. 全站分类目录、价格带与导语摘要");
  if (!sortedCategories.length) {
    lines.push("暂无分类数据。");
  } else {
    lines.push(
      "| 分类 (slug) | 在售产品 | 有货/总 SKU | 价格带 | 代表商品 handle | 导语摘要 |",
      "|---|---:|---:|---|---|---|",
      ...sortedCategories.slice(0, 20).map((cat) => {
        const range = formatPriceRange(cat.price_min, cat.price_max, currency);
        const handles = cat.top_handles?.slice(0, 4).map((h) => `\`${h}\``).join("、") || "—";
        const excerpt = cat.intro_excerpt ? cell(cat.intro_excerpt.slice(0, 80)) : "—";
        return `| ${cell(cat.name)} (\`${cat.slug}\`) | ${cat.product_count ?? "—"} | ${cat.in_stock_count ?? "—"}/${cat.sku_count ?? "—"} | ${range} | ${handles} | ${excerpt} |`;
      }),
    );
  }

  const activeProducts = (input.productRows ?? []).filter((p) => p.status === "active");
  const topProducts = [...activeProducts]
    .sort((a, b) => {
      const aIn = a.stock_status === "in_stock" ? 1 : 0;
      const bIn = b.stock_status === "in_stock" ? 1 : 0;
      if (aIn !== bIn) return bIn - aIn;
      const aPri = a.priority ?? 0;
      const bPri = b.priority ?? 0;
      if (aPri !== bPri) return bPri - aPri;
      return compareKeys(a.handle, b.handle);
    })
    .slice(0, 15);
  lines.push("", "## 5. 主推与代表性在售商品速查（Top 15）");
  if (!topProducts.length) {
    lines.push(`暂无商品视图数据，请查阅 \`${paths.productsView}\` 或运行视图生成。`);
  } else {
    lines.push(
      "| Handle | 标题 | 分类 | 价格 | 库存 | 标签 / 优先级 | 核心卖点与规格摘要 |",
      "|---|---|---|---|---|---|---|",
      ...topProducts.map((p) => {
        const price = formatPriceRange(p.price_min, p.price_max, p.currency);
        const tagText = [
          ...(p.tags ?? []),
          ...(p.custom_labels ?? []),
          ...(p.priority !== null && p.priority !== undefined ? [`P${p.priority}`] : []),
        ].join(", ") || "—";
        const highlightPart = p.highlights?.length
          ? p.highlights.slice(0, 2).join("；")
          : p.email_blurb || p.short_description?.slice(0, 90) || "";
        const specPart = p.specs && Object.keys(p.specs).length
          ? Object.entries(p.specs).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(", ")
          : "";
        const summary = [highlightPart, specPart].filter(Boolean).join(" | ") || "—";
        return `| \`${p.handle}\` | ${cell(p.title)} | \`${p.category}\` | ${price} | ${p.stock_status} | ${cell(tagText)} | ${cell(summary)} |`;
      }),
    );
  }

  const recentCampaigns = [...(input.edmCampaigns ?? [])]
    .sort((a, b) => compareKeys(b.send_date ?? b.date, a.send_date ?? a.date))
    .slice(0, 5);
  const cooldownDays = input.site.edm?.cooldown_days ?? 21;
  const cooldownCutoff = dateOffset(input.asOf, -cooldownDays);
  const cooldownHandles = [...new Set(
    (input.edmCampaigns ?? [])
      .filter((c) => (c.send_date ?? c.date) >= cooldownCutoff)
      .flatMap((c) => c.handles ?? []),
  )].sort(compareKeys);
  lines.push(
    "",
    "## 6. 近期 EDM 活动与推品冷却期",
    `- 冷却期规则：${cooldownDays} 天内已推商品避免重复主推`,
    `- 当前处于冷却期内的商品（自 ${cooldownCutoff} 起）：${cooldownHandles.length ? cooldownHandles.map((h) => `\`${h}\``).join("、") : "无"}`,
    ...(recentCampaigns.length
      ? recentCampaigns.map((c) => `- \`${c.campaign_id}\`（${c.send_date ?? c.date} · ${c.status}）：${c.theme}${c.subject ? ` · "${c.subject}"` : ""} → 涉及商品：${(c.handles ?? []).map((h) => `\`${h}\``).join("、") || "—"}`)
      : ["- 暂无 EDM 活动记录"]),
  );

  const openIssues = [...(input.seoIssues ?? [])]
    .filter((issue) => issue.status === "open")
    .sort((a, b) => {
      const rank = { high: 0, mid: 1, low: 2 };
      return rank[a.severity] - rank[b.severity] || compareKeys(a.url, b.url) || compareKeys(a.rule, b.rule);
    });
  lines.push("", "## 7. 当前高优待办与异常提醒");
  if (!openIssues.length) {
    lines.push("- 当前无待处理（open）的 SEO 问题。");
  } else {
    for (const issue of openIssues.slice(0, 12)) {
      const label = SEO_RULE_LABELS[issue.rule] ?? issue.rule;
      lines.push(`- **[${issue.severity.toUpperCase()}]** ${label} · \`${issue.url}\` — ${issue.detail}`);
    }
    if (openIssues.length > 12) {
      lines.push(`- …其余 ${openIssues.length - 12} 条待处理问题请查阅 \`${paths.seoIssues}\``);
    }
  }

  lines.push("");
  return lines.join("\n");
}
