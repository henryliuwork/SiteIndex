import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const packagedApp = path.join(repositoryRoot, "release-media-e2e", "win-unpacked", "SiteIndex.exe");
const summaryPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
const phaseNames = ["crash-worker", "read-recovery"];
const seed = randomBytes(16).toString("hex");
const canaries = [
  `fixture-user-${seed}`,
  `fixture-secret-${seed}`,
  `Basic ${Buffer.from(`fixture-user-${seed}:fixture-secret-${seed}`).toString("base64")}`,
];

function assertSafeTempRoot(root) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(root);
  if (!path.basename(resolved).startsWith("siteindex-media-recovery-") || !resolved.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error("Temporary test root failed its deletion guard.");
  }
}

async function runPhase(root, phaseName) {
  const resultPath = path.join(root, `${phaseName}.json`);
  await writeFile(resultPath, JSON.stringify({ status: "running", phase: phaseName }), "utf8");
  const isolatedLocalAppData = path.join(root, "local-app-data");
  const isolatedRoamingAppData = path.join(root, "roaming-app-data");
  const inheritedEnvironment = Object.fromEntries(
    [
      "PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE",
      "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP",
    ]
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
  const env = {
    ...inheritedEnvironment,
    LOCALAPPDATA: isolatedLocalAppData,
    APPDATA: isolatedRoamingAppData,
    SITEINDEX_MEDIA_E2E_PHASE: phaseName,
    SITEINDEX_MEDIA_E2E_PHASE_RESULT: resultPath,
    SITEINDEX_MEDIA_E2E_ROOT: root,
    SITEINDEX_MEDIA_E2E_REPO_ROOT: repositoryRoot,
    SITEINDEX_MEDIA_E2E_SEED: seed,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(packagedApp, [], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));
    const timeout = setTimeout(() => child.kill(), 180_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Packaged Electron failed to start (${error.name}).`));
    });
    child.once("close", async (code) => {
      clearTimeout(timeout);
      const capturedOutput = Buffer.concat(output);
      const canaryInOutput = canaries.some((value) => capturedOutput.includes(Buffer.from(value)));
      if (canaryInOutput) {
        reject(new Error(`Credential canary appeared in packaged process output during ${phaseName}.`));
        return;
      }
      try {
        const result = JSON.parse(await readFile(resultPath, "utf8"));
        if (code !== 0 || result.status !== "passed" || result.phase !== phaseName) {
          const state = typeof result.status === "string" ? result.status : "invalid-status";
          const reportPhase = typeof result.phase === "string" ? result.phase : "invalid-phase";
          reject(new Error(`Packaged phase ${phaseName} failed (exit ${code ?? "unknown"}; status ${state}; report phase ${reportPhase}; ${result.failureCode ?? "no failure code"}).`));
          return;
        }
        resolve(result);
      } catch (error) {
        const safeOutput = capturedOutput
          .toString("utf8")
          .replaceAll(root, "<E2E_TEMP>")
          .replaceAll(repositoryRoot, "<REPO>")
          .split(/\r?\n/u)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const exit = code === null ? "unknown" : String(code);
        const category = error instanceof Error && "code" in error && error.code === "ENOENT" ? "no-phase-report" : "invalid-phase-report";
        reject(new Error(`Packaged phase ${phaseName} failed (${category}; exit ${exit}; output lines ${safeOutput ? safeOutput.split(/\r?\n/u).length : 0}).${safeOutput ? `\n${safeOutput}` : ""}`));
      }
    });
  });
}

async function main() {
  if (!summaryPath) throw new Error("A summary output path is required.");
  const mainSource = await readFile(path.join(repositoryRoot, "packages", "desktop", "src", "main", "index.ts"), "utf8");
  const readinessSource = await readFile(
    path.join(repositoryRoot, "packages", "desktop", "src", "main", "media-readiness.ts"),
    "utf8",
  );
  if (
    !/isMediaJobReady:\s*\(\)\s*=>\s*isMediaPrepareReady\(mediaCore\)/u.test(mainSource) ||
    !/core\s*!==\s*null\s*&&\s*!pendingHandlers\.includes\("media\.prepare"\)/u.test(readinessSource)
  ) {
    throw new Error("Production media readiness is not guarded by the initialized Core and shared contract status.");
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-media-recovery-"));
  assertSafeTempRoot(root);
  try {
    await Promise.all([
      "local-app-data",
      "roaming-app-data",
    ].map((directory) => mkdir(path.join(root, directory), { recursive: true })));
    await mkdir(path.dirname(summaryPath), { recursive: true });
    const phases = {};
    for (const phaseName of phaseNames) phases[phaseName] = await runPhase(root, phaseName);
    const summary = {
      schemaVersion: 1,
      sourceCommit: process.env.SITEINDEX_MEDIA_E2E_SOURCE_COMMIT ?? "local",
      runner: "windows-latest",
      packagedElectron: true,
      productionMediaGateRemainsClosed: true,
      phases: Object.fromEntries(Object.entries(phases).map(([name, result]) => [name, result.checks ?? {}])),
      credentialCanaryAbsentFromProcessOutput: true,
    };
    const serialized = `${JSON.stringify(summary, null, 2)}\n`;
    if (canaries.some((value) => serialized.includes(value))) throw new Error("Credential canary appeared in the summary artifact.");
    await writeFile(summaryPath, serialized, "utf8");
    process.stdout.write(`${JSON.stringify({ status: "passed", summaryPath: path.basename(summaryPath), phases: phaseNames.length })}\n`);
  } finally {
    assertSafeTempRoot(root);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown hosted recovery test failure.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
