import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const PRIVATE_KEYS = /(?:password|token|secret|credential|authorization|cookie|api[_-]?key)/iu;
const PRIVATE_VALUES = [
  /Bearer\s+[^\s,;]+/giu,
  /((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/giu,
  /(?:[A-Z]:\\Users\\|\/Users\/|\/home\/)[^\\/\s]+/giu,
];

export function redactEvidence(value, { secrets = [] } = {}) {
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item, { secrets }));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, PRIVATE_KEYS.test(key) ? "[redacted]" : redactEvidence(item, { secrets })]));
  if (typeof value !== "string") return value;
  let output = value;
  for (const secret of secrets) if (secret) output = output.replaceAll(secret, "[redacted]");
  for (const expression of PRIVATE_VALUES) output = output.replace(expression, (match, prefix) =>
    prefix ? `${prefix}[redacted]` : "[redacted]");
  return output.replace(/https?:\/\/[^\s"'()<>]+/giu, (url) => {
    try {
      return /(?:\.example\.test|localhost|127\.0\.0\.1)(?::\d+)?$/iu.test(new URL(url).host)
        ? url : "[redacted-url]";
    } catch {
      return "[redacted-url]";
    }
  });
}

export function createReport({ baseline, candidate, runner, osBuild, secrets = [] }) {
  if (!baseline?.sha256 || !candidate?.sha256) throw new Error("Both installer SHA256 values are required");
  const report = { run: { baseline, candidate, runner, os_build: osBuild }, items: [],
    cleanup: { status: "not_run", retries: 0 } };
  const add = ({ id, phase, status, evidence = [] }) => {
    if (!["passed", "assertion_failed", "harness_error", "not_run"].includes(status)) {
      throw new Error(`Invalid acceptance status: ${status}`);
    }
    report.items.push(redactEvidence({ id, phase, status, evidence }, { secrets }));
  };
  const failure = async ({ id, phase, error, kind, page, consoleMessages = [], lastIpc = null, outputDir }) => {
    const evidence = [{ message: error?.message ?? String(error), stack: error?.stack ?? "",
      console: consoleMessages, last_ipc: lastIpc }];
    if (page && outputDir) {
      const filename = `${String(id).replace(/[^a-z0-9_-]/giu, "_")}.png`;
      try {
        await page.screenshot({ path: path.join(outputDir, filename) });
        evidence.push({ screenshot: filename });
      } catch (captureError) {
        evidence.push({ screenshot_error: captureError?.message ?? String(captureError) });
        kind = "harness_error";
      }
    }
    add({ id, phase, status: kind, evidence });
  };
  const save = async (file) => {
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  };
  return { report, add, failure, save,
    setCleanup: (result) => { report.cleanup = redactEvidence(result, { secrets }); } };
}

export function assertPersisted(actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error("Saved setting was not persisted on readback");
}

export async function verifyInstallerDigest(file, expectedSha256) {
  if (!/^[a-f0-9]{64}$/iu.test(expectedSha256)) throw new Error("Expected installer SHA256 is invalid");
  const actualSha256 = createHash("sha256").update(await readFile(file)).digest("hex");
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error("Installer SHA256 mismatch");
  }
  return actualSha256;
}

export function assertNormalExit(result) {
  if (result?.method !== "window.close" && result?.method !== "WM_CLOSE") {
    throw new Error("H1 violation: application did not exit normally");
  }
  if (result.exitCode !== 0 || result.remainingProcesses !== 0) {
    throw new Error("H1 violation: application exit or process cleanup failed");
  }
}
