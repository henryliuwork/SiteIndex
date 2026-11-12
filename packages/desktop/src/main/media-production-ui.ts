import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MEDIA_PENDING_GATE =
  /([\w$]+)\.includes\(`media\.prepare`\)\?\{available:!1,message:`当前版本暂未开放图片准备功能。`\}:/gu;
const TEST_BYPASS_PREFIX = "!1?{available:!1,message:`当前版本暂未开放图片准备功能。`}:";

export function bypassPendingMediaGateForTestBundle(source: string): string {
  const matches = [...source.matchAll(MEDIA_PENDING_GATE)];
  if (matches.length !== 1) {
    throw new Error(`Expected one compiled EDM media pending gate; found ${matches.length}.`);
  }
  return source.replace(MEDIA_PENDING_GATE, TEST_BYPASS_PREFIX);
}

function resolveIsolatedUiPaths(
  sourceDirectory: string,
  destinationDirectory: string,
): {
  source: string;
  destination: string;
} {
  const source = path.resolve(sourceDirectory);
  const destination = path.resolve(destinationDirectory);
  if (
    path.basename(source) !== "ui" ||
    path.basename(destination) !== "ui-media-e2e" ||
    path.basename(path.dirname(source)) !== "build-resources" ||
    path.dirname(source) !== path.dirname(destination)
  ) {
    throw new Error("Media E2E UI paths must be sibling build resources named ui and ui-media-e2e.");
  }
  return { source, destination };
}

export async function createMediaProductionUi(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  const { source, destination } = resolveIsolatedUiPaths(sourceDirectory, destinationDirectory);
  const indexPath = path.join(source, "index.html");
  const sourceStat = await readFile(indexPath, "utf8").catch(() => null);
  if (!sourceStat) throw new Error("Production UI build is missing index.html.");

  const assetDirectory = path.join(source, "assets");
  const assets = await readdir(assetDirectory, { withFileTypes: true });
  const edmBundles = assets.filter((entry) => entry.isFile() && /^EdmPage-.*\.js$/u.test(entry.name));
  if (edmBundles.length !== 1) throw new Error(`Expected one compiled EDM page bundle; found ${edmBundles.length}.`);

  const relativeBundle = path.join("assets", edmBundles[0]!.name);
  const originalBundle = await readFile(path.join(source, relativeBundle), "utf8");
  const unlockedTestBundle = bypassPendingMediaGateForTestBundle(originalBundle);
  if (unlockedTestBundle === originalBundle) throw new Error("The test-only media gate transform made no change.");

  // Delete only the exact sibling output reserved for this generated test UI.
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  await writeFile(path.join(destination, relativeBundle), unlockedTestBundle, "utf8");
}
