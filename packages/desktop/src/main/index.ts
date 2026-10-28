import { app, dialog, utilityProcess, type Tray } from "electron";
import electronUpdater from "electron-updater";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreService, type CoreService } from "@siteindex/core";
import { EXIT, SCHEDULABLE_JOBS, type AppSettings, type ProjectId } from "@siteindex/shared";
import { chooseDirectory, registerIpcHandlers } from "./ipc.js";
import { createJobManager, type JobManagerOptions } from "./job-manager.js";
import { completeInitSchedule } from "./init-schedule.js";
import { showJobNotification } from "./notifications.js";
import { createProjectCatalog, type ProjectCatalog } from "./project-catalog.js";
import { parseRunJobArguments } from "./run-job-args.js";
import { createResidentScheduler, type ResidentScheduler } from "./scheduler/resident-scheduler.js";
import { createSystemScheduler, type ScheduleRuntimeStatus } from "./scheduler/schedule.js";
import { createSkillService } from "./skill-service.js";
import { createDesktopIntegrations } from "./desktop-integrations.js";
import { createSettingsStore } from "./settings-store.js";
import { createUiStateStore } from "./ui-state-store.js";
import { createUpdateService } from "./update-service.js";
import { createWindowManager } from "./window-manager.js";
import { backgroundSchedulerArgument, createWindowsTray, updateWindowsAutostart } from "./windows-background.js";

const isRunJob = process.argv.includes("--run-job");
const hasSingleInstanceLock = isRunJob || app.requestSingleInstanceLock();
const mainDirectory = dirname(fileURLToPath(import.meta.url));
const fallbackPath = resolve(mainDirectory, "../renderer/fallback.html");
const devUiUrl = process.env.SITEINDEX_UI_URL ?? "http://localhost:5173";
let projectCatalog: ProjectCatalog | null = null;
let isShuttingDown = false;
let launchHidden = process.platform === "win32" && process.argv.includes(backgroundSchedulerArgument);
let systemTray: Tray | null = null;
let residentScheduler: ResidentScheduler | null = null;
let scheduleMode: ScheduleRuntimeStatus["mode"] = "system";
const windowManager = createWindowManager({
  mainDirectory,
  fallbackPath,
  devUiUrl,
  initiallyHidden: launchHidden,
  shouldHideOnClose: () => process.platform === "win32" && scheduleMode === "resident" && Boolean(systemTray),
  isShuttingDown: () => isShuttingDown,
});

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
    const jobs = createJobManager({
      workerPath: join(mainDirectory, "job-worker.js"),
      getSettings: () => settingsStore.get(),
      getBrowserExecutablePath: async (settings) => (await desktopIntegrations.detectBrowser(settings.browser)).path,
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
    app.on("before-quit", (event) => {
      if ((jobs.activeCount === 0 && !projectCatalog) || isShuttingDown) return;
      event.preventDefault();
      isShuttingDown = true;
      residentScheduler?.stop();
      void Promise.all([jobs.shutdown(), projectCatalog?.close()]).finally(() => {
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

    let core: CoreService | null = null;
    const catalog = createProjectCatalog(
      (projectPath) => core?.invalidate(projectPath),
      (id) => windowManager.sendToWindows("si:projects.onChanged", id),
    );
    projectCatalog = catalog;
    const coreService = createCoreService({
      resolveProject: catalog.resolveProject,
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
    });
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
    const applyScheduleMode = async (status: ScheduleRuntimeStatus): Promise<void> => {
      scheduleMode = status.mode;
      if (process.platform !== "win32") return;
      if (scheduleMode === "resident") {
        systemTray ??= await createWindowsTray(windowManager.showMainWindow, () => app.quit());
        if (systemTray) {
          residentScheduler?.start();
          updateWindowsAutostart(Boolean(currentSettings.projects_root || currentSettings.extra_projects.length));
        } else updateWindowsAutostart(false);
        return;
      }
      residentScheduler?.stop();
      updateWindowsAutostart(false);
      systemTray?.destroy();
      systemTray = null;
    };
    const reconcileSchedules = async (allowElevation: boolean): Promise<ScheduleRuntimeStatus> => {
      const entries = await catalog.refresh(currentSettings);
      const definitions = await Promise.all(
        entries.map(async ({ id, path: projectPath }) => {
          const [schedule, runner] = await Promise.all([coreService.schedule.get(id), coreService.runner.get(id)]);
          return { projectId: id, projectPath, config: schedule.config, isThisDevice: runner.is_this_device };
        }),
      );
      const status = await scheduler.reconcile(definitions, allowElevation);
      await applyScheduleMode(status);
      return status;
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
    await reconcileSchedules(false);
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
      settingsChanged: async (updated, reconcile = true) => {
        const projectsChanged =
          currentSettings.projects_root !== updated.projects_root ||
          currentSettings.extra_projects.length !== updated.extra_projects.length ||
          currentSettings.extra_projects.some((entry, index) => entry !== updated.extra_projects[index]);
        currentSettings = updated;
        if (projectsChanged && reconcile) await reconcileSchedules(true);
      },
      jobs,
      scheduler,
      reconcileSchedules,
      onRunnerClaimed: async () => {
        await reconcileSchedules(true);
      },
      skills: skillService,
      desktopIntegrations,
    });

    windowManager.registerContentSecurityPolicy();
    if (!launchHidden) {
      await windowManager.createMainWindow();
    }

    updates.start();

    app.on("activate", () => {
      windowManager.showMainWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !(process.platform === "win32" && scheduleMode === "resident" && systemTray))
    app.quit();
});
