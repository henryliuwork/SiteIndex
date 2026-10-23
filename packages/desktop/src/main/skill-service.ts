import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  PATHS,
  type ProjectId,
  type SkillInfo,
  type SkillPlatform,
  type SkillTargetStatus,
  type SiteIndexError,
} from "@siteindex/shared";

export interface SkillProject {
  id: ProjectId;
  path: string;
}

export interface SkillService {
  list(): Promise<SkillInfo[]>;
  get(name: string): Promise<{ info: SkillInfo; body: string }>;
  targets(name: string): Promise<SkillTargetStatus[]>;
  install(name: string, targetId: string): Promise<SkillTargetStatus>;
  syncAllProjects(): Promise<void>;
}

export interface SkillServiceOptions {
  sourceDirectory: string;
  homeDirectory?: string;
  listProjects(): Promise<SkillProject[]>;
  getPlatforms(): Promise<SkillPlatform[]>;
}

interface SkillDocument {
  info: SkillInfo;
  content: string;
}

interface SkillManifest {
  version: 1;
  skills: Record<string, string>;
}

interface SkillTarget {
  targetId: string;
  name: string;
  directory: string | null;
  projectPath?: string;
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_TARGET_IDS = new Set(["claude-code", "codex"]);

function skillError(code: SiteIndexError["code"], message: string, detail?: string): SiteIndexError {
  return { code, message, ...(detail ? { detail } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrontmatter(content: string, filePath: string): SkillDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw skillError("CONFIG_INVALID", "内置 skill 缺少有效的 frontmatter。", filePath);

  const fields = new Map<string, string | string[]>();
  const lines = match[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const field = /^([a-z_]+):(?:\s*(.*))?$/.exec(line);
    if (!field) continue;
    const key = field[1]!;
    const value = field[2] ?? "";
    if (key === "reads" || key === "writes") {
      const entries: string[] = [];
      if (value && value !== "[]") entries.push(value.replace(/^['"]|['"]$/g, ""));
      while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1]!)) {
        entries.push(lines[index + 1]!.replace(/^\s+-\s+/, "").replace(/^['"]|['"]$/g, ""));
        index += 1;
      }
      fields.set(key, entries);
    } else {
      fields.set(key, value);
    }
  }

  const name = fields.get("name");
  const version = fields.get("version");
  const description = fields.get("description");
  if (
    typeof name !== "string" ||
    !SKILL_NAME_PATTERN.test(name) ||
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ||
    typeof description !== "string" ||
    !description.trim()
  ) {
    throw skillError("CONFIG_INVALID", "内置 skill 的名称、版本或说明无效。", filePath);
  }

  const listField = (key: "reads" | "writes"): string[] => {
    const value = fields.get(key);
    return Array.isArray(value) ? value.map((item) => item.trim()).filter(Boolean) : [];
  };

  return {
    info: {
      name,
      version,
      description: description.trim(),
      has_update: false,
      reads: listField("reads"),
      writes: listField("writes"),
    },
    content,
  };
}

function compareVersions(left: string, right: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][a-zA-Z0-9.-]+)?$/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index]! < rightParts[index]! ? -1 : 1;
  }
  return 0;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function validateSkillName(value: unknown): string {
  if (typeof value !== "string" || !SKILL_NAME_PATTERN.test(value)) {
    throw skillError("CONFIG_INVALID", "skill 名称无效。", String(value));
  }
  return value;
}

function customTargetId(value: string): boolean {
  return value.length > 0 && !value.includes(":") && !RESERVED_TARGET_IDS.has(value);
}

function resolveCustomDirectory(value: string, homeDirectory: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return homeDirectory;
  if (/^~[\\/]/.test(trimmed)) return path.resolve(homeDirectory, trimmed.slice(2));
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : null;
}

export function createSkillService(options: SkillServiceOptions): SkillService {
  const homeDirectory = options.homeDirectory ?? homedir();
  const manifestLocks = new Map<string, Promise<void>>();

  async function readSkill(nameValue: unknown): Promise<SkillDocument> {
    const name = validateSkillName(nameValue);
    const filePath = path.join(options.sourceDirectory, name, "SKILL.md");
    try {
      return parseFrontmatter(await readFile(filePath, "utf8"), filePath);
    } catch (error) {
      if (isMissingFile(error)) throw skillError("CONFIG_INVALID", "找不到内置 skill。", name);
      throw error;
    }
  }

  async function readSkills(): Promise<SkillDocument[]> {
    const entries = await readdir(options.sourceDirectory, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    return Promise.all(names.map((name) => readSkill(name)));
  }

  async function installedVersion(directory: string, name: string): Promise<string | null> {
    try {
      const filePath = path.join(directory, name, "SKILL.md");
      const content = await readFile(filePath, "utf8");
      return parseFrontmatter(content, filePath).info.version;
    } catch (error) {
      if (isMissingFile(error)) return null;
      if (isRecord(error) && error.code === "CONFIG_INVALID") return "";
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code === "EACCES" || code === "ENOTDIR") return null;
      throw error;
    }
  }

  async function projectEntries(): Promise<SkillProject[]> {
    return (await options.listProjects()).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  async function infoWithUpdate(document: SkillDocument, projects: SkillProject[]): Promise<SkillInfo> {
    let hasUpdate = false;
    for (const project of projects) {
      const installed = await installedVersion(path.join(project.path, PATHS.skillsDir), document.info.name);
      if (
        installed !== null &&
        (compareVersions(installed, document.info.version) === -1 ||
          compareVersions(installed, document.info.version) === null)
      ) {
        hasUpdate = true;
        break;
      }
    }
    return { ...document.info, has_update: hasUpdate };
  }

  async function targetsFor(name: string): Promise<SkillTarget[]> {
    const projects = await projectEntries();
    const customPlatforms = await options.getPlatforms();
    const projectTargets: SkillTarget[] = projects.map((project) => ({
      targetId: `project:${project.id}`,
      name: `${project.id} 项目`,
      directory: path.resolve(project.path, PATHS.skillsDir),
      projectPath: project.path,
    }));
    const defaultTargets: SkillTarget[] = [
      {
        targetId: "claude-code",
        name: "Claude Code",
        directory: path.join(homeDirectory, ".claude", "skills"),
      },
      {
        targetId: "codex",
        name: "Codex",
        directory: path.join(homeDirectory, ".codex", "skills"),
      },
    ];
    const seenCustomTargetIds = new Set<string>();
    const configuredTargets: SkillTarget[] = customPlatforms
      .filter((platform) => {
        if (!customTargetId(platform.id) || seenCustomTargetIds.has(platform.id)) return false;
        seenCustomTargetIds.add(platform.id);
        return true;
      })
      .map((platform) => ({
        targetId: platform.id,
        name: platform.name,
        directory: resolveCustomDirectory(platform.dir, homeDirectory),
      }));
    return [...projectTargets, ...defaultTargets, ...configuredTargets].map((target) => ({
      ...target,
      directory: target.directory ? path.join(target.directory, name) : null,
    }));
  }

  async function statusFor(name: string, version: string, target: SkillTarget): Promise<SkillTargetStatus> {
    const targetDirectory = target.directory;
    if (!targetDirectory) {
      return { target_id: target.targetId, name: target.name, dir: targetDirectory, status: "unknown_path" };
    }
    const currentVersion = await installedVersion(path.dirname(targetDirectory), name);
    if (currentVersion === null) {
      return { target_id: target.targetId, name: target.name, dir: targetDirectory, status: "not_installed" };
    }
    const comparison = compareVersions(currentVersion, version);
    return {
      target_id: target.targetId,
      name: target.name,
      dir: targetDirectory,
      status: comparison !== null && comparison >= 0 ? "latest" : "outdated",
    };
  }

  async function resolveTarget(targetId: string, name: string): Promise<SkillTarget> {
    const targets = await targetsFor(name);
    const target = targets.find((entry) => entry.targetId === targetId);
    if (!target) throw skillError("CONFIG_INVALID", "skill 安装位置无效。", targetId);
    if (!target.directory) throw skillError("CONFIG_INVALID", "自定义 skill 目录必须是绝对路径。", targetId);
    if (target.targetId.startsWith("project:") && !target.projectPath) {
      throw skillError("PROJECT_NOT_FOUND", "找不到 skill 安装目标项目。", targetId);
    }
    return target;
  }

  async function updateProjectManifest(projectPath: string, name: string, version: string): Promise<void> {
    const filePath = path.resolve(projectPath, PATHS.skillsManifest);
    const previous = manifestLocks.get(filePath) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    manifestLocks.set(filePath, lock);
    await previous;
    try {
      let skills: Record<string, string> = {};
      try {
        const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
        if (!isRecord(value) || value.version !== 1 || !isRecord(value.skills)) {
          throw skillError("CONFIG_INVALID", "项目 skill manifest 格式无效。", filePath);
        }
        skills = Object.fromEntries(
          Object.entries(value.skills).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      skills[name] = version;
      const manifest: SkillManifest = {
        version: 1,
        skills: Object.fromEntries(
          Object.entries(skills).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        ),
      };
      await atomicWrite(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
    } finally {
      release();
      if (manifestLocks.get(filePath) === lock) manifestLocks.delete(filePath);
    }
  }

  async function installDocument(document: SkillDocument, target: SkillTarget): Promise<SkillTargetStatus> {
    const targetDirectory = target.directory;
    if (!targetDirectory) throw skillError("CONFIG_INVALID", "skill 安装位置无效。", target.targetId);
    await atomicWrite(path.join(targetDirectory, "SKILL.md"), document.content);
    if (target.projectPath) await updateProjectManifest(target.projectPath, document.info.name, document.info.version);
    return statusFor(document.info.name, document.info.version, target);
  }

  return {
    async list() {
      const [documents, projects] = await Promise.all([readSkills(), projectEntries()]);
      return Promise.all(documents.map((document) => infoWithUpdate(document, projects)));
    },
    async get(nameValue) {
      const document = await readSkill(nameValue);
      const info = await infoWithUpdate(document, await projectEntries());
      return { info, body: document.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "") };
    },
    async targets(nameValue) {
      const document = await readSkill(nameValue);
      return Promise.all(
        (await targetsFor(document.info.name)).map((target) =>
          statusFor(document.info.name, document.info.version, target),
        ),
      );
    },
    async install(nameValue, targetIdValue) {
      const document = await readSkill(nameValue);
      if (typeof targetIdValue !== "string" || !targetIdValue.trim()) {
        throw skillError("CONFIG_INVALID", "请选择 skill 安装位置。", String(targetIdValue));
      }
      const target = await resolveTarget(targetIdValue, document.info.name);
      return installDocument(document, target);
    },
    async syncAllProjects() {
      const [documents, projects] = await Promise.all([readSkills(), projectEntries()]);
      for (const project of projects) {
        for (const document of documents) {
          const target: SkillTarget = {
            targetId: `project:${project.id}`,
            name: `${project.id} 项目`,
            directory: path.resolve(project.path, PATHS.skillsDir, document.info.name),
            projectPath: project.path,
          };
          await installDocument(document, target);
        }
      }
    },
  };
}
