import { readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ProjectStorageAssessment {
  status: "known-cloud" | "unknown";
  provider?: string;
}

interface KnownCloudRoot {
  path: string;
  provider: string;
}

const ENVIRONMENT_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["OneDrive", "OneDrive"],
  ["OneDriveConsumer", "OneDrive"],
  ["OneDriveCommercial", "OneDrive"],
  ["DROPBOX_HOME", "Dropbox"],
  ["GOOGLE_DRIVE_ROOT", "Google Drive"],
  ["NEXTCLOUD_ROOT", "Nextcloud"],
  ["BOX_SYNC_ROOT", "Box"],
  ["ICLOUD_DRIVE_ROOT", "iCloud Drive"],
];

async function canonicalPathAllowingMissing(input: string): Promise<string> {
  let current = path.resolve(input);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.resolve(await realpath(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function addRoot(roots: KnownCloudRoot[], input: string | undefined, provider: string): void {
  if (!input?.trim() || !path.isAbsolute(input.trim())) return;
  const absolute = path.resolve(input.trim());
  if (!roots.some((root) => path.resolve(root.path) === absolute)) roots.push({ path: absolute, provider });
}

function dropboxRoots(value: unknown): KnownCloudRoot[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const roots: KnownCloudRoot[] = [];
  for (const [key, provider] of [["personal", "Dropbox"], ["business", "Dropbox"]] as const) {
    const entry = record[key];
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const location = (entry as Record<string, unknown>).path;
      if (typeof location === "string") addRoot(roots, location, provider);
    }
  }
  return roots;
}

async function knownCloudRoots(home: string, env: NodeJS.ProcessEnv): Promise<KnownCloudRoot[]> {
  const roots: KnownCloudRoot[] = [];
  for (const [name, provider] of ENVIRONMENT_ROOTS) addRoot(roots, env[name], provider);

  if (process.platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData && path.isAbsolute(appData)) {
      try {
        const config = JSON.parse(await readFile(path.join(appData, "Dropbox", "info.json"), "utf8")) as unknown;
        roots.push(...dropboxRoots(config));
      } catch {
        // Dropbox metadata is optional; do not infer a location from a folder name alone.
      }
    }
  }

  if (process.platform === "darwin") {
    const cloudStorage = path.join(home, "Library", "CloudStorage");
    try {
      for (const entry of await readdir(cloudStorage, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (/^OneDrive(?:-|$)/iu.test(entry.name)) addRoot(roots, path.join(cloudStorage, entry.name), "OneDrive");
        else if (/^GoogleDrive(?:-|$)/iu.test(entry.name)) addRoot(roots, path.join(cloudStorage, entry.name), "Google Drive");
        else if (/^Dropbox(?:-|$)/iu.test(entry.name)) addRoot(roots, path.join(cloudStorage, entry.name), "Dropbox");
        else if (/^Box(?:-|$)/iu.test(entry.name)) addRoot(roots, path.join(cloudStorage, entry.name), "Box");
      }
    } catch {
      // CloudStorage is not present on every macOS installation.
    }
    addRoot(roots, path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), "iCloud Drive");
  }
  return roots;
}

/**
 * Best-effort recognition of provider-owned sync roots. Unknown paths stay unknown:
 * arbitrary mounts and user-selected sync roots have no portable Node metadata.
 */
export async function inspectProjectStorageLocation(projectPath: string): Promise<ProjectStorageAssessment> {
  let candidate: string;
  try { candidate = await canonicalPathAllowingMissing(projectPath); }
  catch { candidate = path.resolve(projectPath); }
  const roots = await knownCloudRoots(os.homedir(), process.env);
  for (const root of roots) {
    let canonicalRoot: string;
    try { canonicalRoot = await canonicalPathAllowingMissing(root.path); }
    catch { canonicalRoot = path.resolve(root.path); }
    if (withinRoot(canonicalRoot, candidate)) return { status: "known-cloud", provider: root.provider };
  }
  return { status: "unknown" };
}

/** Reject known sync roots without moving, deleting, or rewriting existing project data. */
export async function assertProjectStorageLocal(projectPath: string): Promise<void> {
  const assessment = await inspectProjectStorageLocation(projectPath);
  if (assessment.status === "known-cloud") {
    throw Object.assign(
      new Error(`检测到项目目录位于${assessment.provider}同步位置；当前版本仅支持本机项目数据。请在本机目录新建项目，或手动复制现有项目后重新添加。`),
      { code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" as const },
    );
  }
}
