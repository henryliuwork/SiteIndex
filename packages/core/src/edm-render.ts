import { readFile } from "node:fs/promises";
import path from "node:path";
import { PATHS, type ProductView, type SiteConfig, type SiteIndexError } from "@siteindex/shared";
import { atomicWrite } from "./io/atomic-write";
import { readJsonl } from "./io/jsonl";

export interface EdmRenderOptions {
  allowOos?: boolean;
}

export interface EdmRenderResult {
  campaign_id: string;
  included: number;
  warnings: string[];
  email_path: string;
  products_path: string;
}

interface EdmContentProduct {
  handle: string;
  blurb?: string | null;
}

interface EdmContent {
  campaign_id?: string;
  subject: string;
  preheader?: string | null;
  headline: string;
  intro?: string | null;
  products: EdmContentProduct[];
  cta_text: string;
  cta_url: string;
  closing?: string | null;
  promo_code?: string | null;
  promo_note?: string | null;
}

interface EdmSite extends Omit<SiteConfig, "edm"> {
  edm?: SiteConfig["edm"] & { brand_color?: string; font_stack?: string };
}

interface RenderProduct extends ProductView {
  blurb: string | null;
}

const SYMBOL: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", AUD: "A$", CAD: "C$", JPY: "¥", CNY: "¥",
};
const SNAPSHOT_FLOAT_FIELDS = new Set(["price_min", "price_max", "compare_at_max"]);

function edmError(code: SiteIndexError["code"], message: string, detail?: string): Error & SiteIndexError {
  return Object.assign(new Error(message), { code, detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw edmError("CONFIG_INVALID", `EDM content.json 缺少有效的 ${field}。`);
  }
  return value;
}

function parseContent(value: unknown): EdmContent {
  if (!isRecord(value)) throw edmError("CONFIG_INVALID", "EDM content.json 必须是 JSON 对象。");
  if (!Array.isArray(value.products)) throw edmError("CONFIG_INVALID", "EDM content.json 的 products 必须是数组。");
  const products = value.products.map((item, index) => {
    if (!isRecord(item)) throw edmError("CONFIG_INVALID", `EDM products 第 ${index + 1} 项必须是对象。`);
    const handle = requiredString(item.handle, `products[${index}].handle`);
    if (item.blurb !== undefined && item.blurb !== null && typeof item.blurb !== "string") {
      throw edmError("CONFIG_INVALID", `EDM products[${index}].blurb 必须是文本。`);
    }
    return { handle, blurb: item.blurb as string | null | undefined };
  });
  return {
    campaign_id: typeof value.campaign_id === "string" ? value.campaign_id : undefined,
    subject: requiredString(value.subject, "subject"),
    preheader: typeof value.preheader === "string" ? value.preheader : null,
    headline: requiredString(value.headline, "headline"),
    intro: typeof value.intro === "string" ? value.intro : null,
    products,
    cta_text: requiredString(value.cta_text, "cta_text"),
    cta_url: requiredString(value.cta_url, "cta_url"),
    closing: typeof value.closing === "string" ? value.closing : null,
    promo_code: typeof value.promo_code === "string" ? value.promo_code : null,
    promo_note: typeof value.promo_note === "string" ? value.promo_note : null,
  };
}

function escapeHtml(value: unknown, allowBr = false): string {
  const escaped = (typeof value === "string" ? value : "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return allowBr ? escaped.replaceAll("&lt;br&gt;", "<br>").replaceAll("&lt;br/&gt;", "<br>") : escaped;
}

function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%20", "+");
}

/** Mirror urllib.parse.urlsplit + urlencode while preserving the original authority and path. */
function withUtm(url: string, site: EdmSite, campaignId: string, content?: string): string {
  const parts = /^(https?):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(url);
  if (!parts || !parts[2]) throw edmError("CONFIG_INVALID", `EDM URL 不是有效的绝对 HTTP(S) 地址：${url}`);
  const query = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(parts[4] ?? "")) {
    if (value !== "") query.set(key, value);
  }
  query.set("utm_source", site.edm?.utm?.source ?? "mailchimp");
  query.set("utm_medium", site.edm?.utm?.medium ?? "email");
  query.set("utm_campaign", campaignId);
  if (content) query.set("utm_content", content);
  const encodedQuery = [...query].map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`).join("&");
  const fragment = parts[5] === undefined ? "" : `#${parts[5]}`;
  return `${parts[1]}://${parts[2]}${parts[3]}${encodedQuery ? `?${encodedQuery}` : ""}${fragment}`;
}

