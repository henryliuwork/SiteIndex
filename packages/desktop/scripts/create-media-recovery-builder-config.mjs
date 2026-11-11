import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
const config = structuredClone(packageJson.build);
if (!config || typeof config !== "object") throw new Error("Desktop electron-builder configuration is missing.");
config.directories = { ...config.directories, output: "../../release-media-e2e" };
config.extraMetadata = { ...config.extraMetadata, main: "out/main/media-recovery-harness.js" };

await writeFile(
  path.join(desktopDirectory, "electron-builder.media-recovery.generated.json"),
  `${JSON.stringify(config, null, 2)}\n`,
  "utf8",
);
