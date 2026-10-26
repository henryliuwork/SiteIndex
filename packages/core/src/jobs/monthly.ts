import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { compareKeys } from "../io/compare";
import type { BrowserLauncher } from "../browser/automation";
import { detectSiteDetailed } from "../projects/detect";
import { runDesign } from "./design";

export type MonthlyStep = "metadata" | "design" | "archive";

export interface MonthlyJobOptions {
  projectPath: string;
  config: SiteConfig;
  date: string;
  executablePath: string;
  launchBrowser: BrowserLauncher;
  onProgress?: (step: MonthlyStep, message: string) => void;
}

export interface MonthlyJobResult {
  sitemaps: number;
  total_urls: number;
  design_pages: number;
  screenshots: number;
  archived_files: number;
  archived_bytes: number;
}

function siteError(code: "BROWSER_UNAVAILABLE", message: string) {
  return { code, message };
}

function archiveMonth(date: string): string {
  return date.slice(0, 7);
}

async function archiveIndex(projectPath: string, month: string): Promise<{ files: number; bytes: number }> {
  const root = path.resolve(projectPath);
  const indexRoot = path.join(root, PATHS.index);
  const files: { absolute: string; relative: string }[] = [];

  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareKeys(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === PATHS.lock || relative === PATHS.runner || relative === PATHS.archiveDir || relative.startsWith(`${PATHS.archiveDir}/`)) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push({ absolute, relative });
    }
  };

  await visit(indexRoot);
  let bytes = 0;
  for (const file of files) {
    const contents = await readFile(file.absolute);
    bytes += contents.byteLength;
    const archivePath = path.join(root, PATHS.archiveDir, month, `${file.relative}.gz`);
    await atomicWrite(archivePath, gzipSync(contents));
  }
  return { files: files.length, bytes };
}

/** 每月刷新站点元信息、设计采样，并保存可供校验修复使用的压缩快照。 */
export async function runMonthly(options: MonthlyJobOptions): Promise<MonthlyJobResult> {
  if (!options.executablePath.trim()) {
    throw siteError("BROWSER_UNAVAILABLE", "请由调用方提供 Chrome 或 Edge 的 executablePath。");
  }

  options.onProgress?.("metadata", "正在刷新 robots、sitemap 与站点技术信息");
  const detection = await detectSiteDetailed(options.config.base_url);
  const site = detection.result;
  const sitemapUrls = site.robots.sitemaps.length
    ? site.robots.sitemaps
    : options.config.sitemaps;
  await Promise.all([
    atomicWrite(path.join(options.projectPath, PATHS.robots), detection.robotsText),
    atomicWrite(path.join(options.projectPath, PATHS.sitemapsSummary), `${JSON.stringify({
      sitemaps: sitemapUrls,
      inspected: site.sitemaps,
      total_urls: site.total_urls,
    }, null, 2)}\n`),
    atomicWrite(path.join(options.projectPath, PATHS.tech), `${JSON.stringify({
      platform: site.platform,
      frontend: site.frontend,
    }, null, 2)}\n`),
  ]);

  options.onProgress?.("design", "正在提取首页、分类页和产品页设计信息");
  const design = await runDesign({
    projectPath: options.projectPath,
    config: options.config,
    executablePath: options.executablePath,
    launchBrowser: options.launchBrowser,
  });

  options.onProgress?.("archive", "正在压缩归档项目索引数据");
  const archive = await archiveIndex(options.projectPath, archiveMonth(options.date));
  return {
    sitemaps: sitemapUrls.length,
    total_urls: site.total_urls,
    design_pages: design.targets,
    screenshots: design.screenshots,
    archived_files: archive.files,
    archived_bytes: archive.bytes,
  };
}
