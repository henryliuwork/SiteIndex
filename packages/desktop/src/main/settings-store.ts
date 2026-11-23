import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import type { AppSettings, AppSettingsSnapshot, ConfigSaveOptions, SettingsPatch, SkillPlatform } from "@siteindex/shared";

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
    hidden_projects: [],
    close_to_tray: true,
    launch_at_login: false,
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

  const normalized = {
    ...value,
    device_id: typeof value.device_id === "string" && value.device_id ? value.device_id : defaults.device_id,
    device_name: typeof value.device_name === "string" ? value.device_name : defaults.device_name,
    projects_root: typeof value.projects_root === "string" ? value.projects_root : defaults.projects_root,
    extra_projects: Array.isArray(value.extra_projects)
      ? value.extra_projects.filter((item): item is string => typeof item === "string")
      : defaults.extra_projects,
    hidden_projects: Array.isArray(value.hidden_projects)
      ? value.hidden_projects.filter((item): item is string => typeof item === "string")
      : defaults.hidden_projects,
    close_to_tray: typeof value.close_to_tray === "boolean" ? value.close_to_tray : defaults.close_to_tray,
    launch_at_login: typeof value.launch_at_login === "boolean" ? value.launch_at_login : defaults.launch_at_login,
    cache_dir: typeof value.cache_dir === "string" && value.cache_dir ? value.cache_dir : defaults.cache_dir,
    browser: {
      ...browser,
      channel:
        browser.channel === "chrome" || browser.channel === "custom" ? browser.channel : defaults.browser.channel,
      executable_path:
        typeof browser.executable_path === "string" || browser.executable_path === null
          ? browser.executable_path
          : defaults.browser.executable_path,
    },
    notify: {
      ...notify,
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
  delete (normalized as Record<string, unknown>).revision; // IPC metadata never belongs in settings.json.
  return normalized;
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    extra_projects: [...settings.extra_projects],
    hidden_projects: [...(settings.hidden_projects ?? [])],
    browser: { ...settings.browser },
    notify: { ...settings.notify },
    skill_platforms: settings.skill_platforms.map((platform) => ({ ...platform })),
    conflict_patterns: [...settings.conflict_patterns],
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]))
  );
}

const writes = new Map<string, Promise<unknown>>();

function serializeByFile<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const target = resolve(filePath);
  const previous = writes.get(target);
  const current = (previous?.catch(() => undefined) ?? Promise.resolve()).then(operation);
  writes.set(target, current);
  const cleanup = () => {
    if (writes.get(target) === current) writes.delete(target);
  };
  void current.then(cleanup, cleanup);
  return current;
}

