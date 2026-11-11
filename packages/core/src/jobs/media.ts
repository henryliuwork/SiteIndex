import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import {
  CSV_HEADERS,
  type InventoryLatest,
  type MediaPrepareSkuResult,
  type SiteConfig,
  type SkuRecord,
} from "@siteindex/shared";
import { compareKeys } from "../io/compare";
import { atomicWrite } from "../io/atomic-write";
import { readCsv, writeCsv, type CsvRow } from "../io/csv";
import { groupSkuIds } from "../inventory/sku-grouping";

const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 25_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_RATE_LIMIT_MS = 250;

export interface WordPressCredential {
  username: string;
  applicationPassword: string;
}

export interface MediaJobOptions {
  runId: string;
  checkpointPath: string;
  mediaLedgerPath: string;
  config: SiteConfig;
  skus: readonly SkuRecord[];
  latest: readonly InventoryLatest[];
  mediaLedger: readonly CsvRow[];
  requestedSkus: readonly string[];
  credential?: WordPressCredential;
  date: string;
  rateLimitMs?: number;
  fetchImpl?: typeof fetch;
  /** 仅允许本地 loopback fixture 使用 HTTP；生产调用保持 HTTPS-only。 */
  allowLoopbackHttpForTests?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface MediaJobOutcome {
  status: "ok" | "partial" | "failed";
  summary: string;
  counts: Record<string, number>;
  media_requested_skus: string[];
  media_batch_state: "complete" | "interrupted" | "outcome_unknown";
  media_results: MediaPrepareSkuResult[];
  media_unknown_skus: string[];
  media_not_started_skus: string[];
  media_error_code?: "WP_AUTH_FAILED" | "WP_FORBIDDEN";
  errors?: string[];
}

export interface MediaJobCheckpoint {
  run_id: string;
  checkpoint_state: "running" | "finished";
  media_requested_skus: string[];
  media_batch_state: "complete" | "interrupted" | "outcome_unknown";
  media_results: MediaPrepareSkuResult[];
  media_unknown_skus: string[];
  media_not_started_skus: string[];
  media_error_code?: "WP_AUTH_FAILED" | "WP_FORBIDDEN";
}

type Raster = ImageData;
type SourceFormat = "jpeg" | "png" | "webp" | "avif" | "unsupported";

class MediaOperationError extends Error {
  constructor(
    readonly kind: "failed" | "unknown" | "auth",
    message: string,
    readonly authCode?: "WP_AUTH_FAILED" | "WP_FORBIDDEN",
  ) {
    super(message);
  }
}

interface WordPressMedia {
  id: number;
  slug?: string;
  source_url: string;
}

function mediaError(kind: MediaOperationError["kind"], message: string, authCode?: MediaOperationError["authCode"]): MediaOperationError {
  return new MediaOperationError(kind, message, authCode);
}

async function writeMediaCheckpoint(
  options: MediaJobOptions,
  state: MediaJobCheckpoint["checkpoint_state"],
  results: MediaPrepareSkuResult[],
  unknown: string[],
  notStarted: string[],
  errorCode?: MediaJobCheckpoint["media_error_code"],
): Promise<void> {
  const checkpoint: MediaJobCheckpoint = {
    run_id: options.runId,
    checkpoint_state: state,
    media_requested_skus: [...orderUniqueSkus(options.requestedSkus)],
    media_batch_state: unknown.length ? "outcome_unknown" : notStarted.length ? "interrupted" : "complete",
    media_results: results.map((result) => ({ ...result })),
    media_unknown_skus: [...unknown],
    media_not_started_skus: [...notStarted],
    ...(errorCode ? { media_error_code: errorCode } : {}),
  };
  await atomicWrite(options.checkpointPath, JSON.stringify(checkpoint) + "\n");
}

function ensureImageDataConstructor(): void {
  if (typeof globalThis.ImageData !== "undefined") return;
  class NodeImageData {
    readonly colorSpace = "srgb" as PredefinedColorSpace;

    constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
  }
  Object.defineProperty(globalThis, "ImageData", { configurable: true, value: NodeImageData });
}

function imageData(data: Uint8ClampedArray, width: number, height: number): Raster {
  ensureImageDataConstructor();
  const owned = new Uint8ClampedArray(data.length);
  owned.set(data);
  return new ImageData(owned, width, height);
}

async function compilePackageWasm(specifier: string): Promise<WebAssembly.Module> {
  const wasmPath = createRequire(import.meta.url).resolve(specifier);
  return WebAssembly.compile(await readFile(wasmPath));
}

let webpDecoderPromise: Promise<(bytes: Buffer) => Raster> | undefined;
let avifDecoderPromise: Promise<(bytes: Buffer) => Promise<Raster>> | undefined;
let jpegEncoderPromise: Promise<(raster: Raster) => Promise<Buffer>> | undefined;
let resizePromise: Promise<(raster: Raster, width: number, height: number) => Promise<Raster>> | undefined;

function webpDecoder(): Promise<(bytes: Buffer) => Raster> {
  if (!webpDecoderPromise) {
    webpDecoderPromise = (async () => {
      const [{ default: factory }, { initEmscriptenModule }] = await Promise.all([
        import("@jsquash/webp/codec/dec/webp_dec.js"),
        import("@jsquash/webp/utils.js"),
      ]);
      const wasm = await compilePackageWasm("@jsquash/webp/codec/dec/webp_dec.wasm");
      const module = await initEmscriptenModule(factory, wasm);
      return (bytes) => {
        const decoded = module.decode(bytes);
        if (!decoded) throw new Error("decode");
        return decoded;
      };
    })();
    void webpDecoderPromise.catch(() => { webpDecoderPromise = undefined; });
  }
  return webpDecoderPromise;
}

function avifDecoder(): Promise<(bytes: Buffer) => Promise<Raster>> {
  if (!avifDecoderPromise) {
    avifDecoderPromise = (async () => {
      const [{ default: factory }, { initEmscriptenModule }] = await Promise.all([
        import("@jsquash/avif/codec/dec/avif_dec.js"),
        import("@jsquash/avif/utils.js"),
      ]);
      const wasm = await compilePackageWasm("@jsquash/avif/codec/dec/avif_dec.wasm");
      const module = await initEmscriptenModule(factory, wasm);
      return async (bytes) => {
        const decoded = module.decode(bytes, 8);
        if (!decoded) throw new Error("decode");
        return decoded;
      };
    })();
    void avifDecoderPromise.catch(() => { avifDecoderPromise = undefined; });
  }
  return avifDecoderPromise;
}

function jpegEncoder(): Promise<(raster: Raster) => Promise<Buffer>> {
  if (!jpegEncoderPromise) {
    jpegEncoderPromise = (async () => {
      const [{ default: factory }, { initEmscriptenModule }, { defaultEncodeOptions }] = await Promise.all([
        import("@jsquash/jpeg/codec/enc/mozjpeg_enc.js"),
        import("@jsquash/jpeg/utils.js"),
        import("@jsquash/jpeg/meta.js"),
      ]);
      const wasm = await compilePackageWasm("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm");
      const module = await initEmscriptenModule(factory, wasm);
      return async (raster) => Buffer.from(module.encode(raster.data, raster.width, raster.height, {
        ...defaultEncodeOptions,
        quality: 85,
        color_space: 2,
      }));
    })();
    void jpegEncoderPromise.catch(() => { jpegEncoderPromise = undefined; });
  }
  return jpegEncoderPromise;
}

function resizer(): Promise<(raster: Raster, width: number, height: number) => Promise<Raster>> {
  if (!resizePromise) {
    resizePromise = (async () => {
      const wasm = await compilePackageWasm("@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm");
      const [{ default: resize, initResize }] = await Promise.all([import("@jsquash/resize/index.js")]);
      await initResize(wasm);
      return (raster, width, height) => resize(raster, {
        method: "lanczos3",
        fitMethod: "stretch",
        width,
        height,
        premultiply: true,
        linearRGB: false,
      });
    })();
    void resizePromise.catch(() => { resizePromise = undefined; });
  }
  return resizePromise;
}

function flattenOnWhite(source: Raster): Raster {
  const pixels = new Uint8ClampedArray(source.data.length);
  for (let index = 0; index < source.data.length; index += 4) {
    const alpha = source.data[index + 3]!;
    const inverse = 255 - alpha;
    pixels[index] = Math.round((source.data[index]! * alpha + 255 * inverse) / 255);
    pixels[index + 1] = Math.round((source.data[index + 1]! * alpha + 255 * inverse) / 255);
    pixels[index + 2] = Math.round((source.data[index + 2]! * alpha + 255 * inverse) / 255);
    pixels[index + 3] = 255;
  }
  return imageData(pixels, source.width, source.height);
}

async function convertToJpeg(bytes: Buffer, format: SourceFormat): Promise<{ bytes: Buffer; width: number; height: number }> {
  try {
    const decoded = format === "webp" ? await (await webpDecoder())(bytes)
      : format === "avif" ? await (await avifDecoder())(bytes)
        : null;
    if (!decoded || decoded.width < 1 || decoded.height < 1 || decoded.width * decoded.height > MAX_IMAGE_PIXELS) {
      throw new Error("invalid dimensions");
    }
    let raster = flattenOnWhite(decoded);
    const longest = Math.max(raster.width, raster.height);
    if (longest > 1200) {
      const scale = 1200 / longest;
      const width = Math.max(1, Math.round(raster.width * scale));
      const height = Math.max(1, Math.round(raster.height * scale));
      raster = await (await resizer())(raster, width, height);
    }
    return { bytes: await (await jpegEncoder())(raster), width: raster.width, height: raster.height };
  } catch {
    throw mediaError("failed", "图片无法解码或转换为 JPEG。请更换源图片后重试。");
  }
}

function hasCredentialQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => /(?:auth|token|secret|password|passwd|signature|(^|_)sig($|_)|api[_-]?key|credential|session|jwt)/iu.test(key));
}