function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined) return "";
  const fixed = value.toFixed(2);
  const [whole, fraction] = fixed.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${SYMBOL[currency] ?? `${currency} `}${grouped}.${fraction}`;
}

function productCard(product: RenderProduct, site: EdmSite, campaignId: string, color: string): string {
  let price = money(product.price_min, product.currency);
  if (product.price_max && product.price_min !== null && product.price_max > product.price_min) price = `From ${price}`;
  const was = product.on_sale && product.compare_at_max
    ? `<span style="color:#9a9a9a;text-decoration:line-through;font-weight:400;margin-left:6px">${money(product.compare_at_max, product.currency)}</span>`
    : "";
  const link = withUtm(product.url, site, campaignId, product.handle);
  const blurb = product.blurb
    ? `<p style="margin:6px 0 0;font-size:13px;line-height:18px;color:#555">${escapeHtml(product.blurb)}</p>`
    : "";
  return `<td class="col" width="50%" valign="top" style="padding:10px">
  <a href="${link}" target="_blank" style="text-decoration:none;color:#222">
    <img src="${escapeHtml(product.image_url)}" width="260" alt="${escapeHtml(product.title)}" style="display:block;width:100%;max-width:260px;height:auto;border:0;border-radius:6px">
    <p style="margin:12px 0 0;font-size:15px;line-height:20px;font-weight:600">${escapeHtml(product.title)}</p>
  </a>${blurb}
  <p style="margin:6px 0 10px;font-size:15px;font-weight:700;color:${color}">${price}${was}</p>
  <a href="${link}" target="_blank" style="display:inline-block;padding:9px 18px;border:1px solid ${color};border-radius:4px;color:${color};font-size:13px;font-weight:600;text-decoration:none">Shop now</a>
</td>`;
}

function emailHtml(site: EdmSite, content: EdmContent, campaignId: string, products: readonly RenderProduct[]): string {
  const color = site.edm?.brand_color ?? "#1f3a2e";
  const font = site.edm?.font_stack ?? "Helvetica,Arial,sans-serif";
  const rows: string[] = [];
  for (let index = 0; index < products.length; index += 2) {
    const cells = products.slice(index, index + 2).map((product) => productCard(product, site, campaignId, color));
    if (cells.length === 1) cells.push('<td class="col" width="50%"></td>');
    rows.push(`<tr>${cells.join("")}</tr>`);
  }
  let promo = "";
  if (content.promo_code) {
    const note = content.promo_note
      ? `<br><span style="font-size:12px;color:#777">${escapeHtml(content.promo_note)}</span>`
      : "";
    promo = `<tr><td align="center" style="padding:0 30px 20px"><div style="border:2px dashed ${color};padding:14px;font-size:15px">Use code <strong style="color:${color};letter-spacing:1px">${escapeHtml(content.promo_code)}</strong>${note}</div></td></tr>`;
  }
  const closing = content.closing
    ? `<tr><td style="padding:10px 30px 0;font-size:15px;line-height:22px;color:#333">${escapeHtml(content.closing, true)}</td></tr>`
    : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(content.subject)}</title>
<style>@media only screen and (max-width:600px){.col{display:block!important;width:100%!important}.wrap{width:100%!important}}</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f2;font-family:${font}">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all">${escapeHtml(content.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff">
<tr><td align="center" style="padding:28px 30px 8px;font-size:20px;font-weight:700;letter-spacing:2px;color:${color}">
  <a href="${withUtm(site.base_url, site, campaignId, "logo")}" style="color:${color};text-decoration:none">${escapeHtml(site.brand.name.toUpperCase())}</a></td></tr>
<tr><td align="center" style="padding:18px 30px 6px;font-size:26px;line-height:32px;font-weight:700;color:#222">${escapeHtml(content.headline)}</td></tr>
<tr><td align="center" style="padding:6px 40px 22px;font-size:15px;line-height:22px;color:#444">${escapeHtml(content.intro, true)}</td></tr>
${promo}
<tr><td style="padding:0 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join("")}</table></td></tr>
${closing}
<tr><td align="center" style="padding:24px 30px 34px">
  <a href="${withUtm(content.cta_url, site, campaignId, "cta")}" style="display:inline-block;background:${color};color:#ffffff;padding:14px 32px;border-radius:4px;font-size:15px;font-weight:700;text-decoration:none">${escapeHtml(content.cta_text)}</a></td></tr>
<tr><td align="center" style="padding:18px 30px 26px;background:#fafaf8;font-size:11px;line-height:17px;color:#999">
  *|LIST:ADDRESSLINE|*<br><a href="*|UNSUB|*" style="color:#999">Unsubscribe</a> · <a href="*|UPDATE_PROFILE|*" style="color:#999">Update preferences</a></td></tr>
</table></td></tr></table>
</body></html>
`;
}

