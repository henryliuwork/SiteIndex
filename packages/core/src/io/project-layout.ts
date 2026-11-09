import { access } from "node:fs/promises";
import path from "node:path";
import { pathsFor, type ProjectLayout, type ProjectPaths } from "@siteindex/shared";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function configExists(projectPath: string, relativePath: string): Promise<boolean> {
  const file = path.join(projectPath, relativePath);
  try {
    await access(file);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw Object.assign(new Error("无法检查项目配置文件。"), {
      code: "PROJECT_UNREADABLE" as const,
      detail: file,
    });
  }
}

/** 根据 site.json 的位置识别项目布局；workspace 路径优先。 */
export async function resolveProjectLayout(projectPath: string): Promise<ProjectLayout> {
  const project = path.resolve(projectPath);
  if (await configExists(project, pathsFor("workspace").site)) return "workspace";
  if (await configExists(project, pathsFor("legacy").site)) return "legacy";
  throw Object.assign(new Error("找不到项目配置文件 site.json。"), { code: "PROJECT_NOT_FOUND" as const });
}

/** 根据项目配置位置返回对应布局下的路径映射。 */
export async function pathsForProject(projectPath: string): Promise<ProjectPaths> {
  return pathsFor(await resolveProjectLayout(projectPath));
}

/** 尚未写入 site.json 的初始化步骤沿用 legacy 路径。 */
export async function resolveProjectLayoutOrLegacy(projectPath: string): Promise<ProjectLayout> {
  try {
    return await resolveProjectLayout(projectPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "PROJECT_NOT_FOUND") return "legacy";
    throw error;
  }
}