function isLoopbackFixtureHost(hostname: string): boolean {
  return hostname.toLowerCase() === "127.0.0.1";
}

function isNonPublicAddress(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")
    || normalized === "metadata" || normalized === "metadata.google.internal" || normalized === "instance-data") return true;
  const family = isIP(normalized);
  if (family === 4) {
    const octets = normalized.split(".").map(Number);
    if (octets.length !== 4) return true;
    const a = octets[0]!;
    const b = octets[1]!;
    const c = octets[2]!;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
      || /^fe[89ab]/u.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("::ffff:");
  }
  return false;
}

function parseHttpUrl(raw: string, allowLoopbackHttpForTests = false): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw mediaError("failed", "商品图片地址无效。"); }
  const loopback = isLoopbackFixtureHost(url.hostname);
  const loopbackHttp = allowLoopbackHttpForTests && url.protocol === "http:" && loopback;
  if ((url.protocol !== "https:" && !loopbackHttp) || (isNonPublicAddress(url.hostname) && !loopbackHttp)
    || url.username || url.password || url.hash || hasCredentialQuery(url)) {
    throw mediaError("failed", "商品图片地址不符合安全要求。");
  }
  return url;
}

function parseWordPressBaseUrl(config: SiteConfig, allowLoopbackHttpForTests = false): URL {
  try {
    const base = new URL(config.base_url);
    const loopback = isLoopbackFixtureHost(base.hostname);
    const loopbackHttp = allowLoopbackHttpForTests && base.protocol === "http:" && loopback;
    if ((base.protocol !== "https:" && !loopbackHttp) || (isNonPublicAddress(base.hostname) && !loopbackHttp)
      || base.username || base.password || base.search || base.hash) throw new Error("url");
    return new URL("wp-json/wp/v2/media", base.href.endsWith("/") ? base : new URL(base.pathname + "/", base.origin));
  } catch {
    throw mediaError("failed", "WordPress 图片服务地址无效。");
  }
}

