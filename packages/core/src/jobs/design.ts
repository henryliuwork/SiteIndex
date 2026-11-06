/// <reference lib="dom" />
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  PATHS,
  type DesignButtonVariant,
  type DesignButtons,
  type DesignColorRole,
  type DesignColorRoles,
  type DesignColorRoleValue,
  type DesignTokens,
  type DesignTypographyScaleKey,
  type DesignTypographyScaleValue,
  type ProductView,
  type SiteConfig,
} from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { compareKeys } from "../io/compare";
import { readJsonl, type JsonRecord } from "../io/jsonl";
import type { BrowserLauncher, BrowserPage, BrowserSession } from "../browser/automation";

interface DesignTarget {
  kind: "home" | "category" | "product";
  url: string;
}

interface PageDesign {
  variables: Record<string, string>;
  colors: { value: string; count: number }[];
  roles: DesignColorRoles;
  fonts: { heading: string | null; body: string | null; mono: string | null };
  scale: Partial<Record<DesignTypographyScaleKey, DesignTypographyScaleValue>>;
  spacing: { value: string; count: number }[];
  radius: { value: string; count: number }[];
  shadow: { value: string; count: number }[];
  buttons: DesignButtons;
  components: Record<string, Record<string, string | number>>;
  logo: string | null;
  favicon: string | null;
}

const COLOR_ROLES: DesignColorRole[] = ["primary", "secondary", "text", "text_muted", "background", "surface", "border", "sale", "link"];
const BUTTON_VARIANTS: DesignButtonVariant[] = ["primary", "secondary", "outline"];

function chooseRole(samples: PageDesign[], role: DesignColorRole): DesignColorRoleValue | null {
  const candidates = samples.flatMap((sample) => sample.roles[role] ? [sample.roles[role]!] : []);
  return [...candidates].sort((left, right) => right.confidence - left.confidence
    || compareKeys(left.source, right.source) || compareKeys(left.value, right.value))[0] ?? null;
}

