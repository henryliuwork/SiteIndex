import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface ProfilePathDiagnostic {
  withinRoot: boolean;
  noReparse: boolean;
}

export type ProfilePathDiagnosticSet = Record<string, ProfilePathDiagnostic>;

interface ProfilePathFs {
  lstat: typeof lstat;
  realpath: typeof realpath;
}

const defaultFs: ProfilePathFs = { lstat, realpath };

function isReparsePoint(stats: Awaited<ReturnType<typeof lstat>>): boolean {
  const attributes = (stats as typeof stats & { attributes?: number }).attributes;
  return (
    process.platform === "win32" &&
    (stats.isSymbolicLink() || (typeof attributes === "number" && (attributes & 0x400) !== 0))
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function inspectPath(root: string, candidate: string, fs: ProfilePathFs): Promise<ProfilePathDiagnostic> {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate) || !isWithin(root, candidate)) {
    return { withinRoot: false, noReparse: false };
  }

  let rootReal: string;
  let candidateReal: string;
  try {
    [rootReal, candidateReal] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  } catch {
    return { withinRoot: false, noReparse: false };
  }

  const physicallyWithin = isWithin(rootReal, candidateReal);
  let noReparse = true;
  let current = path.resolve(candidate);
  const filesystemRoot = path.parse(current).root;
  while (true) {
    try {
      if (isReparsePoint(await fs.lstat(current))) noReparse = false;
    } catch {
      noReparse = false;
    }
    if (current.toLowerCase() === filesystemRoot.toLowerCase()) break;
    const parent = path.dirname(current);
    if (parent.toLowerCase() === current.toLowerCase()) {
      noReparse = false;
      break;
    }
    current = parent;
  }

  return { withinRoot: physicallyWithin, noReparse };
}

export async function inspectProfilePaths(
  root: string,
  paths: Record<string, string | undefined>,
  fs: ProfilePathFs = defaultFs,
): Promise<ProfilePathDiagnosticSet> {
  const results: ProfilePathDiagnosticSet = {};
  for (const [name, candidate] of Object.entries(paths)) {
    results[name] = candidate ? await inspectPath(root, candidate, fs) : { withinRoot: false, noReparse: false };
  }
  return results;
}

export function profilePathsAreContained(results: ProfilePathDiagnosticSet): boolean {
  return (
    Object.keys(results).length > 0 && Object.values(results).every((result) => result.withinRoot && result.noReparse)
  );
}
