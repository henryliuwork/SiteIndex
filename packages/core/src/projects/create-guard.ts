import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteIndexErrorCode } from "@siteindex/shared";
import { compareKeys } from "../io/compare";
import { CoreIOError, withLock } from "../io/runner-lock";

export interface RegisteredProjectPath {
  id: string;
  path: string;
}

function guardError(code: SiteIndexErrorCode, message: string, detail?: string) {
  return Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });
}

export function normalizeSiteDomain(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/^www\./u, "").replace(/\.$/u, "");
  } catch {
    return null;
  }
}

function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function scanProjectRoot(projectsRoot: string): Promise<RegisteredProjectPath[]> {
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw guardError("PROJECT_UNREADABLE", "无法检查已登记项目，暂不能创建新项目。", projectsRoot);
  }

  const projects: RegisteredProjectPath[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(projectsRoot, entry.name);
    try {
      await access(path.join(projectPath, PATHS.site));
      projects.push({ id: entry.name, path: projectPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw guardError("PROJECT_UNREADABLE", "无法检查已登记项目，暂不能创建新项目。", projectPath);
      }
    }
  }
  return projects;
}

async function domainFromSiteFile(project: RegisteredProjectPath): Promise<string> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(project.path, PATHS.site), "utf8"));
  } catch {
    throw guardError("PROJECT_UNREADABLE", "无法读取已登记项目配置，暂不能创建新项目。", project.path);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw guardError("CONFIG_INVALID", "已登记项目配置格式无效，暂不能验证重复站点。", project.path);
  }
  const domain = normalizeSiteDomain("domain" in value && typeof value.domain === "string" ? value.domain : "");
  if (!domain) {
    throw guardError("CONFIG_INVALID", "已登记项目的站点域名无效，暂不能验证重复站点。", project.path);
  }
  return domain;
}

/** Fail closed if a registered project cannot be inspected. */
export async function assertSiteNotRegistered(
  siteDomain: string,
  projectsRoot: string,
  listRegisteredProjects?: () => Promise<readonly RegisteredProjectPath[]>,
): Promise<void> {
  const canonicalDomain = normalizeSiteDomain(siteDomain);
  if (!canonicalDomain) throw guardError("CONFIG_INVALID", "无法识别网站域名，暂不能创建项目。", siteDomain);

  const entries = listRegisteredProjects
    ? [...await listRegisteredProjects()]
    : await scanProjectRoot(path.resolve(projectsRoot));
  const uniqueEntries = new Map<string, RegisteredProjectPath>();
  for (const entry of entries) uniqueEntries.set(pathKey(entry.path), entry);

  const sortedEntries = [...uniqueEntries.values()].sort((left, right) =>
    compareKeys(pathKey(left.path), pathKey(right.path)) || compareKeys(left.id, right.id));
  const domains = await Promise.all(sortedEntries.map(async (entry) => ({
    project: entry,
    domain: await domainFromSiteFile(entry),
  })));
  const duplicate = domains.find((entry) => entry.domain === canonicalDomain);
  if (duplicate) {
    throw guardError(
      "FOLDER_EXISTS",
      `这个网站已经登记在项目“${duplicate.project.id}”中，不能重复创建。请打开现有项目。`,
      duplicate.project.path,
    );
  }
}

/** Serialize creates for one canonical host across Core instances on this machine. */
export async function withSiteCreateLock<T>(siteDomain: string, fn: () => Promise<T>): Promise<T> {
  const canonicalDomain = normalizeSiteDomain(siteDomain);
  if (!canonicalDomain) throw guardError("CONFIG_INVALID", "无法识别网站域名，暂不能创建项目。", siteDomain);
  const key = createHash("sha256").update(canonicalDomain).digest("hex");
  const lockProject = path.join(os.tmpdir(), "siteindex-create-locks", key);
  try {
    return await withLock(lockProject, fn, { job: "project-create" });
  } catch (error) {
    if (error instanceof CoreIOError && error.code === "LOCKED") {
      throw new CoreIOError("LOCKED", "同一网站正在创建，请稍后刷新项目列表。", error.exitCode);
    }
    throw error;
  }
}
