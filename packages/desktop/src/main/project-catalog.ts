import { access, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { PATHS, type AppSettings, type ProjectId, type SiteIndexError } from "@siteindex/shared";

export interface ProjectPathEntry {
  id: ProjectId;
  path: string;
}

interface ProjectWatch {
  entry: ProjectPathEntry;
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
}

export interface ProjectCatalog {
  resolveProject(id: ProjectId): string;
  ensureProject(id: ProjectId, settings: AppSettings): Promise<ProjectPathEntry>;
  refresh(settings: AppSettings): Promise<ProjectPathEntry[]>;
  resolveExistingPath(value: string): Promise<string>;
  close(): Promise<void>;
}

function catalogError(code: SiteIndexError["code"], message: string, detail?: string): SiteIndexError {
  return { code, message, ...(detail ? { detail } : {}) };
}

function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isChildPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readProjectDirectory(value: string): Promise<string | null> {
  let absolutePath: string;
  try {
    absolutePath = await realpath(path.resolve(value));
    if (!(await stat(absolutePath)).isDirectory()) return null;
    if (!(await stat(path.join(absolutePath, PATHS.site))).isFile()) return null;
    await access(path.join(absolutePath, PATHS.site));
    return absolutePath;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw catalogError("PROJECT_UNREADABLE", "无法读取项目目录。", `${value}: ${String(error)}`);
  }
}

export function createProjectCatalog(
  invalidate: (projectPath: string) => void,
  onChanged: (id: ProjectId) => void,
): ProjectCatalog {
  const paths = new Map<ProjectId, string>();
  const watches = new Map<string, ProjectWatch>();

  function resolveProject(id: ProjectId): string {
    const projectPath = paths.get(id);
    if (!projectPath) throw catalogError("PROJECT_NOT_FOUND", "找不到指定项目。", id);
    return projectPath;
  }

  function startWatch(entry: ProjectPathEntry): Promise<void> {
    const key = pathKey(entry.path);
    if (watches.has(key)) return Promise.resolve();

    const watcher = watch([path.join(entry.path, PATHS.index), path.join(entry.path, PATHS.readme)], {
      ignoreInitial: true,
      atomic: true,
    });
    const projectWatch: ProjectWatch = { entry, watcher, timer: null };
    watches.set(key, projectWatch);

    watcher.on("all", () => {
      if (projectWatch.timer) clearTimeout(projectWatch.timer);
      projectWatch.timer = setTimeout(() => {
        projectWatch.timer = null;
        if (watches.get(key) !== projectWatch) return;
        invalidate(entry.path);
        onChanged(entry.id);
      }, 1_000);
    });
    let ready = false;
    const readyPromise = new Promise<void>((resolveReady) => {
      watcher.once("ready", () => {
        ready = true;
        resolveReady();
      });
      watcher.on("error", (error) => {
        console.warn("SiteIndex 项目文件监听失败。", error instanceof Error ? error.message : String(error));
        if (!ready) {
          ready = true;
          resolveReady();
        }
      });
    });
    return readyPromise;
  }

  async function stopWatch(key: string, projectWatch: ProjectWatch): Promise<void> {
    if (projectWatch.timer) clearTimeout(projectWatch.timer);
    projectWatch.timer = null;
    watches.delete(key);
    await projectWatch.watcher.close();
  }

  async function refresh(settings: AppSettings): Promise<ProjectPathEntry[]> {
    const candidates: string[] = [];
    if (settings.projects_root.trim()) {
      try {
        const children = await readdir(settings.projects_root, { withFileTypes: true });
        for (const child of children) {
          if (child.isDirectory()) candidates.push(path.join(settings.projects_root, child.name));
        }
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw catalogError(
            "PROJECT_UNREADABLE",
            "无法扫描项目根目录。",
            `${settings.projects_root}: ${String(error)}`,
          );
        }
      }
    }
    candidates.push(...settings.extra_projects);

    const byPath = new Map<string, ProjectPathEntry>();
    const byId = new Map<ProjectId, string>();
    for (const candidate of candidates) {
      const projectPath = await readProjectDirectory(candidate);
      if (!projectPath) continue;
      const key = pathKey(projectPath);
      if (byPath.has(key)) continue;

      const id = path.basename(projectPath);
      const idKey = process.platform === "win32" ? id.toLowerCase() : id;
      const existingPath = byId.get(idKey);
      if (existingPath && pathKey(existingPath) !== key) {
        throw catalogError("CONFIG_INVALID", "项目文件夹名称重复，无法生成唯一项目标识。", id);
      }
      byId.set(idKey, projectPath);
      byPath.set(key, { id, path: projectPath });
    }

    const entries = [...byPath.values()].sort((left, right) => compareIds(left.id, right.id));
    paths.clear();
    for (const entry of entries) paths.set(entry.id, entry.path);

    const currentKeys = new Set(entries.map((entry) => pathKey(entry.path)));
    await Promise.all(
      [...watches].map(([key, projectWatch]) =>
        currentKeys.has(key) ? Promise.resolve() : stopWatch(key, projectWatch),
      ),
    );
    await Promise.all(entries.map(startWatch));
    return entries;
  }

  return {
    resolveProject,
    async ensureProject(id, settings) {
      const existingPath = paths.get(id);
      if (existingPath) return { id, path: existingPath };
      await refresh(settings);
      const projectPath = paths.get(id);
      if (!projectPath) throw catalogError("PROJECT_NOT_FOUND", "找不到指定项目。", id);
      return { id, path: projectPath };
    },
    refresh,
    async resolveExistingPath(value) {
      if (!value.trim()) throw catalogError("PROJECT_NOT_FOUND", "请选择有效的项目目录。", value);
      const projectPath = await readProjectDirectory(value);
      if (!projectPath) throw catalogError("PROJECT_NOT_FOUND", "所选目录不是有效的 SiteIndex 项目。", value);
      return projectPath;
    },
    async close() {
      await Promise.all([...watches].map(([key, projectWatch]) => stopWatch(key, projectWatch)));
      paths.clear();
    },
  };
}

export function isProjectInsideRoot(projectsRoot: string, projectPath: string): boolean {
  if (!projectsRoot.trim()) return false;
  const relative = path.relative(path.resolve(projectsRoot), path.resolve(projectPath));
  return isChildPath(path.resolve(projectsRoot), path.resolve(projectPath)) && !relative.includes(path.sep);
}