function chooseFrequency(samples: PageDesign[], key: "spacing" | "radius" | "shadow"): string[] {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    for (const { value, count } of sample[key]) counts.set(value, (counts.get(value) ?? 0) + count);
  }
  return [...counts].sort((left, right) => right[1] - left[1] || compareKeys(left[0], right[0]))
    .slice(0, 6).map(([value]) => value);
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
    const spacingCounts = new Map<string, number>();
    const radiusCounts = new Map<string, number>();
    const shadowCounts = new Map<string, number>();
    const elements = Array.from(document.querySelectorAll("body *")).slice(0, 3000);
    const increment = (counts: Map<string, number>, value: string) => counts.set(value, (counts.get(value) ?? 0) + 1);
    const normalizeLength = (value: string): string => value.trim().replace(/(-?\d*\.?\d+)px/g, (_match, raw: string) => {
      const rounded = Math.round(Number(raw) * 100) / 100;
      return `${Object.is(rounded, -0) ? 0 : rounded}px`;
    }).replace(/\s+/g, " ");
    const normalizeShadow = (value: string): string => normalizeLength(value).replace(/\s*,\s*/g, ", ");
    const isColor = (value: string): boolean => {
      const normalized = value.trim().toLowerCase();
      return Boolean(normalized && !["transparent", "rgba(0, 0, 0, 0)", "inherit", "initial", "unset", "revert", "currentcolor"].includes(normalized)
        && CSS.supports("color", normalized));
    };
    const roles: PageDesign["roles"] = {
      primary: null, secondary: null, text: null, text_muted: null, background: null,
      surface: null, border: null, sale: null, link: null,
    };
    const roleVariables: Record<DesignColorRole, RegExp> = {
      primary: /(?:^|[-_])(?:primary|brand-primary|brand|accent)(?:$|[-_])/i,
      secondary: /(?:^|[-_])secondary(?:$|[-_])/i,
      text: /(?:^|[-_])(?:text|foreground)(?:$|[-_])/i,
      text_muted: /(?:^|[-_])(?:text-muted|muted|subtle)(?:$|[-_])/i,
      background: /(?:^|[-_])(?:background|bg)(?:$|[-_])/i,
      surface: /(?:^|[-_])(?:surface|card)(?:$|[-_])/i,
      border: /(?:^|[-_])border(?:$|[-_])/i,
      sale: /(?:^|[-_])(?:sale|discount|price-sale)(?:$|[-_])/i,
      link: /(?:^|[-_])(?:link|anchor)(?:$|[-_])/i,
    };
    const colorRoleKeys: DesignColorRole[] = ["primary", "secondary", "text", "text_muted", "background", "surface", "border", "sale", "link"];
    for (const role of colorRoleKeys) {
      const pattern = roleVariables[role];
      const match = Object.entries(variables).filter(([name, value]) => pattern.test(name)
        && !(role === "text" && /(?:^|[-_])text[-_](?:muted|subtle)(?:$|[-_])/i.test(name))
        && isColor(value))
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)[0];
      if (match) roles[role] = { value: match[1], source: match[0], confidence: 0.98 };
    }
    const elementColor = (selector: string, property: "color" | "backgroundColor", confidence: number) => {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const value = getComputedStyle(element)[property];
        if (!isColor(value)) continue;
        const tag = element.tagName.toLowerCase();
        const id = element.id ? `#${element.id}` : "";
        const className = typeof element.className === "string" && element.className.trim() ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
        return { value, source: `${tag}${id}${className}`, confidence };
      }
      return null;
    };
    if (!roles.text) roles.text = elementColor("body", "color", 0.92);
    if (!roles.background) roles.background = elementColor("body, html", "backgroundColor", 0.92);
    if (!roles.text_muted) roles.text_muted = elementColor("[class*=muted i], [class*=subtle i]", "color", 0.82);
    if (!roles.surface) roles.surface = elementColor("article, [class*=surface i], [class*=card i], [data-surface]", "backgroundColor", 0.86);
    if (!roles.border) {
      const borderElement = elements.find((element) => {
        const style = getComputedStyle(element);
        return Number.parseFloat(style.borderTopWidth) > 0 && isColor(style.borderTopColor);
      });
      if (borderElement) {
        const style = getComputedStyle(borderElement);
        const tag = borderElement.tagName.toLowerCase();
        const id = borderElement.id ? `#${borderElement.id}` : "";
        const className = typeof borderElement.className === "string" && borderElement.className.trim() ? `.${borderElement.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
        roles.border = { value: style.borderTopColor, source: `${tag}${id}${className}`, confidence: 0.82 };
      }
    }
    if (!roles.sale) roles.sale = elementColor("[class*=sale i], [class*=discount i], [data-role*=sale i]", "color", 0.86);
    if (!roles.link) roles.link = elementColor("a", "color", 0.88);
    if (!roles.primary) roles.primary = elementColor("button.primary, [class*=primary i], [data-variant=primary]", "backgroundColor", 0.88);
    if (!roles.secondary) roles.secondary = elementColor("button.secondary, [class*=secondary i], [data-variant=secondary]", "backgroundColor", 0.84);

    for (const element of elements) {
      const style = getComputedStyle(element);
      for (const value of [style.color, style.backgroundColor, style.borderTopColor]) if (isColor(value)) increment(colorCounts, value);
      for (const value of [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft, style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]) {
        const normalized = normalizeLength(value);
        if (normalized && normalized !== "0px" && normalized !== "0") increment(spacingCounts, normalized);
      }
      if (style.borderRadius && style.borderRadius !== "0px") increment(radiusCounts, normalizeLength(style.borderRadius));
      if (style.boxShadow && style.boxShadow !== "none") increment(shadowCounts, normalizeShadow(style.boxShadow));
    }

    const scale: PageDesign["scale"] = {};
    const selectors: ["h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "body" | "small" | "caption", string][] = [
      ["h1", "h1"], ["h2", "h2"], ["h3", "h3"], ["h4", "h4"], ["h5", "h5"], ["h6", "h6"],
      ["body", "body"], ["small", "small"], ["caption", "caption, figcaption, [class*=caption i]"],
    ];
    for (const [key, selector] of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const style = getComputedStyle(element);
      scale[key] = { size: style.fontSize, weight: Number.parseInt(style.fontWeight, 10) || 400, line_height: style.lineHeight, letter_spacing: style.letterSpacing };
    }

    const heading = document.querySelector("h1, h2, h3, h4, h5, h6");
    const bodyFont = getComputedStyle(document.body).fontFamily || null;
    const headingFont = heading ? getComputedStyle(heading).fontFamily || null : bodyFont;
    const monoElement = document.querySelector("code, pre, kbd, samp, [class*=mono i]");
    const monoFont = monoElement ? getComputedStyle(monoElement).fontFamily || null : null;
    const hoverBackground = (element: Element): string | null => {
      let matched: string | null = null;
      const inspectRules = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if ("selectorText" in rule && "style" in rule) {
            const styleRule = rule as CSSStyleRule;
            const baseSelectors = styleRule.selectorText.split(",").map((selector) => selector.trim()).filter((selector) => selector.includes(":hover"));
            if (!baseSelectors.some((selector) => {
              try { return element.matches(selector.replace(/:hover/g, "").trim()); }
              catch { return false; }
            })) continue;
            const declared = styleRule.style.getPropertyValue("background-color") || styleRule.style.getPropertyValue("background");
            if (declared) matched = declared;
          } else if ("cssRules" in rule) {
            try { inspectRules((rule as CSSGroupingRule).cssRules); }
            catch { /* 跨域或无权读取的样式表保持未知 */ }
          }
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try { inspectRules(sheet.cssRules); }
        catch { /* 跨域样式表保持未知 */ }
      }
      if (!matched) return null;
      const probe = document.createElement("span");
      probe.style.color = matched;
      document.documentElement.append(probe);
      const computed = getComputedStyle(probe).color;
      probe.remove();
      return isColor(computed) ? computed : null;
    };
    const buttons: PageDesign["buttons"] = { primary: null, secondary: null, outline: null };
    const buttonSelectors: Record<DesignButtonVariant, string> = {
      primary: "button.primary, [role=button].primary, [data-variant=primary], button[type=submit], input[type=submit]",
      secondary: "button.secondary, [role=button].secondary, [data-variant=secondary]",
      outline: "button.outline, [role=button].outline, [data-variant=outline]",
    };
    const buttonVariantKeys: DesignButtonVariant[] = ["primary", "secondary", "outline"];
    for (const variant of buttonVariantKeys) {
      const selector = buttonSelectors[variant];
      const button = document.querySelector(selector);
      if (!button) continue;
      const style = getComputedStyle(button);
      const border = style.borderTopStyle === "none" || style.borderTopWidth === "0px" || !isColor(style.borderTopColor)
        ? null
        : `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`;
      buttons[variant] = {
        background: isColor(style.backgroundColor) ? style.backgroundColor : null,
        text_color: isColor(style.color) ? style.color : null,
        border,
        border_radius: style.borderRadius || null,
        padding: style.padding || null,
        font_size: style.fontSize || null,
        font_weight: Number.parseInt(style.fontWeight, 10) || null,
        hover_background: hoverBackground(button),
      };
    }
    const firstButton = document.querySelector("button, [role=button], input[type=submit]");
    const buttonStyle = firstButton ? getComputedStyle(firstButton) : null;
    const logo = document.querySelector<HTMLImageElement>("header img[alt*=logo i], header img, [class*=logo i] img")?.src ?? null;
    const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ?? null;
    const components: Record<string, Record<string, string | number>> = {};
    if (buttonStyle) components.button = { color: buttonStyle.color, background: buttonStyle.backgroundColor, radius: buttonStyle.borderRadius, padding: buttonStyle.padding };
    const frequencies = (counts: Map<string, number>) => [...counts].map(([value, count]) => ({ value, count }));
    return {
      variables,
      colors: [...colorCounts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)).slice(0, 20),
      roles,
      fonts: { heading: headingFont, body: bodyFont, mono: monoFont },
      scale,
      spacing: frequencies(spacingCounts),
      radius: frequencies(radiusCounts),
      shadow: frequencies(shadowCounts),
      buttons,
      components,
      logo,
      favicon,
    };
  });
}

function makeTokens(samples: PageDesign[], targets: DesignTarget[], extractedAt: string): DesignTokens {
  const counts = new Map<string, number>();
  const variables: Record<string, string> = {};
  const scale: DesignTokens["typography"]["scale"] = {};
  const components: DesignTokens["components"] = {};
  const buttons: DesignButtons = { primary: null, secondary: null, outline: null };
  for (const sample of samples) {
    Object.assign(variables, sample.variables);
    for (const color of sample.colors) counts.set(color.value, (counts.get(color.value) ?? 0) + color.count);
    Object.assign(scale, sample.scale);
    Object.assign(components, sample.components);
    for (const variant of BUTTON_VARIANTS) {
      const candidate = sample.buttons[variant];
      if (candidate && !buttons[variant]) buttons[variant] = candidate;
    }
  }
  const palette = [...counts].map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || compareKeys(a.value, b.value)).slice(0, 12);
  const colorRoles = Object.fromEntries(COLOR_ROLES.map((role) => [role, chooseRole(samples, role)])) as DesignColorRoles;
  const roleColor = (role: DesignColorRole) => colorRoles[role]?.value ?? null;
  const primary = roleColor("primary");
  const secondary = roleColor("secondary");
  const logo = samples.find((sample) => sample.logo)?.logo ?? null;
  const favicon = samples.find((sample) => sample.favicon)?.favicon ?? null;
  const fontValue = (key: "heading" | "body" | "mono") => samples.map((sample) => sample.fonts[key]).find((value): value is string => Boolean(value));
  const fontFamilies: DesignTokens["typography"]["font_families"] = {};
  const headingFont = fontValue("heading");
  const bodyFont = fontValue("body");
  const monoFont = fontValue("mono");
  if (headingFont) fontFamilies.heading = headingFont;
  if (bodyFont) fontFamilies.body = bodyFont;
  if (monoFont) fontFamilies.mono = monoFont;
  return {
    extracted_at: extractedAt,
    source_pages: [...new Set(targets.map(({ url }) => url))].sort(compareKeys),
    css_variables: Object.fromEntries(Object.entries(variables).sort(([left], [right]) => compareKeys(left, right))),
    color: {
      primary,
      secondary,
      text: roleColor("text"),
      text_muted: roleColor("text_muted"),
      background: roleColor("background"),
      surface: roleColor("surface"),
      border: roleColor("border"),
      sale: roleColor("sale"),
      palette,
      roles: colorRoles,
    },
    typography: {
      font_families: fontFamilies,
      scale,
    },
    spacing: chooseFrequency(samples, "spacing"),
    radius: chooseFrequency(samples, "radius"),
    shadow: chooseFrequency(samples, "shadow"),
    components,
    assets: { logo, favicon },
    email_safe: { font_stack: bodyFont, button_color: buttons.primary?.background ?? primary ?? undefined },
    buttons,
  };
}

function brandMarkdown(name: string, tokens: DesignTokens): string {
  const roleLabels: Record<DesignColorRole, string> = {
    primary: "主色", secondary: "次色", text: "正文文字", text_muted: "弱化文字", background: "页面背景",
    surface: "表面", border: "边框", sale: "促销", link: "链接",
  };
  const roleRows = COLOR_ROLES.map((role) => {
    const value = tokens.color.roles?.[role];
    return `| ${roleLabels[role]} | ${value?.value ?? "未识别"} | ${value?.source ?? "—"} | ${value ? `${Math.round(value.confidence * 100)}%` : "—"} |`;
  });
  const scaleRows = Object.entries(tokens.typography.scale).sort(([left], [right]) => compareKeys(left, right))
    .map(([key, value]) => `| ${key} | ${value.size} | ${value.weight} | ${value.line_height} | ${value.letter_spacing ?? "—"} |`);
  const buttonRows = BUTTON_VARIANTS.map((variant) => {
    const button = tokens.buttons?.[variant];
    return `| ${variant} | ${button?.background ?? "—"} | ${button?.text_color ?? "—"} | ${button?.border ?? "—"} | ${button?.border_radius ?? "—"} | ${button?.padding ?? "—"} | ${button?.font_size ?? "—"} | ${button?.font_weight ?? "—"} | ${button?.hover_background ?? "—"} |`;
  });
  const fonts = tokens.typography.font_families;
  const list = (values: string[]) => values.length ? values.map((value) => `\`${value}\``).join("、") : "未识别";
  return [
    `# ${name} 品牌视觉规范`,
    "",
    `提取时间：${tokens.extracted_at}`,
    `采样页面：${tokens.source_pages.length} 个`,
    "",
    "## 色彩角色",
    "| 角色 | 颜色 | 来源 | 置信度 |",
    "|---|---|---|---:|",
    ...roleRows,
    "",
    "## 字体与字号层级",
    `- 标题字体：${fonts.heading ?? "未识别"}`,
    `- 正文字体：${fonts.body ?? "未识别"}`,
    `- 等宽字体：${fonts.mono ?? "未识别"}`,
    "",
    "| 层级 | 字号 | 字重 | 行高 | 字间距 |",
    "|---|---:|---:|---:|---:|",
    ...(scaleRows.length ? scaleRows : ["| 暂无 | — | — | — | — |"]),
    "",
    "## 按钮规范",
    "| 类型 | 背景 | 文字 | 边框 | 圆角 | 内边距 | 字号 | 字重 | 悬停背景 |",
    "|---|---|---|---|---|---|---:|---:|---|",
    ...buttonRows,
    "",
    "## 高频设计值",
    `- 间距：${list(tokens.spacing)}`,
    `- 圆角：${list(tokens.radius)}`,
    `- 阴影：${list(tokens.shadow)}`,
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