function sourceFormat(url: URL, contentType?: string, bytes?: Buffer): SourceFormat {
  if (bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
    if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
    if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp"
      && /^(?:avif|avis)$/u.test(bytes.toString("ascii", 8, 12))) return "avif";
  }
  const type = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "jpeg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/avif") return "avif";
  const pathname = url.pathname.toLowerCase();
  if (/\.(?:jpe?g)$/u.test(pathname)) return "jpeg";
  if (pathname.endsWith(".png")) return "png";
  if (pathname.endsWith(".webp")) return "webp";
  if (pathname.endsWith(".avif")) return "avif";
  return "unsupported";
}

async function readLimitedBody(
  response: Response,
  maximumBytes = MAX_SOURCE_IMAGE_BYTES,
  tooLargeMessage = "响应超过允许的文件大小。",
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw mediaError("failed", tooLargeMessage);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw mediaError("failed", tooLargeMessage);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function fetchSourceImage(
  sourceUrl: string,
  fetchImpl: typeof fetch,
  beforeRequest: () => Promise<void>,
  allowLoopbackHttpForTests: boolean,
): Promise<{ url: URL; type: string; bytes: Buffer }> {
  let url = parseHttpUrl(sourceUrl, allowLoopbackHttpForTests);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    let response: Response;
    try {
      await beforeRequest();
      response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      throw mediaError("failed", "下载商品图片失败，请检查图片链接或网络后重试。");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw mediaError("failed", "商品图片重定向过多或缺少目标地址。");
      try { url = parseHttpUrl(new URL(location, url).href, allowLoopbackHttpForTests); }
      catch { throw mediaError("failed", "商品图片重定向目标不符合安全要求。"); }
      continue;
    }
    if (!response.ok) throw mediaError("failed", "下载商品图片失败，请检查图片链接或网络后重试。");
    const type = response.headers.get("content-type") ?? "";
    return { url, type, bytes: await readLimitedBody(response) };
  }
  throw mediaError("failed", "商品图片重定向过多。");
}