function prettyJson(value: unknown, depth = 0, key?: string): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && key && SNAPSHOT_FLOAT_FIELDS.has(key) && Number.isInteger(value)) return `${value}.0`;
    return JSON.stringify(value) ?? "null";
  }
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((item) => `${childIndent}${prettyJson(item, depth + 1)}`).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return "{}";
  return `{\n${entries.map(([field, child]) => `${childIndent}${JSON.stringify(field)}: ${prettyJson(child, depth + 1, field)}`).join(",\n")}\n${indent}}`;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw edmError("PROJECT_NOT_FOUND", `找不到 EDM 输入文件：${filePath}`, String(error));
    }
    throw edmError("CONFIG_INVALID", `无法解析 EDM JSON 文件：${filePath}`, String(error));
  }
}

/** Render Mailchimp-compatible email artifacts from campaign copy and the current product view. */
export async function renderEdm(
  projectPath: string,
  campaignDir: string,
  options: EdmRenderOptions = {},
): Promise<EdmRenderResult> {
  const project = path.resolve(projectPath);
  const campaign = path.resolve(project, campaignDir);
  const sitePath = path.join(project, PATHS.site);
  const contentPath = path.join(campaign, "content.json");
  let site: EdmSite;
  try {
    site = JSON.parse(await readFile(sitePath, "utf8")) as EdmSite;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw edmError("PROJECT_NOT_FOUND", `找不到站点配置：${sitePath}`, String(error));
    }
    throw edmError("CONFIG_INVALID", `无法解析站点配置：${sitePath}`, String(error));
  }
  if (!site.brand || typeof site.brand.name !== "string" || typeof site.base_url !== "string") {
    throw edmError("CONFIG_INVALID", `站点配置缺少品牌名称或 base_url：${sitePath}`);
  }
  const content = parseContent(await readJsonFile(contentPath));
  const campaignId = content.campaign_id || path.basename(campaign);
  const productViews = await readJsonl(path.join(project, PATHS.productsView)) as unknown as ProductView[];
  if (!productViews.length) {
    throw edmError("PROJECT_UNREADABLE", `产品视图为空，先运行 views：${path.join(project, PATHS.productsView)}`);
  }
  const byHandle = new Map(productViews.map((product) => [product.handle, product]));
  const warnings: string[] = [];
  const picks: RenderProduct[] = [];
  for (const item of content.products) {
    const product = byHandle.get(item.handle);
    if (!product) {
      warnings.push(`${item.handle}: 不存在`);
      continue;
    }
    if (product.stock_status !== "in_stock" && !options.allowOos) {
      warnings.push(`${item.handle}: 当前 ${product.stock_status}，已跳过（确需保留加 --allow-oos）`);
      continue;
    }
    if (!product.image_url) {
      warnings.push(`${item.handle}: 无图片`);
      continue;
    }
    picks.push({ ...product, blurb: item.blurb ?? null });
  }

  const snapshot = picks.map((product) => ({
    handle: product.handle,
    title: product.title,
    price_min: product.price_min ?? null,
    price_max: product.price_max ?? null,
    compare_at_max: product.compare_at_max ?? null,
    currency: product.currency ?? null,
    url: product.url,
    image_url: product.image_url,
    image_source: product.image_source ?? null,
    stock_status: product.stock_status,
    blurb: product.blurb,
  }));
  const emailPath = path.join(campaign, "email.html");
  const productsPath = path.join(campaign, "products.json");
  await atomicWrite(emailPath, emailHtml(site, content, campaignId, picks));
  await atomicWrite(productsPath, `${prettyJson(snapshot)}\n`);
  return {
    campaign_id: campaignId,
    included: picks.length,
    warnings,
    email_path: emailPath,
    products_path: productsPath,
  };
}
