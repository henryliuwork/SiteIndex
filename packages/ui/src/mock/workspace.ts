import { pathsFor, type SiteIndexApi, type SiteIndexError, type WorkspaceCreateInput, type WorkspaceCreateResult, type WorkspaceImportIssue } from "@siteindex/shared";
import { reply } from "./context";

const workspacePaths = pathsFor("workspace");
const workspaceManifestPath = workspacePaths.index + "/workspace.json";
const workspaceMetadataIssue: WorkspaceImportIssue = {
  path: workspacePaths.site,
  code: "workspace_metadata_missing",
  message: "缺少 workspace 元数据，可通过安全修复补齐。",
  auto_fixable: true,
};
const workspaceMetadataInvalidIssue: WorkspaceImportIssue = {
  path: workspacePaths.site,
  code: "workspace_metadata_invalid",
  message: "site.json 的 workspace 字段格式无效，请手动检查。",
  auto_fixable: false,
};

const generatedWorkspaceFiles = [
  "README.md", "AGENTS.md", "CLAUDE.md", ".env", ".gitignore", "workspace.json",
  "01-brand/README.md", "02-products/README.md", "03-seo/README.md", "04-edm/README.md",
  "05-affiliate/README.md", "06-site-updates/README.md", "07-reports/README.md",
  "_outputs/README.md", "_archive/README.md", "_tmp/README.md",
  "_site-index/site.json", "_site-index/workspace.json", "_site-index/skills/manifest.json",
  "_site-index/skills/presets/esp.mailchimp.md",
];

function normalizeTarget(path: string): string {
  return path.trim().replaceAll("/", "\\").replace(/\\+/g, "\\").replace(/\\$/, "").toLocaleLowerCase();
}

function sortedEntries(entries: readonly string[]): string[] {
  return [...entries].sort((left, right) => left < right ? -1 : left > right ? 1 : 0).slice(0, 10);
}

export interface WorkspaceMock {
  api: NonNullable<SiteIndexApi["workspace"]>;
  createNow(input: WorkspaceCreateInput): WorkspaceCreateResult;
}

export function createWorkspaceMock(): WorkspaceMock {
  const createdByTarget = new Map<string, string[]>();
  const repairedImports = new Set<string>();

  const createNow = (input: WorkspaceCreateInput): WorkspaceCreateResult => {
    const path = input.targetDir.trim();
    const key = normalizeTarget(path);
    const existing = createdByTarget.get(key);
    if (existing?.length) {
      throw {
        code: "WORKSPACE_NOT_EMPTY",
        message: "目标目录不是空目录。请改选空目录；未覆盖任何已有内容。",
        detail: sortedEntries(existing).join(", "),
      } satisfies SiteIndexError;
    }
    if (!key) throw { code: "CONFIG_INVALID", message: "工作区目录无效，请选择一个项目文件夹。" } satisfies SiteIndexError;
    const created = [...generatedWorkspaceFiles];
    createdByTarget.set(key, created);
    return { path, created };
  };

  const api: NonNullable<SiteIndexApi["workspace"]> = {
    check: (targetDir) => reply(() => {
      const key = normalizeTarget(targetDir);
      if (!key) throw { code: "CONFIG_INVALID", message: "工作区目录无效，请选择一个项目文件夹。" } satisfies SiteIndexError;
      const invalid = sortedEntries(createdByTarget.get(key) ?? []);
      return { ok: invalid.length === 0, invalid_entries: invalid };
    }),
    create: (input) => reply(() => createNow(input)),
    importCheck: (id, options) => reply(() => {
      const projectId = String(id);
      if (projectId === "demo3") {
        return { issues: [workspaceMetadataInvalidIssue], repaired: [] };
      }
      if (projectId !== "demo2") {
        return {
          issues: [{
            path: workspacePaths.site,
            code: "workspace_config_missing",
            message: "找不到工作区数据目录中的 site.json。",
            auto_fixable: false,
          }],
          repaired: [],
        };
      }

      const wasRepaired = repairedImports.has(projectId);
      if (options?.apply && !wasRepaired) {
        repairedImports.add(projectId);
        return {
          issues: [],
          repaired: [workspacePaths.skuMedia, workspacePaths.site, workspaceManifestPath],
        };
      }
      if (wasRepaired) return { issues: [], repaired: [] };
      return {
        issues: [
          { path: workspacePaths.skuMedia, code: "missing_ledger", message: "缺少 SKU 媒体台账文件，可自动补齐空模板。", auto_fixable: true },
          workspaceMetadataIssue,
          { path: workspaceManifestPath, code: "workspace_manifest_missing", message: "缺少工作区路径映射文件 workspace.json。", auto_fixable: true },
        ],
        repaired: [],
      };
    }),
  };

  return { api, createNow };
}
