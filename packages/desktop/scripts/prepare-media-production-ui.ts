import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMediaProductionUi } from "../src/main/media-production-ui.js";

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildResources = path.join(desktopDirectory, "build-resources");

await createMediaProductionUi(path.join(buildResources, "ui"), path.join(buildResources, "ui-media-e2e"));
process.stdout.write("Prepared isolated packaged EDM UI test resource.\n");
