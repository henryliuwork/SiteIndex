import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appSettingsHandlers } from "./app-settings-adapters.mjs";
import { categoryScheduleHandlers } from "./category-schedule-adapters.mjs";
import { sensitiveSystemHandlers } from "./credential-schedule-adapters.mjs";
import { independentHandlers } from "./independent-adapters.mjs";
import { projectConfigHandlers } from "./project-config-adapters.mjs";
import { productDiscoveryAdapter } from "./product-discovery-adapter.mjs";
import { searchInputAdapter } from "./search-input-adapter.mjs";
import { parseItemRange, runAcceptance } from "./runner.mjs";

export const ACCEPTANCE_MATRICES = Object.freeze({
  v085: { min: 1, max: 83, baselineRef: "v0.8.4" },
  v090: { min: 84, max: 86, baselineRef: "v0.8.5" },
});
const REQUIRED_PHASES = ["baselineUi", "verifyBaselineIpc", "verifyBaselineFile",
  "candidateUi", "verifyCandidateIpc", "verifyCandidateFile"];

export function parseAcceptanceArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!["--items", "--baseline", "--candidate", "--manifest", "--output-dir", "--matrix"].includes(key)
      || !args[index + 1] || options[key]) throw new Error(`Invalid acceptance argument: ${key}`);
    options[key] = args[index + 1];
  }
  if (["--items", "--baseline", "--candidate", "--manifest", "--output-dir"].some((key) => !options[key])) {
    throw new Error("Items, baseline, candidate, manifest and output-dir are required");
  }
  const matrix = options["--matrix"] ?? "v085";
  const bounds = ACCEPTANCE_MATRICES[matrix];
  if (!bounds) throw new Error(`Unknown acceptance matrix: ${matrix}`);
  return { matrix, itemIds: parseItemRange(options["--items"], bounds), itemsArgument: options["--items"], baselineRef: options["--baseline"],
    candidateRef: options["--candidate"], manifest: options["--manifest"], outputDir: options["--output-dir"] };
}

export function acceptanceHandlers(ids, credentials, extraHandlers = {}) {
  const slice = (first, last) => ids.filter((id) => id >= first && id <= last);
  return { ...projectConfigHandlers(slice(1, 45)),
    ...categoryScheduleHandlers(slice(46, 60)),
    ...independentHandlers(slice(61, 66)),
    ...appSettingsHandlers(slice(67, 81)),
    ...sensitiveSystemHandlers(slice(82, 83), credentials),
    ...(ids.includes(85) ? { 85: searchInputAdapter() } : {}),
    ...(ids.includes(86) ? { 86: productDiscoveryAdapter() } : {}),
    ...Object.fromEntries(ids.filter((id) => id >= 84 && extraHandlers[id]).map((id) => [id, extraHandlers[id]])) };
}

export async function runFromManifest(options, { run = runAcceptance, extraHandlers = {} } = {}) {
  const matrix = options.matrix ?? "v085";
  const bounds = ACCEPTANCE_MATRICES[matrix];
  if (!bounds) throw new Error(`Unknown acceptance matrix: ${matrix}`);
  const itemIds = parseItemRange(options.itemsArgument ?? options.itemIds.join(","), bounds);
  const sources = JSON.parse(await readFile(options.manifest, "utf8"));
  if (options.baselineRef !== bounds.baselineRef || sources.baseline?.kind !== "release"
    || sources.baseline?.ref !== options.baselineRef || sources.candidate?.kind !== "run-artifact"
    || sources.candidate?.ref !== options.candidateRef) {
    throw new Error("Acceptance refs and pinned source manifest do not match");
  }
  const credentials = { username: `synthetic-user-${randomBytes(8).toString("hex")}`,
    applicationPassword: randomBytes(24).toString("hex") };
  const handlers = acceptanceHandlers(itemIds, credentials, extraHandlers);
  for (const id of itemIds) if (REQUIRED_PHASES.some((phase) => typeof handlers[id]?.[phase] !== "function")) {
    throw new Error(`Acceptance adapter ${id} is not connected`);
  }
  return run({ itemIds, itemsArgument: options.itemsArgument, itemBounds: bounds, baseline: sources.baseline, candidate: sources.candidate,
    handlers, outputDir: options.outputDir,
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
