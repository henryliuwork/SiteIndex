import { app, dialog, ipcMain, Notification, safeStorage, utilityProcess } from "electron";
import electronUpdater from "electron-updater";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createCoreService, type CoreService, type CoreServiceContext } from "@siteindex/core";
import { EXIT, SCHEDULABLE_JOBS, type AppSettings, type ProjectId } from "@siteindex/shared";
import { chooseDirectory, registerIpcHandlers } from "./ipc.js";
import { createJobManager, type JobManagerOptions } from "./job-manager.js";
import { completeInitSchedule } from "./init-schedule.js";
import { showJobNotification } from "./notifications.js";
import { createProjectCatalog, type ProjectCatalog } from "./project-catalog.js";
import { parseRunJobArguments } from "./run-job-args.js";
import { createWindowThenReconcileInBackground } from "./startup-reconciliation.js";
import { createResidentScheduler, type ResidentScheduler } from "./scheduler/resident-scheduler.js";
import { calculateNextRuns, createSystemScheduler, type ScheduleRuntimeStatus } from "./scheduler/schedule.js";
import { createScheduleReconciliationQueue } from "./scheduler/reconciliation-queue.js";
import { createSkillService } from "./skill-service.js";
import { createDesktopIntegrations } from "./desktop-integrations.js";
import { createSettingsStore } from "./settings-store.js";
import {
  createAddExistingTraceWriter,
  type AddExistingTimingCallback,
  type AddExistingTracePhase,
} from "./add-existing-trace.js";
import { createUiStateStore } from "./ui-state-store.js";
import { createUpdateService } from "./update-service.js";
import { createWindowManager } from "./window-manager.js";
import { backgroundPolicy, type BackgroundPolicy } from "./background-policy.js";
import { backgroundSchedulerArgument, createAppTray, updateLoginAutostart, type AppTray } from "./app-background.js";
import { registerWordPressCredentialHandlers } from "./wordpress-credential-ipc.js";
import { createWordPressCredentialVault } from "./wordpress-credential-vault.js";

const isRunJob = process.argv.includes("--run-job");
const hasSingleInstanceLock = isRunJob || app.requestSingleInstanceLock();
const mainDirectory = dirname(fileURLToPath(import.meta.url));
const fallbackPath = resolve(mainDirectory, "../renderer/fallback.html");
const devUiUrl = process.env.SITEINDEX_UI_URL ?? "http://localhost:5173";
let projectCatalog: ProjectCatalog | null = null;
let isShuttingDown = false;
let launchHidden = process.platform === "win32" && process.argv.includes(backgroundSchedulerArgument);
let systemTray: AppTray | null = null;
let residentScheduler: ResidentScheduler | null = null;
let scheduleMode: ScheduleRuntimeStatus["mode"] = "system";
let startupScheduleReconciliation: Promise<ScheduleRuntimeStatus> | null = null;
let currentBackgroundPolicy: BackgroundPolicy = backgroundPolicy({}, "system", process.platform, false);
let requestQuit = (): void => app.quit();
const windowManager = createWindowManager({
  mainDirectory,
  fallbackPath,
  devUiUrl,
  initiallyHidden: launchHidden,
  shouldHideOnClose: () => currentBackgroundPolicy.hideOnClose && Boolean(systemTray),
  isShuttingDown: () => isShuttingDown,
  requestQuit: () => requestQuit(),
});

async function measureAddExistingPhase<T>(
  phase: AddExistingTracePhase,
  onTiming: AddExistingTimingCallback | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!onTiming) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    onTiming(phase, performance.now() - startedAt);
  }
}