function safeOutputUrl(raw: string, wordpressOrigin: string, allowLoopbackHttpForTests: boolean): string {
  const url = parseHttpUrl(raw, allowLoopbackHttpForTests);
  if (url.origin !== wordpressOrigin) throw mediaError("unknown", "WordPress 返回的图片地址不符合预期，结果需检查媒体库。");
  return url.href;
}

function basicAuthorization(credential: WordPressCredential): string {
  return "Basic " + Buffer.from(credential.username + ":" + credential.applicationPassword, "utf8").toString("base64");
}

async function fetchWordPress(
  url: URL,
  credential: WordPressCredential,
  fetchImpl: typeof fetch,
  init: RequestInit,
): Promise<Response> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { ...init.headers, Authorization: basicAuthorization(credential) },
    });
    if (response.status === 401) throw mediaError("auth", "WordPress 应用密码认证失败。", "WP_AUTH_FAILED");
    if (response.status === 403) throw mediaError("auth", "WordPress 账号没有上传媒体的权限。", "WP_FORBIDDEN");
    if (response.status >= 300 && response.status < 400) throw mediaError("failed", "WordPress 图片服务拒绝重定向。");
    return response;
  } catch (error) {
    if (error instanceof MediaOperationError) throw error;
    throw mediaError(init.method === "POST" ? "unknown" : "failed", "无法连接 WordPress 图片服务。");
  }
}

function parseWordPressMedia(value: unknown): WordPressMedia | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = item.id;
  const sourceUrl = item.source_url;
  const slug = item.slug;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || typeof sourceUrl !== "string") return null;
  return { id, source_url: sourceUrl, ...(typeof slug === "string" ? { slug } : {}) };
}

