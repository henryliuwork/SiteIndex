import { access, cp, mkdir, readdir } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";

const FONT_EXTENSIONS = new Set([".woff", ".woff2", ".ttf", ".otf"]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findFonts(directory) {
  if (!(await exists(directory))) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findFonts(fullPath)));
    } else if (FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Copy every web font emitted by the UI build into the Desktop resource tree. */
export async function copyFontAssets(sourceDirectory, destinationDirectory) {
  const sourceFiles = await findFonts(sourceDirectory);
  const assets = sourceFiles
    .map((sourcePath) => ({ sourcePath, relativePath: relative(sourceDirectory, sourcePath) }))
    .sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );

  for (const asset of assets) {
    const targetPath = join(destinationDirectory, asset.relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(asset.sourcePath, targetPath);
  }

  return assets.map(({ relativePath }) => relativePath);
}
