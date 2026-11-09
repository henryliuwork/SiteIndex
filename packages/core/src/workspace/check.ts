import { readdir } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceCheckResult } from "@siteindex/shared";
import { compareKeys } from "../io/compare";

const IGNORED_ENTRY_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function workspaceError(code: "CONFIG_INVALID" | "PROJECT_UNREADABLE", message: string, detail?: string) {
  return Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });
}

export function resolveWorkspaceTarget(targetDir: string): string {
  const target = path.resolve(targetDir);
  if (!targetDir.trim() || target === path.parse(target).root) {
    throw workspaceError("CONFIG_INVALID", "工作区目录无效，请选择一个项目文件夹。", targetDir);
  }
  return target;
}

function isIgnoredEntry(name: string): boolean {
  return name.toLowerCase() === ".git" || IGNORED_ENTRY_NAMES.has(name.toLowerCase());
}

/** 检查目标目录是否为空；忽略 Git 与常见系统文件，只返回前 10 个冲突项。 */
export async function checkWorkspaceTarget(targetDir: string): Promise<WorkspaceCheckResult> {
  const target = resolveWorkspaceTarget(targetDir);
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, invalid_entries: [] };
    throw workspaceError("PROJECT_UNREADABLE", "无法检查工作区目录。", target);
  }
  const invalidEntries = entries
    .filter((entry) => !isIgnoredEntry(entry.name))
    .map((entry) => entry.name)
    .sort(compareKeys);
  return { ok: invalidEntries.length === 0, invalid_entries: invalidEntries.slice(0, 10) };
}