async function readWordPressJson(response: Response): Promise<unknown> {
  if (!response.ok) throw mediaError("failed", "WordPress 图片服务请求失败。");
  const body = await readLimitedBody(response, 256 * 1024, "WordPress 图片服务响应过大。");
  try { return JSON.parse(body.toString("utf8")) as unknown; }
  catch { throw mediaError("failed", "WordPress 图片服务返回了无效响应。"); }
}

function makeSlug(sku: string): string {
  const normalized = sku.toLowerCase();
  const safe = normalized.replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  const disambiguator = safe === normalized ? "" : "-" + createHash("sha256").update(sku).digest("hex").slice(0, 8);
  const base = (safe || "sku") + disambiguator;
  return base.slice(0, 96) + "-main";
}

function ledgerHasUrl(rows: readonly CsvRow[], sku: string): boolean {
  return rows.some((row) => row.sku === sku && row.image_role === "main" && typeof row.image_url === "string" && row.image_url.trim().length > 0);
}

async function upsertMediaLedger(
  ledgerPath: string,
  current: CsvRow[],
  row: Record<string, unknown>,
): Promise<void> {
  const normalized: CsvRow = Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value === null || value === undefined ? null : String(value),
  ]));
  const key = String(row.sku) + "|" + String(row.image_role);
  const rows = new Map(current.map((item) => [String(item.sku ?? "") + "|" + String(item.image_role ?? ""), item]));
  rows.set(key, normalized);
  await writeCsv(ledgerPath, [...rows.values()], CSV_HEADERS.skuMediaV2, ["sku", "image_role"]);
  current.splice(0, current.length, ...rows.values());
}

function chooseRepresentative(
  requestedSku: string,
  activeBySku: ReadonlyMap<string, SkuRecord>,
  parentToChildren: ReadonlyMap<string, readonly string[]>,
  statusBySku: ReadonlyMap<string, string>,
): string | null {
  const children = parentToChildren.get(requestedSku);
  if (!children) return activeBySku.has(requestedSku) ? requestedSku : null;
  const sorted = [...children].sort(compareKeys);
  return sorted.filter((sku) => statusBySku.get(sku) === "in_stock").sort(compareKeys)[0] ?? sorted[0] ?? null;
}

function orderUniqueSkus(skus: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const sku of skus) {
    if (typeof sku !== "string" || !sku.trim() || seen.has(sku)) continue;
    seen.add(sku);
    result.push(sku);
  }
  return result;
}

