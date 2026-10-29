import { access, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFontAssets } from "./font-resources.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const buildResources = join(desktopRoot, "build-resources");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectory(source, destination) {
  if (!(await exists(source))) return false;
  await cp(source, destination, { recursive: true, force: true });
  return true;
}

await rm(buildResources, { recursive: true, force: true });
await mkdir(buildResources, { recursive: true });
await mkdir(join(buildResources, "fonts"), { recursive: true });

const packagedCli = join(repositoryRoot, "packages/cli/dist/cli.js");
if (!(await exists(packagedCli))) {
  throw new Error(
    "CLI bundle is missing. Run `pnpm --filter @siteindex/cli build` before preparing desktop resources.",
  );
}
await cp(packagedCli, join(buildResources, "cli.js"));

for (const directory of ["skills", "templates", "schemas"]) {
  await copyDirectory(join(repositoryRoot, directory), join(buildResources, directory));
}

const uiDist = join(repositoryRoot, "packages/ui/dist");
if (await exists(join(uiDist, "index.html"))) {
  await copyDirectory(uiDist, join(buildResources, "ui"));
} else {
  const fallback = join(desktopRoot, "out/renderer/fallback.html");
  await mkdir(join(buildResources, "ui"), { recursive: true });
  await cp(fallback, join(buildResources, "ui/index.html"));
}

const fontFiles = await copyFontAssets(uiDist, join(buildResources, "fonts"));
console.info(`Packaged ${fontFiles.length} UI font assets.`);
