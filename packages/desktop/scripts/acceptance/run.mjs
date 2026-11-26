import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appSettingsHandlers } from "./app-settings-adapters.mjs";
import { categoryScheduleHandlers } from "./category-schedule-adapters.mjs";
import { sensitiveSystemHandlers } from "./credential-schedule-adapters.mjs";
import { independentHandlers } from "./independent-adapters.mjs";
import { projectConfigHandlers } from "./project-config-adapters.mjs";
import { parseItemRange, runAcceptance } from "./runner.mjs";

export function parseAcceptanceArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!["--items", "--baseline", "--candidate", "--manifest", "--output-dir"].includes(key)
      || !args[index + 1] || options[key]) throw new Error(`Invalid acceptance argument: ${key}`);
    options[key] = args[index + 1];
  }
  if (Object.keys(options).length !== 5) throw new Error("Items, baseline, candidate, manifest and output-dir are required");
  return { itemIds: parseItemRange(options["--items"]), itemsArgument: options["--items"], baselineRef: options["--baseline"],
    candidateRef: options["--candidate"], manifest: options["--manifest"], outputDir: options["--output-dir"] };
}

export function acceptanceHandlers(ids, credentials) {
  const slice = (first, last) => ids.filter((id) => id >= first && id <= last);
  return { ...projectConfigHandlers(slice(1, 45)),
    ...categoryScheduleHandlers(slice(46, 60)),
    ...independentHandlers(slice(61, 66)),
    ...appSettingsHandlers(slice(67, 81)),
    ...sensitiveSystemHandlers(slice(82, 83), credentials) };
}

export async function runFromManifest(options, { run = runAcceptance } = {}) {
  const sources = JSON.parse(await readFile(options.manifest, "utf8"));
  if (options.baselineRef !== "v0.8.4" || sources.baseline?.kind !== "release"
    || sources.baseline?.ref !== options.baselineRef || sources.candidate?.kind !== "run-artifact"
    || sources.candidate?.ref !== options.candidateRef) {
    throw new Error("Acceptance refs and pinned source manifest do not match");
  }
  const credentials = { username: `synthetic-user-${randomBytes(8).toString("hex")}`,
    applicationPassword: randomBytes(24).toString("hex") };
  return run({ itemIds: options.itemIds, itemsArgument: options.itemsArgument, baseline: sources.baseline, candidate: sources.candidate,
    handlers: acceptanceHandlers(options.itemIds, credentials), outputDir: options.outputDir,
    secrets: [credentials.username, credentials.applicationPassword] });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const report = await runFromManifest(parseAcceptanceArgs(process.argv.slice(2)));
    if (report.items.some((item) => item.status !== "passed") || report.cleanup.status !== "passed") {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`Acceptance harness error: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
