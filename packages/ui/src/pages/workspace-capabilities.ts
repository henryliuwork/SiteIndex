import { PENDING_HANDLERS, type SiteIndexApi } from "@siteindex/shared";

export interface WorkspaceCapabilities {
  wizardAvailable: boolean;
  emptyWorkspaceAvailable: boolean;
  importCheckAvailable: boolean;
  explainWizardUnavailable: boolean;
  explainEmptyWorkspaceUnavailable: boolean;
}

function methodAvailable(method: string, exists: boolean, isMockApi: boolean): boolean {
  return exists && (isMockApi || !PENDING_HANDLERS.includes(method));
}

/**
 * Desktop preload 可暴露尚未接通 handler 的 API 桩；真实应用只有退出 PENDING_HANDLERS 后才启用入口。
 * 浏览器 mock 仍完整开放工作区流程，用于独立开发和交互验收。
 */
export function getWorkspaceCapabilities(api: SiteIndexApi, isMockApi: boolean): WorkspaceCapabilities {
  const checkAvailable = methodAvailable("workspace.check", typeof api.workspace?.check === "function", isMockApi);
  const createAvailable = methodAvailable("workspace.create", typeof api.workspace?.create === "function", isMockApi);
  const createOnlyAvailable = methodAvailable("projects.createWorkspaceOnly", typeof api.projects.createWorkspaceOnly === "function", isMockApi);
  const importCheckAvailable = methodAvailable("workspace.importCheck", typeof api.workspace?.importCheck === "function", isMockApi);
  const wizardAvailable = checkAvailable && createAvailable;
  const emptyWorkspaceAvailable = checkAvailable && createOnlyAvailable;

  return {
    wizardAvailable,
    emptyWorkspaceAvailable,
    importCheckAvailable,
    explainWizardUnavailable: !isMockApi && !wizardAvailable,
    explainEmptyWorkspaceUnavailable: !isMockApi && !emptyWorkspaceAvailable,
  };
}
