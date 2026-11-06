import type { SiteIndexApi, SiteIndexError, WorkspaceCreateInput, WorkspaceCreateResult } from "@siteindex/shared";
import { reply } from "./context";

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

export interface WorkspaceMock {
  api: NonNullable<SiteIndexApi["workspace"]>;
  createNow(input: WorkspaceCreateInput): WorkspaceCreateResult;
}

export function createWorkspaceMock(): WorkspaceMock {
  const createdByTarget = new Map<string, string[]>();

  const createNow = (input: WorkspaceCreateInput): WorkspaceCreateResult => {
    const path = input.targetDir.trim();
    const key = normalizeTarget(path);
    const existing = createdByTarget.get(key);
    if (existing?.length) {
      const names = existing.slice(0, 10).join("、");
      throw { code: "WORKSPACE_NOT_EMPTY", message: `目标目录不是空目录：${names}` } satisfies SiteIndexError;
    }
    if (!key) throw { code: "UNKNOWN", message: "请选择工作区目录。" } satisfies SiteIndexError;
    const created = [...generatedWorkspaceFiles];
    createdByTarget.set(key, created);
    return { path, created };
  };

  const api: NonNullable<SiteIndexApi["workspace"]> = {
    check: (targetDir) => reply(() => {
      const key = normalizeTarget(targetDir);
      if (!key) return { ok: false, invalid_entries: ["请选择工作区目录。"] };
      const invalid = createdByTarget.get(key)?.slice(0, 10) ?? [];
      return { ok: invalid.length === 0, invalid_entries: invalid };
    }),
    create: (input) => reply(() => createNow(input)),
    importCheck: () => reply({ issues: [], repaired: [] }),
  };

  return { api, createNow };
}