async function delay(ms: number): Promise<void> {
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function processSku(
  requestedSku: string,
  representativeSku: string,
  record: SkuRecord,
  sourceUrl: string,
  options: MediaJobOptions,
  wordpressBase: URL | null,
  credential: WordPressCredential | undefined,
  fetchImpl: typeof fetch,
  currentLedger: CsvRow[],
  isFirstNetworkRequest: { value: boolean },
): Promise<{ result: MediaPrepareSkuResult; stop?: "WP_AUTH_FAILED" | "WP_FORBIDDEN" }> {
  const slug = makeSlug(representativeSku);
  const parsedSource = parseHttpUrl(sourceUrl, options.allowLoopbackHttpForTests);
  const extensionFormat = sourceFormat(parsedSource);
  let imageBytes: Buffer | null = null;
  let sourceHash: string | null = null;
  let outputUrl: string;
  let mediaId: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let status: MediaPrepareSkuResult["status"];
  let reason: string | undefined;
  const beforeRequest = async () => {
    if (!isFirstNetworkRequest.value) await delay(options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS);
    isFirstNetworkRequest.value = false;
  };

  if (extensionFormat === "jpeg" || extensionFormat === "png") {
    outputUrl = parsedSource.href;
    status = "recorded";
    await upsertMediaLedger(options.mediaLedgerPath, currentLedger, {
      sku: representativeSku,
      image_role: "main",
      image_url: outputUrl,
      alt_text: record.title,
      source: "cdn",
      width,
      height,
      updated_at: options.date,
      media_id: null,
      source_hash: null,
    });
    return { result: { sku: requestedSku, status, image_url: outputUrl } };
  }

  const fetched = await fetchSourceImage(sourceUrl, fetchImpl, beforeRequest, Boolean(options.allowLoopbackHttpForTests));
  const format = sourceFormat(fetched.url, fetched.type, fetched.bytes);
  if (format === "jpeg" || format === "png") {
    outputUrl = fetched.url.href;
    status = "recorded";
    await upsertMediaLedger(options.mediaLedgerPath, currentLedger, {
      sku: representativeSku,
      image_role: "main",
      image_url: outputUrl,
      alt_text: record.title,
      source: "cdn",
      width,
      height,
      updated_at: options.date,
      media_id: null,
      source_hash: null,
    });
    return { result: { sku: requestedSku, status, image_url: outputUrl } };
  }
  if (format !== "webp" && format !== "avif") throw mediaError("failed", "仅支持 JPG、PNG、WebP 与 AVIF 商品图片。");
  if (!wordpressBase || !credential) throw mediaError("failed", "WordPress 图片服务未配置，无法上传转换后的商品图片。");
  const converted = await convertToJpeg(fetched.bytes, format);
  imageBytes = converted.bytes;
  width = converted.width;
  height = converted.height;
  sourceHash = createHash("sha256").update(fetched.bytes).digest("hex");

  await beforeRequest();
  const lookup = new URL(wordpressBase);
  lookup.searchParams.set("slug", slug);
  let lookupResponse: Response;
  try {
    lookupResponse = await fetchWordPress(lookup, credential, fetchImpl, { method: "GET" });
  } catch (error) {
    if (error instanceof MediaOperationError && error.kind === "auth") return { result: { sku: requestedSku, status: "failed", reason: error.message }, stop: error.authCode };
    throw error;
  }
  const lookupValue = await readWordPressJson(lookupResponse);
  const found = Array.isArray(lookupValue) ? lookupValue.map(parseWordPressMedia).find((item): item is WordPressMedia => Boolean(item)) : null;
  if (found) {
    mediaId = found.id;
    try { outputUrl = safeOutputUrl(found.source_url, wordpressBase.origin, Boolean(options.allowLoopbackHttpForTests)); }
    catch (error) { throw error; }
    status = "reused";
  } else {
    await beforeRequest();
    let uploadResponse: Response;
    try {
      uploadResponse = await fetchWordPress(wordpressBase, credential, fetchImpl, {
        method: "POST",
        headers: {
          "content-type": "image/jpeg",
          "content-disposition": "attachment; filename=\"" + slug + ".jpg\"",
          "content-length": String(imageBytes.length),
        },
        body: Uint8Array.from(imageBytes),
      });
    } catch (error) {
      if (error instanceof MediaOperationError && error.kind === "auth") return { result: { sku: requestedSku, status: "failed", reason: error.message }, stop: error.authCode };
      if (error instanceof MediaOperationError && error.kind === "unknown") throw error;
      return { result: { sku: requestedSku, status: "failed", reason: "上传请求失败，结果不确定。" }, stop: undefined };
    }
    if (!uploadResponse.ok) {
      await uploadResponse.body?.cancel();
      return { result: { sku: requestedSku, status: "failed", reason: "WordPress 上传请求未成功，请检查图片服务后重试。" } };
    }
    let uploadedValue: unknown;
    try { uploadedValue = await readWordPressJson(uploadResponse); }
    catch { throw mediaError("unknown", "WordPress 上传结果无法确认，请检查媒体库后重试。"); }
    const uploaded = parseWordPressMedia(uploadedValue);
    if (!uploaded) throw mediaError("unknown", "WordPress 上传结果无法确认，请检查媒体库后重试。");
    mediaId = uploaded.id;
    outputUrl = safeOutputUrl(uploaded.source_url, wordpressBase.origin, Boolean(options.allowLoopbackHttpForTests));
    status = "uploaded";
  }

  if (mediaId !== null) {
    const metadataUrl = new URL(String(mediaId), wordpressBase.href.endsWith("/") ? wordpressBase.href : wordpressBase.href + "/");
    try {
      await beforeRequest();
      const metadataResponse = await fetchWordPress(metadataUrl, credential, fetchImpl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: record.title, alt_text: record.title }),
      });
      if (!metadataResponse.ok) reason = "图片已保存，但标题或替代文本未更新。";
      else await metadataResponse.body?.cancel();
    } catch (error) {
      if (error instanceof MediaOperationError && error.kind === "auth") {
        reason = "图片已保存，但标题或替代文本未更新。";
        await upsertMediaLedger(options.mediaLedgerPath, currentLedger, {
          sku: representativeSku, image_role: "main", image_url: outputUrl, alt_text: record.title,
          source: "wordpress", width, height, updated_at: options.date, media_id: mediaId, source_hash: sourceHash,
        });
        return { result: { sku: requestedSku, status, reason, image_url: outputUrl }, stop: error.authCode };
      }
      reason = "图片已保存，但标题或替代文本未更新。";
    }
  }

  try {
    await upsertMediaLedger(options.mediaLedgerPath, currentLedger, {
      sku: representativeSku,
      image_role: "main",
      image_url: outputUrl,
      alt_text: record.title,
      source: "wordpress",
      width,
      height,
      updated_at: options.date,
      media_id: mediaId,
      source_hash: sourceHash,
    });
  } catch {
    return { result: { sku: requestedSku, status, reason: "图片已上传，但本地台账写入失败。", image_url: outputUrl } };
  }
  return { result: { sku: requestedSku, status, ...(reason ? { reason } : {}), image_url: outputUrl } };
}