if (process.platform === "win32") app.setAppUserModelId("com.siteindex.desktop");

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (isRunJob || commandLine.includes(backgroundSchedulerArgument)) return;
    windowManager.showMainWindow();
  });

  app.whenReady().then(async () => {
    const settingsStore = createSettingsStore(join(app.getPath("appData"), "SiteIndex"));
    const wordpressCredentialVault = createWordPressCredentialVault({
      platform: process.platform,
      localAppData: process.env.LOCALAPPDATA,
      homeDirectory: app.getPath("home"),
      safeStorage: {
        isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
        encryptStringAsync: (plainText) => safeStorage.encryptStringAsync(plainText),
        decryptStringAsync: (encrypted) => safeStorage.decryptStringAsync(encrypted),
      },
    });
    registerWordPressCredentialHandlers(
      (channel, listener) => ipcMain.handle(channel, async (event, ...args) => listener(event, ...args)),
      {
        vault: wordpressCredentialVault,
        isTrustedSender: (sender) => sender === windowManager.getMainWindow()?.webContents,
      },
    );
    const scheduler = createSystemScheduler({
      executablePath: app.getPath("exe"),
      runtimeStatePath: join(app.getPath("userData"), "schedule-runtime-state.json"),
      beforeElevation: async () => {
        const prompt = {
          type: "info" as const,
          title: "需要管理员授权",
          message: "注册系统定时任务需要管理员授权一次。",
          detail: "点击“继续”后会显示 Windows 用户帐户控制窗口；如果拒绝授权，SiteIndex 会改用软件常驻调度器。",
          buttons: ["继续"],
          defaultId: 0,
        };
        const window = windowManager.getMainWindow();
        if (window && !window.isDestroyed()) await dialog.showMessageBox(window, prompt);
        else await dialog.showMessageBox(prompt);
      },
    });
    const desktopIntegrations = createDesktopIntegrations({
      executablePath: app.getPath("exe"),
      resourcesDirectory: process.resourcesPath,
      isPackaged: app.isPackaged,
    });
    let finalizeInit: NonNullable<JobManagerOptions["finalizeInit"]> = async (result) => result;
    let mediaCore: CoreService | null = null;
    const jobs = createJobManager({
      workerPath: join(mainDirectory, "job-worker.js"),
      getSettings: () => settingsStore.get(),
      getBrowserExecutablePath: async (settings) => (await desktopIntegrations.detectBrowser(settings.browser)).path,
      // Core media Job 接入完成后再打开能力闸；当前必须保持 NOT_IMPLEMENTED。
      isMediaJobReady: () => false,
      getWordPressCredential: async (id) => {
        if (!mediaCore) throw { code: "PROJECT_NOT_FOUND", message: "项目服务尚未就绪。" };
        const project = await mediaCore.projects.get(id);
        if (project.config.edm?.image_host?.type !== "wordpress") {
          throw { code: "WP_NOT_CONFIGURED", message: "该项目尚未配置 WordPress 媒体托管。" };
        }
        try {
          const credential = await wordpressCredentialVault.getForHost(project.config.base_url);
          if (credential) return credential;
        } catch {
          throw { code: "WP_NOT_CONFIGURED", message: "本机 WordPress 凭据不可用，请在设置中重新保存。" };
        }
        throw { code: "WP_NOT_CONFIGURED", message: "尚未配置此项目的 WordPress 应用程序密码。" };
      },
      resolveProject: (id: ProjectId) => {
        if (!projectCatalog) throw { code: "PROJECT_NOT_FOUND", message: "项目目录尚未就绪。", detail: id };
        return projectCatalog.resolveProject(id);
      },
      fork: (modulePath) => utilityProcess.fork(modulePath),
      emitProgress: (progress) => windowManager.sendToWindows("si:jobs.onProgress", progress),
      emitFinished: (result) => windowManager.sendToWindows("si:jobs.onFinished", result),
      finalizeInit: (result, projectPath, emitProgress) => finalizeInit(result, projectPath, emitProgress),
      notify: showJobNotification,
    });
    let quitPromptOpen = false;
    requestQuit = () => {
      if (isShuttingDown) {
        app.quit();
        return;
      }
      if (quitPromptOpen) return;
      if (jobs.activeCount === 0) {
        app.quit();
        return;
      }
      quitPromptOpen = true;
      const prompt = {
        type: "question" as const,
        title: "退出 SiteIndex",
        message: "有任务正在运行。退出会取消这些任务，确定退出吗？",
        buttons: ["继续运行", "退出并取消任务"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const window = windowManager.getMainWindow();
      void (window && !window.isDestroyed() ? dialog.showMessageBox(window, prompt) : dialog.showMessageBox(prompt))
        .then(({ response }) => {
          if (response === 1) app.quit();
        })
        .catch(() => console.warn("退出确认对话框无法显示。"))
        .finally(() => {
          quitPromptOpen = false;
        });
    };
    app.on("before-quit", (event) => {
      if ((jobs.activeCount === 0 && !projectCatalog) || isShuttingDown) return;
      event.preventDefault();
      isShuttingDown = true;
      residentScheduler?.stop();
      void Promise.all([
        jobs.shutdown(),
        projectCatalog?.close(),
        startupScheduleReconciliation?.catch(() => undefined),
      ]).finally(() => {
        projectCatalog = null;
        app.quit();
      });
    });

    if (isRunJob) {
      const args = parseRunJobArguments(process.argv);
      if (!args) {
        app.exit(EXIT.BAD_ARGS);
        return;
      }
      try {
        const result = await jobs.runAndWait({ projectPath: resolve(args.projectPath), job: args.job }, "schedule");
        app.exit(result.exitCode);
      } catch (error) {
        process.stderr.write(`SiteIndex Job 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
        app.exit(EXIT.BAD_ARGS);
      }
      return;
    }

    let currentSettings = await settingsStore.get();
    if (!launchHidden && !currentSettings.projects_root.trim()) {
      const projectsRoot = await chooseDirectory();
      if (projectsRoot) currentSettings = await settingsStore.set({ projects_root: projectsRoot });
    }
    currentBackgroundPolicy = backgroundPolicy(
      currentSettings,
      scheduleMode,
      process.platform,
      Boolean(currentSettings.projects_root.trim() || currentSettings.extra_projects.length),
    );

    let core: CoreService | null = null;
    const catalog = createProjectCatalog(
      (projectPath) => core?.invalidate(projectPath),
      (id) => windowManager.sendToWindows("si:projects.onChanged", id),
    );
    projectCatalog = catalog;
    const coreContext = {
      resolveProject: catalog.resolveProject,
      listRegisteredProjects: async () => catalog.refresh(await settingsStore.get()),
      get deviceId() {
        return currentSettings.device_id;
      },
      get deviceName() {
        return currentSettings.device_name;
      },
      get cacheDir() {
        return currentSettings.cache_dir;
      },
      templateDir: app.isPackaged
        ? join(process.resourcesPath, "templates", "project")
        : resolve(mainDirectory, "../../../../templates/project"),
    } satisfies CoreServiceContext;
    const coreService = createCoreService(coreContext);
    mediaCore = coreService;
    core = coreService;
    const skillService = createSkillService({
      sourceDirectory: app.isPackaged
        ? join(process.resourcesPath, "skills")
        : resolve(mainDirectory, "../../../../skills"),
      listProjects: () => catalog.refresh(currentSettings),
      getPlatforms: async () => (await settingsStore.get()).skill_platforms,
    });
    residentScheduler =
      process.platform === "win32"
        ? createResidentScheduler({
            statePath: join(app.getPath("userData"), "resident-schedule-state.json"),
            listProjects: () => catalog.refresh(currentSettings),
            getSchedule: async (id) => (await coreService.schedule.get(id)).config,
            isThisDevice: async (id) => (await coreService.runner.get(id)).is_this_device,
            isJobRunning: async (id) => Boolean(await jobs.running(id)),
            runJob: async (project, job) => jobs.runAndWait({ projectPath: project.path, job }, "schedule"),
          })
        : null;
    const getNextTrayRunLabel = async (): Promise<string> => {
      const entries = await catalog.refresh(currentSettings);
      const candidates = (
        await Promise.all(
          entries.map(async ({ id }) => {
            const [schedule, runner] = await Promise.all([coreService.schedule.get(id), coreService.runner.get(id)]);
            if (!runner.is_this_device) return [];
            return calculateNextRuns(schedule.config)
              .filter((run): run is typeof run & { at: string } => run.at !== null)
              .map((run) => ({ id, job: run.job, at: run.at }));
          }),
        )
      )
        .flat()
        .sort((left, right) => left.at.localeCompare(right.at));
      const next = candidates[0];
      if (!next) return "未配置";
      const jobLabels: Record<string, string> = {
        daily: "每日同步",
        validate: "校验",
        weekly: "每周抓取",
        readme: "README 更新",
        monthly: "每月任务",
      };
      const time = new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(next.at));
      return `${time} · ${jobLabels[next.job] ?? next.job} · ${next.id}`;
    };
    const applyBackgroundPreferences = async (): Promise<void> => {
      const hasProjects = Boolean(currentSettings.projects_root.trim() || currentSettings.extra_projects.length);
      currentBackgroundPolicy = backgroundPolicy(currentSettings, scheduleMode, process.platform, hasProjects);
      if (scheduleMode === "resident") residentScheduler?.start();
      else residentScheduler?.stop();

      if (currentBackgroundPolicy.keepTray) {
        systemTray ??= await createAppTray({
          onOpen: windowManager.showMainWindow,
          onQuit: () => requestQuit(),
          onSync: (id) => {
            void jobs
              .run({ projectPath: catalog.resolveProject(id as ProjectId), job: "daily" })
              .then(() => {
                if (Notification.isSupported())
                  new Notification({ title: "SiteIndex", body: "每日同步已开始。" }).show();
              })
              .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : "请稍后重试。";
                const window = windowManager.getMainWindow();
                const options = { type: "error" as const, title: "无法启动同步", message };
                void (window && !window.isDestroyed()
                  ? dialog.showMessageBox(window, options)
                  : dialog.showMessageBox(options));
              });
          },
          listProjects: async () => (await catalog.refresh(currentSettings)).map(({ id }) => ({ id, name: id })),
          nextRunLabel: getNextTrayRunLabel,
        });
        void systemTray?.refresh();
      } else {
        systemTray?.destroy();
        systemTray = null;
      }

      if (!updateLoginAutostart(currentBackgroundPolicy.openAtLogin, currentBackgroundPolicy.backgroundAtLogin)) {
        console.warn("用户登录自启设置未能应用。");
      }
    };
    const applyScheduleMode = async (status: ScheduleRuntimeStatus): Promise<void> => {
      scheduleMode = status.mode;
      await applyBackgroundPreferences();
    };
    const traceAddExisting =
      process.env.SITEINDEX_TRACE === "1" ? createAddExistingTraceWriter(app.getPath("logs")) : undefined;
    const scheduleReconciliationQueue = createScheduleReconciliationQueue();
    const reconcileSchedulesNow = async (
      allowElevation: boolean,
      knownEntries?: Awaited<ReturnType<typeof catalog.refresh>>,
      onTiming?: AddExistingTimingCallback,
      removedProjectIds?: string[],
    ): Promise<ScheduleRuntimeStatus> => {
      const entries = knownEntries ?? (await catalog.refresh(currentSettings, onTiming));
      const definitions = await Promise.all(
        entries.map(async ({ id, path: projectPath }) => {
          const [schedule, runner] = await Promise.all([
            measureAddExistingPhase("core.schedule.get", onTiming, () => coreService.schedule.get(id)),
            measureAddExistingPhase("core.runner.get", onTiming, () => coreService.runner.get(id)),
          ]);
          return { projectId: id, projectPath, config: schedule.config, isThisDevice: runner.is_this_device };
        }),
      );
      const status = await measureAddExistingPhase("scheduler.reconcile", onTiming, () =>
        scheduler.reconcile(definitions, allowElevation, removedProjectIds, onTiming),
      );
      await applyScheduleMode(status);
      return status;
    };
    const reconcileSchedules = (
      allowElevation: boolean,
      knownEntries?: Awaited<ReturnType<typeof catalog.refresh>>,
      onTiming?: AddExistingTimingCallback,
      removedProjectIds?: string[],
    ): Promise<ScheduleRuntimeStatus> =>
      scheduleReconciliationQueue.enqueue(() =>
        reconcileSchedulesNow(allowElevation, knownEntries, onTiming, removedProjectIds),
      );
    const reconcileProjectScheduleInBackground = (projectId: ProjectId): void => {
      void scheduleReconciliationQueue
        .enqueueForProject(projectId, async () => {
          // 先让添加项目的 IPC 响应返回，避免注册授权对话框挡住添加反馈。
          await new Promise<void>((resolveNextTurn) => setImmediate(resolveNextTurn));
          const timings: { phase: AddExistingTracePhase; durationMs: number }[] = [];
          try {
            await reconcileSchedulesNow(true, undefined, (phase, durationMs) => {
              timings.push({ phase, durationMs });
            });
          } finally {
            await traceAddExisting?.(timings);
          }
        })
        .catch(() => {
          // 注册错误会在项目中心的后台核验状态中显示；日志不输出项目路径或任务内容。
          console.warn("添加已有项目后的后台计划任务注册失败。");
        });
    };
    finalizeInit = (result, projectPath, emitProgress) =>
      completeInitSchedule(result, projectPath, {
        emitProgress,
        register: async () => {
          const projectId = basename(projectPath) as ProjectId;
          const config = (await coreService.schedule.get(projectId)).config;
          const enabled = SCHEDULABLE_JOBS.some((job) => config[job].enabled);
          if (!enabled) return { enabled: false, registered: false, mode: "system", authorizationRequired: false };
          const runtime = await reconcileSchedules(true);
          const state = await scheduler.getState(projectId, projectPath, config);
          return {
            enabled: true,
            registered: state.registered,
            mode: runtime.mode,
            authorizationRequired: runtime.authorization_required,
          };
        },
      });
    const initialProjects = await catalog.refresh(currentSettings);
    currentBackgroundPolicy = backgroundPolicy(
      currentSettings,
      scheduleMode,
      process.platform,
      initialProjects.length > 0,
    );
    await applyBackgroundPreferences();
    if (launchHidden) await reconcileSchedules(false, initialProjects);
    if (launchHidden && scheduleMode === "system") {
      app.quit();
      return;
    }
    const updates = createUpdateService({
      updater: electronUpdater.autoUpdater,
      currentVersion: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      waitForJobs: () => jobs.pauseAndWaitForIdle(),
      resumeJobs: () => jobs.resumeJobs(),
      beforeInstall: () => {
        isShuttingDown = true;
        residentScheduler?.stop();
        updates.stop();
      },
      installFailed: () => {
        isShuttingDown = false;
        if (scheduleMode === "resident") residentScheduler?.start();
        updates.start();
      },
      emitStatus: (status) => windowManager.sendToWindows("si:updates.onStatus", status),
    });
    app.on("before-quit", () => updates.stop());
    registerIpcHandlers({
      updates,
      settings: settingsStore,
      uiState: createUiStateStore(async () => (await settingsStore.get()).cache_dir),
      core: coreService,
      projects: catalog,
      settingsChanged: async (updated, reconcile = true, onTiming) => {
        const backgroundSettingsChanged =
          currentSettings.close_to_tray !== updated.close_to_tray ||
          currentSettings.launch_at_login !== updated.launch_at_login;
        const projectsChanged =
          currentSettings.projects_root !== updated.projects_root ||
          JSON.stringify(currentSettings.hidden_projects ?? []) !== JSON.stringify(updated.hidden_projects ?? []) ||
          currentSettings.extra_projects.length !== updated.extra_projects.length ||
          currentSettings.extra_projects.some((entry, index) => entry !== updated.extra_projects[index]);
        currentSettings = updated;
        if (projectsChanged && reconcile) await reconcileSchedules(true, undefined, onTiming);
        else if (backgroundSettingsChanged || projectsChanged) await applyBackgroundPreferences();
      },
      jobs,
      // Core EDM SKU 清单导出仍在 pending；即使服务暴露同名方法，也要等能力通过验收后再开放。
      isEdmExportIndexReady: () => false,
      scheduler,
      reconcileSchedules,
      reconcileProjectScheduleInBackground,
      waitForProjectScheduleReconciliation: (id) => scheduleReconciliationQueue.waitForProject(id),
      ...(traceAddExisting ? { traceAddExisting } : {}),
      onRunnerClaimed: async () => {
        await reconcileSchedules(true);
      },
      notifyProjectChanged: (id) => windowManager.sendToWindows("si:projects.onChanged", id),
      skills: skillService,
      desktopIntegrations,
    });

    windowManager.registerContentSecurityPolicy();
    if (!launchHidden) {
      await createWindowThenReconcileInBackground(
        () => windowManager.createMainWindow(),
        () => {
          startupScheduleReconciliation = reconcileSchedules(false, initialProjects);
          return startupScheduleReconciliation;
        },
        (error) => {
          console.error("启动时校正计划任务失败。", error instanceof Error ? error.message : String(error));
        },
      );
    }

    updates.start();

    app.on("activate", () => {
      windowManager.showMainWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (!currentBackgroundPolicy.hideOnClose || !systemTray) requestQuit();
});
