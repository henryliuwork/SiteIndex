import type { SiteIndexApi, Unsubscribe } from "./api";

export const API_INVOKE_METHODS = [
  "updates.check",
  "updates.download",
  "updates.install",
  "app.version",
  "app.platform",
  "settings.get",
  "settings.set",
  "settings.detectBrowser",
  "settings.cliStatus",
  "settings.installCli",
  "settings.chooseDirectory",
  "settings.sendTestNotification",
  "settings.openLogs",
  "uiState.get",
  "uiState.set",
  "projects.list",
  "projects.get",
  "projects.detect",
  "projects.inspectFeed",
  "projects.create",
  "projects.addExisting",
  "projects.updateConfig",
  "overview.get",
  "inventory.summary",
  "inventory.listSkus",
  "inventory.dailyReport",
  "inventory.exportCsv",
  "products.list",
  "products.get",
  "products.setTags",
  "products.listTags",
  "products.createTag",
  "products.deleteTag",
  "products.exportCsv",
  "sku.previewGrouping",
  "seo.summary",
  "seo.listIssues",
  "seo.listPages",
  "seo.listLinks",
  "seo.orphanPages",
  "seo.getPage",
  "seo.googleSiteUrl",
  "seo.checkIndex",
  "content.summary",
  "content.listBlog",
  "content.listKeywords",
  "content.listDrafts",
  "edm.summary",
  "edm.listImages",
  "edm.setManualImage",
  "edm.buildCommand",
  "design.get",
  "readme.get",
  "readme.saveUserBlocks",
  "readme.refresh",
  "categories.get",
  "categories.preview",
  "categories.save",
  "folders.list",
  "folders.create",
  "folders.describe",
  "folders.remove",
  "folders.open",
  "files.lastReport",
  "files.validate",
  "files.repair",
  "jobs.run",
  "jobs.cancel",
  "jobs.history",
  "jobs.running",
  "schedule.get",
  "schedule.save",
  "schedule.status",
  "schedule.reauthorize",
  "runner.get",
  "runner.claim",
  "skills.list",
  "skills.get",
  "skills.targets",
  "skills.install",
  "skills.syncAllProjects",
  "shell.openPath",
  "shell.openExternal",
  "shell.copyText",
] as const;

export const API_EVENT_METHODS = [
  "projects.onChanged",
  "jobs.onProgress",
  "jobs.onFinished",
  "updates.onStatus",
] as const;

export const PENDING_HANDLERS: readonly string[] = ["sku.previewGrouping"];

export type ApiInvokeMethod = (typeof API_INVOKE_METHODS)[number];

type ApiMethodPaths<Api> = {
  [Namespace in keyof Api]-?: {
    [Method in keyof NonNullable<Api[Namespace]>]-?: NonNullable<NonNullable<Api[Namespace]>[Method]> extends (
      ...args: infer _Args
    ) => unknown
      ? `${Extract<Namespace, string>}.${Extract<Method, string>}`
      : never;
  }[keyof NonNullable<Api[Namespace]>];
}[keyof Api];

type ApiEventPaths<Api> = {
  [Namespace in keyof Api]-?: {
    [Method in keyof NonNullable<Api[Namespace]>]-?: NonNullable<NonNullable<Api[Namespace]>[Method]> extends (
      ...args: infer _Args
    ) => infer Result
      ? Result extends Unsubscribe
        ? `${Extract<Namespace, string>}.${Extract<Method, string>}`
        : never
      : never;
  }[keyof NonNullable<Api[Namespace]>];
}[keyof Api];

type Assert<T extends true> = T;
type IsExact<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

// SiteIndexApi 中的每个可调用方法必须且只能归入 invoke 或事件契约清单。
type ApiInvokeMethodsAreComplete = Assert<
  IsExact<Exclude<ApiMethodPaths<SiteIndexApi>, ApiEventPaths<SiteIndexApi>>, ApiInvokeMethod>
>;
type ApiEventMethodsAreComplete = Assert<IsExact<ApiEventPaths<SiteIndexApi>, ApiEventMethod>>;
type ApiMethodListsAreDisjoint = Assert<Extract<ApiInvokeMethod, ApiEventMethod> extends never ? true : false>;
export type ApiContractCoverage =
  | ApiInvokeMethodsAreComplete
  | ApiEventMethodsAreComplete
  | ApiMethodListsAreDisjoint;

export type ApiEventMethod = (typeof API_EVENT_METHODS)[number];
