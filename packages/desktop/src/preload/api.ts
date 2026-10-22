import type { SiteIndexApi, Unsubscribe } from "@siteindex/shared";
import { ipcChannel } from "../shared/ipc-contract.js";

export interface IpcTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  listen(channel: string, listener: (payload: unknown) => void): Unsubscribe;
}

const IPC_ERROR_PREFIX = "__SITEINDEX_IPC_ERROR__:";
type UiStateApi = NonNullable<SiteIndexApi["uiState"]>;

function decodeIpcError(error: unknown): unknown {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : null;
  if (!message?.startsWith(IPC_ERROR_PREFIX)) return error;

  try {
    return JSON.parse(message.slice(IPC_ERROR_PREFIX.length)) as unknown;
  } catch {
    return { code: "UNKNOWN", message: "桌面服务返回了无效错误信息" };
  }
}

export function createApiBridge(transport: IpcTransport): SiteIndexApi {
  const invoke = <Method extends (...args: never[]) => Promise<unknown>>(
    method: string,
    ...args: Parameters<Method>
  ): ReturnType<Method> =>
    transport
      .invoke(ipcChannel(method), ...args)
      .catch((error: unknown) => Promise.reject(decodeIpcError(error))) as ReturnType<Method>;

  const listen = <Payload>(method: string, callback: (payload: Payload) => void): Unsubscribe =>
    transport.listen(ipcChannel(method), (payload) => callback(payload as Payload));

  const api = {
    app: {
      version: () => invoke<SiteIndexApi["app"]["version"]>("app.version"),
      platform: () => invoke<SiteIndexApi["app"]["platform"]>("app.platform"),
    },
    settings: {
      get: () => invoke<SiteIndexApi["settings"]["get"]>("settings.get"),
      set: (...args) => invoke<SiteIndexApi["settings"]["set"]>("settings.set", ...args),
      detectBrowser: () => invoke<SiteIndexApi["settings"]["detectBrowser"]>("settings.detectBrowser"),
      cliStatus: () => invoke<SiteIndexApi["settings"]["cliStatus"]>("settings.cliStatus"),
      installCli: () => invoke<SiteIndexApi["settings"]["installCli"]>("settings.installCli"),
      chooseDirectory: (...args) =>
        invoke<SiteIndexApi["settings"]["chooseDirectory"]>("settings.chooseDirectory", ...args),
    },
    uiState: {
      get: (...args) => invoke<UiStateApi["get"]>("uiState.get", ...args),
      set: (...args) => invoke<UiStateApi["set"]>("uiState.set", ...args),
    },
    projects: {
      list: () => invoke<SiteIndexApi["projects"]["list"]>("projects.list"),
      get: (...args) => invoke<SiteIndexApi["projects"]["get"]>("projects.get", ...args),
      detect: (...args) => invoke<SiteIndexApi["projects"]["detect"]>("projects.detect", ...args),
      inspectFeed: (...args) => invoke<SiteIndexApi["projects"]["inspectFeed"]>("projects.inspectFeed", ...args),
      create: (...args) => invoke<SiteIndexApi["projects"]["create"]>("projects.create", ...args),
      addExisting: (...args) => invoke<SiteIndexApi["projects"]["addExisting"]>("projects.addExisting", ...args),
      updateConfig: (...args) => invoke<SiteIndexApi["projects"]["updateConfig"]>("projects.updateConfig", ...args),
      onChanged: (callback) => listen("projects.onChanged", callback),
    },
    overview: {
      get: (...args) => invoke<SiteIndexApi["overview"]["get"]>("overview.get", ...args),
    },
    inventory: {
      summary: (...args) => invoke<SiteIndexApi["inventory"]["summary"]>("inventory.summary", ...args),
      listSkus: (...args) => invoke<SiteIndexApi["inventory"]["listSkus"]>("inventory.listSkus", ...args),
      dailyReport: (...args) => invoke<SiteIndexApi["inventory"]["dailyReport"]>("inventory.dailyReport", ...args),
      exportCsv: (...args) => invoke<SiteIndexApi["inventory"]["exportCsv"]>("inventory.exportCsv", ...args),
    },
    products: {
      list: (...args) => invoke<SiteIndexApi["products"]["list"]>("products.list", ...args),
      get: (...args) => invoke<SiteIndexApi["products"]["get"]>("products.get", ...args),
      setTags: (...args) => invoke<SiteIndexApi["products"]["setTags"]>("products.setTags", ...args),
      listTags: (...args) => invoke<SiteIndexApi["products"]["listTags"]>("products.listTags", ...args),
      createTag: (...args) => invoke<SiteIndexApi["products"]["createTag"]>("products.createTag", ...args),
      deleteTag: (...args) => invoke<SiteIndexApi["products"]["deleteTag"]>("products.deleteTag", ...args),
      exportCsv: (...args) => invoke<SiteIndexApi["products"]["exportCsv"]>("products.exportCsv", ...args),
    },
    seo: {
      summary: (...args) => invoke<SiteIndexApi["seo"]["summary"]>("seo.summary", ...args),
      listIssues: (...args) => invoke<SiteIndexApi["seo"]["listIssues"]>("seo.listIssues", ...args),
      listPages: (...args) => invoke<SiteIndexApi["seo"]["listPages"]>("seo.listPages", ...args),
      listLinks: (...args) => invoke<SiteIndexApi["seo"]["listLinks"]>("seo.listLinks", ...args),
      orphanPages: (...args) => invoke<SiteIndexApi["seo"]["orphanPages"]>("seo.orphanPages", ...args),
      getPage: (...args) => invoke<SiteIndexApi["seo"]["getPage"]>("seo.getPage", ...args),
      googleSiteUrl: (...args) => invoke<SiteIndexApi["seo"]["googleSiteUrl"]>("seo.googleSiteUrl", ...args),
      checkIndex: (...args) => invoke<SiteIndexApi["seo"]["checkIndex"]>("seo.checkIndex", ...args),
    },
    content: {
      summary: (...args) => invoke<SiteIndexApi["content"]["summary"]>("content.summary", ...args),
      listBlog: (...args) => invoke<SiteIndexApi["content"]["listBlog"]>("content.listBlog", ...args),
      listKeywords: (...args) => invoke<SiteIndexApi["content"]["listKeywords"]>("content.listKeywords", ...args),
      listDrafts: (...args) => invoke<SiteIndexApi["content"]["listDrafts"]>("content.listDrafts", ...args),
    },
    edm: {
      summary: (...args) => invoke<SiteIndexApi["edm"]["summary"]>("edm.summary", ...args),
      listImages: (...args) => invoke<SiteIndexApi["edm"]["listImages"]>("edm.listImages", ...args),
      setManualImage: (...args) => invoke<SiteIndexApi["edm"]["setManualImage"]>("edm.setManualImage", ...args),
      buildCommand: (...args) => invoke<SiteIndexApi["edm"]["buildCommand"]>("edm.buildCommand", ...args),
    },
    design: {
      get: (...args) => invoke<SiteIndexApi["design"]["get"]>("design.get", ...args),
    },
    readme: {
      get: (...args) => invoke<SiteIndexApi["readme"]["get"]>("readme.get", ...args),
      saveUserBlocks: (...args) => invoke<SiteIndexApi["readme"]["saveUserBlocks"]>("readme.saveUserBlocks", ...args),
      refresh: (...args) => invoke<SiteIndexApi["readme"]["refresh"]>("readme.refresh", ...args),
    },
    categories: {
      get: (...args) => invoke<SiteIndexApi["categories"]["get"]>("categories.get", ...args),
      preview: (...args) => invoke<SiteIndexApi["categories"]["preview"]>("categories.preview", ...args),
      save: (...args) => invoke<SiteIndexApi["categories"]["save"]>("categories.save", ...args),
    },
    folders: {
      list: (...args) => invoke<SiteIndexApi["folders"]["list"]>("folders.list", ...args),
      create: (...args) => invoke<SiteIndexApi["folders"]["create"]>("folders.create", ...args),
      describe: (...args) => invoke<SiteIndexApi["folders"]["describe"]>("folders.describe", ...args),
      remove: (...args) => invoke<SiteIndexApi["folders"]["remove"]>("folders.remove", ...args),
      open: (...args) => invoke<SiteIndexApi["folders"]["open"]>("folders.open", ...args),
    },
    files: {
      lastReport: (...args) => invoke<SiteIndexApi["files"]["lastReport"]>("files.lastReport", ...args),
      validate: (...args) => invoke<SiteIndexApi["files"]["validate"]>("files.validate", ...args),
      repair: (...args) => invoke<SiteIndexApi["files"]["repair"]>("files.repair", ...args),
    },
    jobs: {
      run: (...args) => invoke<SiteIndexApi["jobs"]["run"]>("jobs.run", ...args),
      cancel: (...args) => invoke<SiteIndexApi["jobs"]["cancel"]>("jobs.cancel", ...args),
      history: (...args) => invoke<SiteIndexApi["jobs"]["history"]>("jobs.history", ...args),
      running: (...args) => invoke<SiteIndexApi["jobs"]["running"]>("jobs.running", ...args),
      onProgress: (callback) => listen("jobs.onProgress", callback),
      onFinished: (callback) => listen("jobs.onFinished", callback),
    },
    schedule: {
      get: (...args) => invoke<SiteIndexApi["schedule"]["get"]>("schedule.get", ...args),
      save: (...args) => invoke<SiteIndexApi["schedule"]["save"]>("schedule.save", ...args),
    },
    runner: {
      get: (...args) => invoke<SiteIndexApi["runner"]["get"]>("runner.get", ...args),
      claim: (...args) => invoke<SiteIndexApi["runner"]["claim"]>("runner.claim", ...args),
    },
    skills: {
      list: () => invoke<SiteIndexApi["skills"]["list"]>("skills.list"),
      get: (...args) => invoke<SiteIndexApi["skills"]["get"]>("skills.get", ...args),
      targets: (...args) => invoke<SiteIndexApi["skills"]["targets"]>("skills.targets", ...args),
      install: (...args) => invoke<SiteIndexApi["skills"]["install"]>("skills.install", ...args),
      syncAllProjects: () => invoke<SiteIndexApi["skills"]["syncAllProjects"]>("skills.syncAllProjects"),
    },
    shell: {
      openPath: (...args) => invoke<SiteIndexApi["shell"]["openPath"]>("shell.openPath", ...args),
      openExternal: (...args) => invoke<SiteIndexApi["shell"]["openExternal"]>("shell.openExternal", ...args),
      copyText: (...args) => invoke<SiteIndexApi["shell"]["copyText"]>("shell.copyText", ...args),
    },
  } satisfies SiteIndexApi;

  return api;
}