function validatePatch(patch: unknown): asserts patch is SettingsPatch {
  if (!isRecord(patch)) invalidSettings("settings.set 需要一个设置对象。");

  const allowedKeys = new Set([
    "device_id",
    "device_name",
    "projects_root",
    "extra_projects",
    "hidden_projects",
    "close_to_tray",
    "launch_at_login",
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
  for (const key of ["close_to_tray", "launch_at_login"] as const) {
    if (key in patch && typeof patch[key] !== "boolean") invalidSettings(`${key} 必须是布尔值。`);
  }
  for (const key of ["extra_projects", "hidden_projects", "conflict_patterns"] as const) {
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
    if (!isRecord(patch.browser)) invalidSettings("browser 设置格式无效。");
    if ("channel" in patch.browser && !["msedge", "chrome", "custom"].includes(String(patch.browser.channel)))
      invalidSettings("browser.channel 设置格式无效。");
    if ("executable_path" in patch.browser &&
      !(typeof patch.browser.executable_path === "string" || patch.browser.executable_path === null))
      invalidSettings("browser.executable_path 设置格式无效。");
  }
  if ("notify" in patch) {
    const notify = patch.notify;
    if (!isRecord(notify)) invalidSettings("notify 设置格式无效。");
    for (const key of ["on_failure", "on_success"]) {
      if (key in notify && typeof notify[key] !== "boolean") invalidSettings(`notify.${key} 设置格式无效。`);
    }
    if ("oos_threshold" in notify && !(typeof notify.oos_threshold === "number" || notify.oos_threshold === null))
      invalidSettings("notify.oos_threshold 设置格式无效。");
    if ("dingtalk_webhook" in notify && !(typeof notify.dingtalk_webhook === "string" || notify.dingtalk_webhook === null))
      invalidSettings("notify.dingtalk_webhook 设置格式无效。");
  }
}

async function fileRevision(filePath: string): Promise<string | undefined> {
  try { return createHash("sha256").update(await readFile(filePath)).digest("hex"); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function protectedPatch(current: AppSettings, patch: SettingsPatch, options: ConfigSaveOptions): AppSettings {
  if (options.revision !== undefined && typeof options.revision !== "string") invalidSettings("revision 格式无效。");
  if (options.dirty_paths !== undefined && (!Array.isArray(options.dirty_paths) ||
    !options.dirty_paths.every((path) => typeof path === "string"))) invalidSettings("dirty_paths 格式无效。");
  if (options.clear !== undefined && (!Array.isArray(options.clear) ||
    !options.clear.every((path) => typeof path === "string"))) invalidSettings("clear 格式无效。");
  const values = new Map<string, unknown>();
  for (const [key, value] of Object.entries(patch)) {
    if ((key === "browser" || key === "notify") && isRecord(value)) {
      for (const [field, nested] of Object.entries(value)) values.set(`${key}.${field}`, nested);
    } else values.set(key, value);
  }
  const paths = options.dirty_paths ?? [...values.keys()];
  const clear = new Set(options.clear ?? []);
  for (const path of clear) if (!paths.includes(path)) invalidSettings(`clear 字段未修改：${path}。`);
  const next = cloneSettings(current);
  for (const path of paths) {
    if (!values.has(path)) invalidSettings(`未提交被修改字段 ${path}。`);
    const [section = "", field, extra] = path.split(".");
    if (extra || (field && section !== "browser" && section !== "notify")) invalidSettings(`设置字段无效：${path}。`);
    const target = field ? (next as unknown as Record<string, Record<string, unknown>>)[section] : next as unknown as Record<string, unknown>;
    if (!target || (!field && !Object.hasOwn(next, path))) invalidSettings(`设置字段无效：${path}。`);
    const key = field ?? section;
    if (field && !Object.hasOwn(target, key)) invalidSettings(`设置字段无效：${path}。`);
    const value = values.get(path);
    const empty = (item: unknown) => item === "" || item === null || item === undefined ||
      (Array.isArray(item) && item.length === 0);
    if (empty(value) && !empty(target[key]) && !clear.has(path)) invalidSettings(`清空 ${path} 需要明确确认。`);
    target[key] = value;
  }
  return next;
}

async function writeAtomically(filePath: string, settings: AppSettings): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

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
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export interface SettingsStore {
  readonly filePath: string;
  exists(): Promise<boolean>;
  get(): Promise<AppSettingsSnapshot>;
  set(patch: SettingsPatch, options?: ConfigSaveOptions): Promise<AppSettingsSnapshot>;
}

export function createSettingsStore(settingsDirectory: string, deviceName = hostname()): SettingsStore {
  const filePath = join(settingsDirectory, "settings.json");
  const defaults = createDefaults(settingsDirectory, deviceName || "SiteIndex");

  async function readSettings(): Promise<{ settings: AppSettings; needsRepair: boolean }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      return { settings: cloneSettings(defaults), needsRepair: true };
    }

    const settings = normalizeSettings(parsed, defaults);
    return { settings: cloneSettings(settings), needsRepair: !sameJsonValue(parsed, settings) };
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
      return serializeByFile(filePath, async () => {
        const { settings, needsRepair } = await readSettings();
        if (needsRepair) await writeAtomically(filePath, settings);
        return { ...settings, revision: await fileRevision(filePath) };
      });
    },
    async set(patch, options) {
      validatePatch(patch);
      return serializeByFile(filePath, async () => {
        const { settings: current, needsRepair } = await readSettings();
        const revision = await fileRevision(filePath);
        if (options !== undefined && !isRecord(options)) invalidSettings("保存选项格式无效。");
        if (options?.revision !== undefined && options.revision !== revision)
          throw { code: "CONFIG_INVALID", message: "配置已在别处更新，请刷新后重试。" };
        const next = options ? protectedPatch(current, patch, options) : {
          ...current,
          ...patch,
          browser: patch.browser ? { ...current.browser, ...patch.browser } : current.browser,
          notify: patch.notify ? { ...current.notify, ...patch.notify } : current.notify,
        };
        if (!needsRepair && sameJsonValue(current, next)) return { ...current, revision };
        if (!sameJsonValue(normalizeSettings(next, defaults), next)) invalidSettings("设置值无法正确读回。");
        await writeAtomically(filePath, next);
        try {
          const persisted = JSON.parse(await readFile(filePath, "utf8")) as unknown;
          if (!sameJsonValue(persisted, next)) throw new Error("saved settings differ from submitted settings");
        } catch {
          throw { code: "WRITE_FAILED", message: "软件设置保存后读回失败。" };
        }
        return { ...next, revision: await fileRevision(filePath) };
      });
    },
  };
}
