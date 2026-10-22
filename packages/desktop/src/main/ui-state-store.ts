import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectId, ProjectUiState, SiteIndexError } from "@siteindex/shared";

type PageSize = 20 | 50 | 100;
type CacheDirectoryProvider = () => string | Promise<string>;

const PAGE_SIZES = new Set<number>([20, 50, 100]);
const INVALID_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function uiStateError(code: SiteIndexError["code"], message: string, detail?: string): SiteIndexError {
  return { code, message, ...(detail ? { detail } : {}) };
}

function emptyState(): ProjectUiState {
  return { columns: {}, page_sizes: {} };
}

function copyState(state: ProjectUiState): ProjectUiState {
  return {
    columns: Object.fromEntries(Object.entries(state.columns).map(([tableId, columns]) => [tableId, [...columns]])),
    page_sizes: { ...state.page_sizes },
  };
}

function normalizeState(value: unknown): ProjectUiState {
  if (!isRecord(value)) return emptyState();

  const columns: Record<string, string[]> = {};
  if (isRecord(value.columns)) {
    for (const [tableId, columnIds] of Object.entries(value.columns)) {
      if (tableId && Array.isArray(columnIds) && columnIds.every((columnId) => typeof columnId === "string")) {
        columns[tableId] = [...new Set(columnIds)];
      }
    }
  }

  const pageSizes: Record<string, PageSize> = {};
  if (isRecord(value.page_sizes)) {
    for (const [tableId, pageSize] of Object.entries(value.page_sizes)) {
      if (tableId && typeof pageSize === "number" && PAGE_SIZES.has(pageSize)) {
        pageSizes[tableId] = pageSize as PageSize;
      }
    }
  }

  return { columns, page_sizes: pageSizes };
}

function validateProjectId(value: unknown): asserts value is ProjectId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(value) ||
    /[. ]$/.test(value) ||
    INVALID_WINDOWS_NAME.test(value)
  ) {
    throw uiStateError("CONFIG_INVALID", "项目界面状态标识无效", String(value));
  }
}

function validatePatch(value: unknown): asserts value is Partial<ProjectUiState> {
  if (!isRecord(value)) throw uiStateError("CONFIG_INVALID", "界面状态更新格式无效");

  for (const key of Object.keys(value)) {
    if (key !== "columns" && key !== "page_sizes") {
      throw uiStateError("CONFIG_INVALID", `不支持修改界面状态字段 ${key}。`);
    }
  }

  if ("columns" in value) {
    if (!isRecord(value.columns)) throw uiStateError("CONFIG_INVALID", "columns 必须是表格列设置对象。");
    for (const [tableId, columnIds] of Object.entries(value.columns)) {
      if (!tableId || !Array.isArray(columnIds) || !columnIds.every((columnId) => typeof columnId === "string")) {
        throw uiStateError("CONFIG_INVALID", "columns 中的每张表必须对应字符串数组。", tableId);
      }
    }
  }

  if ("page_sizes" in value) {
    if (!isRecord(value.page_sizes)) throw uiStateError("CONFIG_INVALID", "page_sizes 必须是分页设置对象。");
    for (const [tableId, pageSize] of Object.entries(value.page_sizes)) {
      if (!tableId || typeof pageSize !== "number" || !PAGE_SIZES.has(pageSize)) {
        throw uiStateError("CONFIG_INVALID", "每页条数只能是 20、50 或 100。", tableId);
      }
    }
  }
}

function stateFilePath(cacheDirectory: string, projectId: ProjectId): string {
  if (typeof cacheDirectory !== "string" || !cacheDirectory.trim()) {
    throw uiStateError("CONFIG_INVALID", "缓存目录不能为空。");
  }

  const cacheRoot = resolve(cacheDirectory);
  const projectDirectory = resolve(cacheRoot, projectId);
  const relativeProjectPath = relative(cacheRoot, projectDirectory);
  if (
    !relativeProjectPath ||
    relativeProjectPath === ".." ||
    relativeProjectPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeProjectPath)
  ) {
    throw uiStateError("PATH_OUTSIDE_PROJECT", "项目界面状态路径超出缓存目录。", projectId);
  }
  return resolve(projectDirectory, "ui-state.json");
}

async function readState(filePath: string): Promise<ProjectUiState> {
  try {
    return normalizeState(JSON.parse(await readFile(filePath, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return emptyState();
    throw uiStateError("PROJECT_UNREADABLE", "无法读取本机界面状态。", String(error));
  }
}

async function writeAtomically(filePath: string, state: ProjectUiState): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;

  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporaryPath, filePath);
        return;
      } catch (error) {
        const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
        if (attempt >= 9 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200 * (attempt + 1)));
      }
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw uiStateError("WRITE_FAILED", "无法保存本机界面状态。", String(error));
  }
}

export interface UiStateStore {
  get(id: ProjectId): Promise<ProjectUiState>;
  set(id: ProjectId, patch: Partial<ProjectUiState>): Promise<ProjectUiState>;
}

export function createUiStateStore(getCacheDirectory: CacheDirectoryProvider): UiStateStore {
  const pendingWrites = new Map<string, Promise<ProjectUiState>>();

  async function getFilePath(id: ProjectId): Promise<string> {
    validateProjectId(id);
    return stateFilePath(await getCacheDirectory(), id);
  }

  return {
    async get(id) {
      return copyState(await readState(await getFilePath(id)));
    },
    async set(id, patch) {
      validatePatch(patch);
      const filePath = await getFilePath(id);
      const previous = pendingWrites.get(filePath);
      const operation = (previous ? previous.catch(() => emptyState()) : Promise.resolve(emptyState())).then(
        async () => {
          const current = await readState(filePath);
          const next: ProjectUiState = {
            columns: {
              ...current.columns,
              ...(patch.columns ? Object.fromEntries(
                Object.entries(patch.columns).map(([tableId, columnIds]) => [tableId, [...new Set(columnIds)]]),
              ) : {}),
            },
            page_sizes: { ...current.page_sizes, ...patch.page_sizes },
          };
          await writeAtomically(filePath, next);
          return copyState(next);
        },
      );
      pendingWrites.set(filePath, operation);
      void operation.then(
        () => { if (pendingWrites.get(filePath) === operation) pendingWrites.delete(filePath); },
        () => { if (pendingWrites.get(filePath) === operation) pendingWrites.delete(filePath); },
      );
      return operation;
    },
  };
}
