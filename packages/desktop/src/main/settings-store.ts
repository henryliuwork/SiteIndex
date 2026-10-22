import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import type { AppSettings, SkillPlatform } from "@siteindex/shared";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function invalidSettings(detail: string): never {
  throw { code: "CONFIG_INVALID", message: "软件设置无效", detail };
}

function isSkillPlatform(value: unknown): value is SkillPlatform {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.dir === "string" &&
    typeof value.detected === "boolean"
  );
}

function createDefaults(settingsDirectory: string, deviceName: string): AppSettings {
  return {
    device_id: randomUUID(),
    device_name: deviceName,
    projects_root: "",
    extra_projects: [],
    cache_dir: join(settingsDirectory, "cache"),
    browser: { channel: "msedge", executable_path: null },
    notify: { on_failure: true, on_success: false, oos_threshold: null, dingtalk_webhook: null },
    skill_platforms: [],
    conflict_patterns: [],
  };
}

function normalizeSettings(value: unknown, defaults: AppSettings): AppSettings {
  if (!isRecord(value)) return defaults;
  const browser = isRecord(value.browser) ? value.browser : {};
  const notify = isRecord(value.notify) ? value.notify : {};

  return {
    device_id: typeof value.device_id === "string" && value.device_id ? value.device_id : defaults.device_id,
    device_name: typeof value.device_name === "string" ? value.device_name : defaults.device_name,
    projects_root: typeof value.projects_root === "string" ? value.projects_root : defaults.projects_root,
    extra_projects: Array.isArray(value.extra_projects)
      ? value.extra_projects.filter((item): item is string => typeof item === "string")
      : defaults.extra_projects,
    cache_dir: typeof value.cache_dir === "string" && value.cache_dir ? value.cache_dir : defaults.cache_dir,
    browser: {
      channel:
        browser.channel === "chrome" || browser.channel === "custom" ? browser.channel : defaults.browser.channel,
      executable_path:
        typeof browser.executable_path === "string" || browser.executable_path === null
          ? browser.executable_path
          : defaults.browser.executable_path,
    },
    notify: {
      on_failure: typeof notify.on_failure === "boolean" ? notify.on_failure : defaults.notify.on_failure,
      on_success: typeof notify.on_success === "boolean" ? notify.on_success : defaults.notify.on_success,
      oos_threshold:
        typeof notify.oos_threshold === "number" || notify.oos_threshold === null
          ? notify.oos_threshold
          : defaults.notify.oos_threshold,
      dingtalk_webhook:
        typeof notify.dingtalk_webhook === "string" || notify.dingtalk_webhook === null
          ? notify.dingtalk_webhook
          : defaults.notify.dingtalk_webhook,
    },
    skill_platforms: Array.isArray(value.skill_platforms)
      ? value.skill_platforms.filter(isSkillPlatform)
      : defaults.skill_platforms,
    conflict_patterns: Array.isArray(value.conflict_patterns)
      ? value.conflict_patterns.filter((item): item is string => typeof item === "string")
      : defaults.conflict_patterns,
  };
}

function validatePatch(patch: unknown): asserts patch is Partial<AppSettings> {
  if (!isRecord(patch)) invalidSettings("settings.set 需要一个设置对象。");

  const allowedKeys = new Set([
    "device_id",
    "device_name",
    "projects_root",
    "extra_projects",
    "cache_dir",
    "browser",
    "notify",
    "skill_platforms",
    "conflict_patterns",
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowedKeys.has(key)) invalidSettings(`不支持修改设置字段 ${key}。`);
  }

  const stringFields = ["device_id", "device_name", "projects_root", "cache_dir"] as const;
  for (const key of stringFields) {
    if (key in patch && typeof patch[key] !== "string") invalidSettings(`${key} 必须是字符串。`);
  }
  for (const key of ["extra_projects", "conflict_patterns"] as const) {
    if (key in patch && (!Array.isArray(patch[key]) || !patch[key].every((item) => typeof item === "string"))) {
      invalidSettings(`${key} 必须是字符串数组。`);
    }
  }
  if (
    "skill_platforms" in patch &&
    (!Array.isArray(patch.skill_platforms) || !patch.skill_platforms.every(isSkillPlatform))
  ) {
    invalidSettings("skill_platforms 格式无效。");
  }
  if ("browser" in patch) {
    if (
      !isRecord(patch.browser) ||
      !("channel" in patch.browser) ||
      !(
        patch.browser.channel === "msedge" ||
        patch.browser.channel === "chrome" ||
        patch.browser.channel === "custom"
      ) ||
      !(typeof patch.browser.executable_path === "string" || patch.browser.executable_path === null)
    ) {
      invalidSettings("browser 设置格式无效。");
    }
  }
  if ("notify" in patch) {
    const notify = patch.notify;
    if (
      !isRecord(notify) ||
      typeof notify.on_failure !== "boolean" ||
      typeof notify.on_success !== "boolean" ||
      !(typeof notify.oos_threshold === "number" || notify.oos_threshold === null) ||
      !(typeof notify.dingtalk_webhook === "string" || notify.dingtalk_webhook === null)
    ) {
      invalidSettings("notify 设置格式无效。");
    }
  }
}

async function writeAtomically(filePath: string, settings: AppSettings): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  const handle = await open(temporaryPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryPath, filePath);
      return;
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (attempt >= 9 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

export interface SettingsStore {
  readonly filePath: string;
  exists(): Promise<boolean>;
  get(): Promise<AppSettings>;
  set(patch: Partial<AppSettings>): Promise<AppSettings>;
}

export function createSettingsStore(settingsDirectory: string, deviceName = hostname()): SettingsStore {
  const filePath = join(settingsDirectory, "settings.json");
  const defaults = createDefaults(settingsDirectory, deviceName || "SiteIndex");

  async function load(): Promise<AppSettings> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await writeAtomically(filePath, defaults);
      return { ...defaults, browser: { ...defaults.browser }, notify: { ...defaults.notify } };
    }

    const settings = normalizeSettings(parsed, defaults);
    await writeAtomically(filePath, settings);
    return settings;
  }

  return {
    filePath,
    async exists() {
      try {
        await access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async get() {
      return load();
    },
    async set(patch) {
      validatePatch(patch);
      const current = await load();
      const next = {
        ...current,
        ...patch,
        browser: patch.browser ? { ...current.browser, ...patch.browser } : current.browser,
        notify: patch.notify ? { ...current.notify, ...patch.notify } : current.notify,
      };
      await writeAtomically(filePath, next);
      return next;
    },
  };
}
