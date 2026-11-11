import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export const WINDOWS_PROFILE_ENV_KEYS = Object.freeze([
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
  "TEMP",
  "TMP",
]);

function isWithin(root, candidate, allowEqual = false) {
  if (!path.win32.isAbsolute(root) || !path.win32.isAbsolute(candidate)) return false;
  const normalizedRoot = path.win32.resolve(root).toLowerCase();
  const normalizedCandidate = path.win32.resolve(candidate).toLowerCase();
  const relative = path.win32.relative(normalizedRoot, normalizedCandidate);
  if (relative === "") return allowEqual;
  return relative !== ".." && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative);
}

export function createWindowsProfileLayout(root) {
  const absoluteRoot = path.win32.resolve(root);
  return {
    root: absoluteRoot,
    appDataRoot: path.win32.join(absoluteRoot, "profile", "roaming"),
    localAppDataRoot: path.win32.join(absoluteRoot, "profile", "local"),
    userProfileRoot: path.win32.join(absoluteRoot, "profile", "user"),
    homeRoot: path.win32.join(absoluteRoot, "profile", "home"),
    tempRoot: path.win32.join(absoluteRoot, "temp"),
    tmpRoot: path.win32.join(absoluteRoot, "tmp"),
    projectRoot: path.win32.join(absoluteRoot, "projects"),
    vaultPath: path.win32.join(absoluteRoot, "profile", "local", "SiteIndex", "LocalCredentials"),
    installDir: path.win32.join(absoluteRoot, "installed-app"),
  };
}

export function windowsProfileEnvironment(layout, inherited = {}) {
  return {
    ...inherited,
    APPDATA: layout.appDataRoot,
    LOCALAPPDATA: layout.localAppDataRoot,
    USERPROFILE: layout.userProfileRoot,
    HOME: layout.homeRoot,
    TEMP: layout.tempRoot,
    TMP: layout.tmpRoot,
  };
}

function hasReparsePoint(stats) {
  return stats.isSymbolicLink() || (typeof stats.attributes === "number" && (stats.attributes & 0x400) !== 0);
}

export async function inspectContainedPath(root, candidate, io = {}) {
  const realpathFn = io.realpath ?? realpath;
  const lstatFn = io.lstat ?? lstat;
  const lexicallyInside = isWithin(root, candidate);
  if (!lexicallyInside) return { withinRoot: false, noReparse: false };

  let canonicalRoot;
  let canonicalCandidate;
  try {
    [canonicalRoot, canonicalCandidate] = await Promise.all([realpathFn(root), realpathFn(candidate)]);
  } catch {
    return { withinRoot: false, noReparse: false };
  }
  const physicallyInside = isWithin(canonicalRoot, canonicalCandidate);

  let noReparse = true;
  let current = path.win32.resolve(candidate);
  const volumeRoot = path.win32.parse(current).root.toLowerCase();
  while (true) {
    try {
      if (hasReparsePoint(await lstatFn(current))) noReparse = false;
    } catch {
      noReparse = false;
    }
    if (current.toLowerCase() === volumeRoot) break;
    const parent = path.win32.dirname(current);
    if (parent.toLowerCase() === current.toLowerCase()) {
      noReparse = false;
      break;
    }
    current = parent;
  }
  return { withinRoot: lexicallyInside && physicallyInside, noReparse };
}

export async function inspectWindowsProfileLayout(layout, io = {}) {
  const profilePaths = {
    APPDATA: layout.appDataRoot,
    LOCALAPPDATA: layout.localAppDataRoot,
    USERPROFILE: layout.userProfileRoot,
    HOME: layout.homeRoot,
    TEMP: layout.tempRoot,
    TMP: layout.tmpRoot,
    projects: layout.projectRoot,
    vault: layout.vaultPath,
    install: layout.installDir,
  };
  const checks = {};
  for (const [name, value] of Object.entries(profilePaths)) {
    checks[name] = await inspectContainedPath(layout.root, value, io);
  }
  return checks;
}
