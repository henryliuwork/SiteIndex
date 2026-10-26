/// <reference lib="dom" />
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PATHS, type DesignTokens, type ProductView, type SiteConfig } from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { readJsonl, type JsonRecord } from "../io/jsonl";
import type { BrowserLauncher, BrowserPage, BrowserSession } from "../browser/automation";

interface DesignTarget {
  kind: "home" | "category" | "product";
  url: string;
}

interface PageDesign {
  variables: Record<string, string>;
  colors: { value: string; count: number }[];
  text: string;
  background: string;
  font: string;
  headingFont: string;
  scale: DesignTokens["typography"]["scale"];
  spacing: string[];
  radius: string[];
  shadow: string[];
  components: Record<string, Record<string, string | number>>;
  logo: string | null;
  favicon: string | null;
}

export interface DesignJobOptions {
  projectPath: string;
  config: SiteConfig;
  executablePath: string;
  launchBrowser: BrowserLauncher;
  extractedAt?: string;
}

function siteError(code: "BROWSER_UNAVAILABLE" | "FEED_FETCH_FAILED", message: string, detail?: string) {
  return { code, message, ...(detail ? { detail } : {}) };
}

function isWithinSite(candidate: string, baseUrl: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

async function readCategories(projectPath: string): Promise<{ url?: string }[]> {
  try {
    const data: unknown = JSON.parse(await readFile(path.join(projectPath, PATHS.categories), "utf8"));
    return Array.isArray(data) ? data.filter((row): row is { url?: string } => typeof row === "object" && row !== null) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readRows<T extends JsonRecord>(projectPath: string, relativePath: string): Promise<T[]> {
  try {
    return await readJsonl(path.join(projectPath, relativePath)) as T[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function designTargets(projectPath: string, config: SiteConfig): Promise<DesignTarget[]> {
  const baseUrl = config.base_url;
  if (typeof baseUrl !== "string" || !isWithinSite(baseUrl, baseUrl)) {
    throw siteError("FEED_FETCH_FAILED", "site.json 中没有可用于设计采集的 base_url。");
  }
  const pages = await readRows<{ url?: string; page_type?: string }>(projectPath, PATHS.seoPages);
  const products = await readRows<ProductView & JsonRecord>(projectPath, PATHS.productsView);
  const categories = await readCategories(projectPath);
  const home = baseUrl;
  const categoryUrl = categories.find((row) => typeof row.url === "string" && isWithinSite(row.url, baseUrl))?.url
    ?? pages.find((row) => row.page_type === "collection" && typeof row.url === "string" && isWithinSite(row.url, baseUrl))?.url;
  const productUrl = products.find((row) => typeof row.url === "string" && isWithinSite(row.url, baseUrl))?.url
    ?? pages.find((row) => row.page_type === "product" && typeof row.url === "string" && isWithinSite(row.url, baseUrl))?.url;
  const targets: DesignTarget[] = [{ kind: "home", url: home }];
  if (categoryUrl) targets.push({ kind: "category", url: categoryUrl });
  if (productUrl) targets.push({ kind: "product", url: productUrl });
  return targets;
}

async function inspectPage(page: BrowserPage): Promise<PageDesign> {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const variables: Record<string, string> = {};
    for (let index = 0; index < root.length; index += 1) {
      const name = root.item(index);
      if (name.startsWith("--")) {
        const value = root.getPropertyValue(name).trim();
        if (value) variables[name] = value;
      }
    }

    const colorCounts = new Map<string, number>();
    const spacing = new Set<string>();
    const radius = new Set<string>();
    const shadow = new Set<string>();
    const elements = Array.from(document.querySelectorAll("body *")).slice(0, 3000);
    for (const element of elements) {
      const style = getComputedStyle(element);
      for (const value of [style.color, style.backgroundColor, style.borderTopColor]) {
        if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") continue;
        colorCounts.set(value, (colorCounts.get(value) ?? 0) + 1);
      }
      for (const value of [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft, style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]) {
        if (value && value !== "0px" && spacing.size < 48) spacing.add(value);
      }
      if (style.borderRadius && style.borderRadius !== "0px" && radius.size < 24) radius.add(style.borderRadius);
      if (style.boxShadow && style.boxShadow !== "none" && shadow.size < 24) shadow.add(style.boxShadow);
    }

    const scale: PageDesign["scale"] = {};
    for (const [key, selector] of [["h1", "h1"], ["h2", "h2"], ["body", "p"], ["small", "small"]] as const) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const style = getComputedStyle(element);
      scale[key] = { size: style.fontSize, weight: Number.parseInt(style.fontWeight, 10) || 400, line_height: style.lineHeight };
    }

    const heading = document.querySelector("h1, h2");
    const button = document.querySelector("button, [role=button], input[type=submit]");
    const buttonStyle = button ? getComputedStyle(button) : null;
    const logo = document.querySelector<HTMLImageElement>("header img[alt*=logo i], header img, [class*=logo i] img")?.src ?? null;
    const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ?? null;
    const components: Record<string, Record<string, string | number>> = {};
    if (buttonStyle) components.button = { color: buttonStyle.color, background: buttonStyle.backgroundColor, radius: buttonStyle.borderRadius, padding: buttonStyle.padding };
    return {
      variables,
      colors: [...colorCounts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)).slice(0, 20),
      text: getComputedStyle(document.body).color,
      background: getComputedStyle(document.body).backgroundColor,
      font: getComputedStyle(document.body).fontFamily,
      headingFont: heading ? getComputedStyle(heading).fontFamily : getComputedStyle(document.body).fontFamily,
      scale,
      spacing: [...spacing],
      radius: [...radius],
      shadow: [...shadow],
      components,
      logo,
      favicon,
    };
  });
}

function makeTokens(samples: PageDesign[], targets: DesignTarget[], extractedAt: string): DesignTokens {
  const counts = new Map<string, number>();
  const variables: Record<string, string> = {};
  const spacing = new Set<string>();
  const radius = new Set<string>();
  const shadow = new Set<string>();
  const scale: DesignTokens["typography"]["scale"] = {};
  const components: DesignTokens["components"] = {};
  for (const sample of samples) {
    Object.assign(variables, sample.variables);
    for (const color of sample.colors) counts.set(color.value, (counts.get(color.value) ?? 0) + color.count);
    sample.spacing.forEach((value) => spacing.add(value));
    sample.radius.forEach((value) => radius.add(value));
    sample.shadow.forEach((value) => shadow.add(value));
    Object.assign(scale, sample.scale);
    Object.assign(components, sample.components);
  }
  const palette = [...counts].map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)).slice(0, 12);
  const primaryVariable = Object.entries(variables).find(([name]) => /primary|brand|accent/i.test(name))?.[1] ?? null;
  const primary = primaryVariable ?? palette.find(({ value }) => !/^(rgb\(255, 255, 255\)|rgb\(0, 0, 0\)|#fff|#ffffff|#000|#000000)$/i.test(value))?.value ?? null;
  const logo = samples.find((sample) => sample.logo)?.logo ?? null;
  const favicon = samples.find((sample) => sample.favicon)?.favicon ?? null;
  return {
    extracted_at: extractedAt,
    source_pages: [...new Set(targets.map(({ url }) => url))],
    css_variables: Object.fromEntries(Object.entries(variables).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    color: {
      primary,
      secondary: palette.find(({ value }) => value !== primary)?.value ?? null,
      text: samples.find((sample) => sample.text)?.text ?? null,
      background: samples.find((sample) => sample.background)?.background ?? null,
      palette,
    },
    typography: {
      font_families: {
        heading: samples.find((sample) => sample.headingFont)?.headingFont,
        body: samples.find((sample) => sample.font)?.font,
      },
      scale,
    },
    spacing: [...spacing].sort((a, b) => parseFloat(a) - parseFloat(b) || (a === b ? 0 : a < b ? -1 : 1)),
    radius: [...radius].sort(),
    shadow: [...shadow].sort(),
    components,
    assets: { logo, favicon },
    email_safe: { font_stack: samples.find((sample) => sample.font)?.font, button_color: typeof components.button?.background === "string" ? components.button.background : primary ?? undefined },
  };
}

function brandMarkdown(name: string, tokens: DesignTokens): string {
  const colors = tokens.color.palette.map(({ value, count }) => `- ${value} (${count})`).join("\n") || "- 暂无颜色样本";
  const heading = tokens.typography.font_families.heading ?? "未识别";
  const body = tokens.typography.font_families.body ?? "未识别";
  return [
    `# ${name} 品牌视觉规范`,
    "",
    `提取时间：${tokens.extracted_at}`,
    `采样页面：${tokens.source_pages.length} 个`,
    "",
    "## 色彩",
    `- 主色：${tokens.color.primary ?? "未识别"}`,
    `- 次色：${tokens.color.secondary ?? "未识别"}`,
    colors,
    "",
    "## 字体",
    `- 标题：${heading}`,
    `- 正文：${body}`,
    "",
    "## 设计提示",
    "以下数据由首页、分类页和产品页的浏览器样式采样生成，可在设计系统页人工校正。",
    "",
  ].join("\n");
}

export async function runDesign(options: DesignJobOptions): Promise<{ targets: number; screenshots: number; tokens: DesignTokens }> {
  const targets = await designTargets(options.projectPath, options.config);
  if (!options.executablePath.trim()) throw siteError("BROWSER_UNAVAILABLE", "请由调用方提供 Chrome 或 Edge 的 executablePath。");
  const screenshotsDir = path.join(options.projectPath, PATHS.designScreenshots);
  await mkdir(screenshotsDir, { recursive: true });
  let browser: BrowserSession;
  try {
    browser = await options.launchBrowser(options.executablePath, { headless: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "BROWSER_UNAVAILABLE") throw error;
    throw siteError("BROWSER_UNAVAILABLE", "无法启动调用方提供的浏览器。", error instanceof Error ? error.message : String(error));
  }

  const samples: PageDesign[] = [];
  let screenshotCount = 0;
  try {
    for (const target of targets) {
      const page = await browser.newPage();
      try {
        try {
          await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        } catch (error) {
          throw siteError("FEED_FETCH_FAILED", `无法打开${target.kind === "home" ? "首页" : target.kind === "category" ? "分类页" : "产品页"}。`, error instanceof Error ? error.message : String(error));
        }
        samples.push(await inspectPage(page));
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
          await page.screenshot({ path: path.join(screenshotsDir, `${target.kind}-${width}.png`), fullPage: true });
          screenshotCount += 1;
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  const tokens = makeTokens(samples, targets, options.extractedAt ?? new Date().toISOString());
  const brandName = typeof options.config.brand?.name === "string" && options.config.brand.name ? options.config.brand.name : options.config.domain;
  await atomicWrite(path.join(options.projectPath, PATHS.designTokens), `${JSON.stringify(tokens, null, 2)}\n`);
  await atomicWrite(path.join(options.projectPath, PATHS.designBrand), brandMarkdown(brandName, tokens));
  return { targets: targets.length, screenshots: screenshotCount, tokens };
}
