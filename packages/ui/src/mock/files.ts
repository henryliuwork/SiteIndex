import type { FileCheck, RepairAction, SiteIndexApi } from "@siteindex/shared";
import { clone, fileReports, projectKey, reply, summarizeFileChecks } from "./context";

export function createFilesMock(): SiteIndexApi["files"] {
  return {
    lastReport: (id) => reply(() => clone(fileReports[projectKey(id)])),
    validate: (id, path) => reply(() => {
      const key = projectKey(id);
      const report = fileReports[key];
      const files = path ? report.files.filter((file) => file.path === path) : report.files;
      return { checked_at: new Date().toISOString(), trigger: "manual", summary: summarizeFileChecks(files), files: clone(files) };
    }),
    repair: (id, path, action: RepairAction) => reply(() => {
      const key = projectKey(id);
      const report = fileReports[key];
      const current = report.files.find((file) => file.path === path);
      if (!current) throw new Error("找不到文件记录：" + path);
      const repaired: FileCheck = { ...current, status: "ok", rule: null, message: "模拟修复完成：" + action, repair: null };
      const files = action === "delete_copy" ? report.files.filter((file) => file.path !== path) : report.files.map((file) => file.path === path ? repaired : file);
      fileReports[key] = { ...report, checked_at: new Date().toISOString(), trigger: "manual", summary: summarizeFileChecks(files), files };
      return repaired;
    }),
  };
}
