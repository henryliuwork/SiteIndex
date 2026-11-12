import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
const config = structuredClone(packageJson.build);
if (!config || typeof config !== "object") throw new Error("Desktop electron-builder configuration is missing.");

const uiResources = config.extraResources?.filter((resource) => resource.to === "ui") ?? [];
if (uiResources.length !== 1 || uiResources[0].from !== "build-resources/ui") {
  throw new Error("Expected exactly one production UI extraResource before generating the isolated E2E config.");
}
config.extraResources = config.extraResources.map((resource) =>
  resource.to === "ui" ? { ...resource, from: "build-resources/ui-media-e2e" } : resource,
);
config.directories = { ...config.directories, output: "../../release-media-production-e2e" };
config.extraMetadata = { ...config.extraMetadata, main: "out/main/media-production-harness.js" };

await writeFile(
  path.join(desktopDirectory, "electron-builder.media-production.generated.json"),
  `${JSON.stringify(config, null, 2)}\n`,
  "utf8",
);