/** Run sequential WordPress media preparation. Credentials are accepted only as an in-memory Core context. */
export async function runMediaJob(options: MediaJobOptions): Promise<MediaJobOutcome> {
  const requestedSkus = orderUniqueSkus(options.requestedSkus);
  const results: MediaPrepareSkuResult[] = [];
  const unknown: string[] = [];
  const notStarted: string[] = [...requestedSkus];
  const errors: string[] = [];
  const counts = { uploaded: 0, reused: 0, recorded: 0, skipped_has_url: 0, failed: 0, unknown: 0, not_started: 0 };
  const activeSkus = options.skus.filter((row) => row.status === "active");
  const activeBySku = new Map(activeSkus.map((row) => [row.sku, row]));
  const latestBySku = new Map(options.latest.map((row) => [row.sku, row.stock_status]));
  const parentToChildren = new Map<string, readonly string[]>();
  if (options.config.sku_grouping?.enabled) {
    try {
      for (const group of groupSkuIds(activeSkus.map((row) => row.sku), options.config.sku_grouping.rule).groups) {
        parentToChildren.set(group.parent, group.children);
      }
    } catch {
      // Invalid grouping config must not prevent processing explicit child SKUs.
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const credential = options.credential?.username.trim() && options.credential.applicationPassword.trim()
    ? options.credential : undefined;
  let wordpressBase: URL | null = null;
  if (options.config.edm?.image_host?.type === "wordpress" && credential) {
    try { wordpressBase = parseWordPressBaseUrl(options.config, Boolean(options.allowLoopbackHttpForTests)); }
    catch { /* 转换型 SKU 会逐项报告配置错误；JPG/PNG 无需 WordPress 服务。 */ }
  }
  const ledger = [...options.mediaLedger];
  const isFirstNetworkRequest = { value: true };
  let stoppedByAuth: "WP_AUTH_FAILED" | "WP_FORBIDDEN" | undefined;
  let stopForUnknown = false;
  await writeMediaCheckpoint(options, "running", results, unknown, notStarted);
  for (const [index, requestedSku] of requestedSkus.entries()) {
    if (stoppedByAuth || stopForUnknown) break;
    notStarted.shift();
    unknown.push(requestedSku);
    await writeMediaCheckpoint(options, "running", results, unknown, notStarted, stoppedByAuth);
    const representativeSku = chooseRepresentative(requestedSku, activeBySku, parentToChildren, latestBySku);
    if (!representativeSku) {
      results.push({ sku: requestedSku, status: "failed", reason: "商品 SKU 不存在或已下架。" });
      unknown.pop();
      errors.push("部分商品 SKU 无法处理。");
      counts.failed += 1;
      await writeMediaCheckpoint(options, "running", results, unknown, notStarted, stoppedByAuth);
      options.onProgress?.(index + 1, requestedSkus.length);
      continue;
    }
    if (ledgerHasUrl(ledger, requestedSku) || ledgerHasUrl(ledger, representativeSku)) {
      results.push({ sku: requestedSku, status: "skipped_has_url" });
      unknown.pop();
      counts.skipped_has_url += 1;
      await writeMediaCheckpoint(options, "running", results, unknown, notStarted, stoppedByAuth);
      options.onProgress?.(index + 1, requestedSkus.length);
      continue;
    }
    const record = activeBySku.get(representativeSku);
    if (!record?.image_url) {
      results.push({ sku: requestedSku, status: "failed", reason: "没有可用的商品源图片。" });
      unknown.pop();
      errors.push("部分商品没有可用的源图片。");
      counts.failed += 1;
      await writeMediaCheckpoint(options, "running", results, unknown, notStarted, stoppedByAuth);
      options.onProgress?.(index + 1, requestedSkus.length);
      continue;
    }
    try {
      const outcome = await processSku(requestedSku, representativeSku, record, record.image_url, options,
        wordpressBase, credential, fetchImpl, ledger, isFirstNetworkRequest);
      results.push(outcome.result);
      unknown.pop();
      counts[outcome.result.status] += 1;
      if (outcome.stop) stoppedByAuth = outcome.stop;
      if (outcome.result.status === "failed") errors.push(outcome.result.reason ?? "部分商品图片处理失败。");
    } catch (error) {
      if (error instanceof MediaOperationError && error.kind === "unknown") {
        counts.unknown += 1;
        errors.push(error.message);
        stopForUnknown = true;
      } else {
        const failure = error instanceof MediaOperationError ? error.message : "商品图片处理失败。";
        results.push({ sku: requestedSku, status: "failed", reason: failure });
        unknown.pop();
        counts.failed += 1;
        errors.push(failure);
        if (error instanceof MediaOperationError && error.kind === "auth") stoppedByAuth = error.authCode;
      }
    }
    await writeMediaCheckpoint(options, "running", results, unknown, notStarted, stoppedByAuth);
    options.onProgress?.(index + 1, requestedSkus.length);
  }
  counts.not_started = notStarted.length;
  if (stoppedByAuth) errors.push(stoppedByAuth === "WP_AUTH_FAILED" ? "WordPress 应用密码认证失败，后续商品未开始处理。" : "WordPress 账号没有上传权限，后续商品未开始处理。");
  const hasFailure = counts.failed > 0 || unknown.length > 0 || notStarted.length > 0;
  const hasConfirmedSuccess = counts.uploaded + counts.reused + counts.recorded + counts.skipped_has_url > 0;
  const status = !hasFailure ? "ok" : hasConfirmedSuccess || unknown.length > 0 ? "partial" : "failed";
  await writeMediaCheckpoint(options, "finished", results, unknown, notStarted, stoppedByAuth);
  return {
    status,
    summary: status === "ok" ? "所选商品图片处理完成。" : status === "partial" ? "部分商品图片已处理，另有项目失败或结果待确认。" : "商品图片处理失败。",
    counts,
    media_requested_skus: requestedSkus,
    media_batch_state: unknown.length ? "outcome_unknown" : notStarted.length ? "interrupted" : "complete",
    media_results: results,
    media_unknown_skus: unknown,
    media_not_started_skus: notStarted,
    ...(stoppedByAuth ? { media_error_code: stoppedByAuth } : {}),
    ...(errors.length ? { errors: [...new Set(errors)] } : {}),
  };
}
