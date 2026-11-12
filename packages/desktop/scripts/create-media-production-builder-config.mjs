import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
const config = structuredClone(packageJson.build);
if (!config || typeof config !== "object") throw new Error("Desktop electron-builder configuration is missing.");

const uiResources = config.extraResources?.filter((resource) => resource.to === "ui") ?? [];
if (uiResources.length !== 1 || uiResources[0].from !== "build-resources/ui") {
  throw new Error("Packaged media acceptance must use the unmodified production UI resource.");
}

async function listFileDigests(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.split(path.sep).join("/"), entry.name);
    if (entry.isSymbolicLink()) throw new Error("Production UI resources cannot contain symbolic links.");
    if (entry.isDirectory()) {
      files.push(...(await listFileDigests(root, child)));
      continue;
    }
    if (!entry.isFile()) throw new Error("Production UI resources contain an unsupported entry.");
    const bytes = await readFile(path.join(root, child));
    files.push([child, createHash("sha256").update(bytes).digest("hex")]);
  }
  return files.sort(([left], [right]) => left.localeCompare(right));
}

const productionUi = await listFileDigests(path.resolve(desktopDirectory, "../../packages/ui/dist"));
const packagedUi = await listFileDigests(path.join(desktopDirectory, "build-resources/ui"));
if (JSON.stringify(productionUi) !== JSON.stringify(packagedUi) || productionUi.length === 0) {
  throw new Error("Packaged media acceptance requires byte-identical, unmodified production UI resources.");
}

config.directories = { ...config.directories, output: "../../release-media-production-e2e" };
config.extraMetadata = { ...config.extraMetadata, main: "out/main/media-production-harness.js" };

await writeFile(
  path.join(desktopDirectory, "electron-builder.media-production.generated.json"),
  `${JSON.stringify(config, null, 2)}\n`,
  "utf8",
);
