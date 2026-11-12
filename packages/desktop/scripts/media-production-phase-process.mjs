import { summarizePackagedPhaseFailure } from "./media-production-diagnostics.mjs";

function isPhaseReport(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Runs one packaged phase and validates its private result report.
 * Diagnostics contain only allowlisted metadata; child output is never included in errors.
 */
export function runPackagedPhaseProcess({
  executable,
  env,
  phase,
  reportPath,
  spawnProcess,
  readReport,
  credentialCanaryBytes = [],
  onFailureDiagnostic = () => {},
  timeoutMs = 180_000,
}) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const output = [];
    const setDiagnostic = (diagnostic) => {
      try {
        onFailureDiagnostic(diagnostic);
      } catch {
        // Diagnostics must not change the phase result.
      }
    };
    const finish = (error, value) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
      return true;
    };
    const timeout = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // The close event will report the process outcome.
      }
    }, timeoutMs);

    try {
      child = spawnProcess(executable, [], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));
    } catch {
      setDiagnostic(
        summarizePackagedPhaseFailure({
          phase,
          exitCode: null,
          resultReportStatus: "missing",
          reportFailureCode: "child-spawn-failed",
          capturedOutput: "",
        }),
      );
      finish(new Error(`Packaged phase ${phase} could not start.`));
      return;
    }

    child.once("error", () => {
      if (settled) return;
      setDiagnostic(
        summarizePackagedPhaseFailure({
          phase,
          exitCode: null,
          resultReportStatus: "missing",
          reportFailureCode: "child-spawn-failed",
          capturedOutput: "",
        }),
      );
      finish(new Error(`Packaged phase ${phase} could not start.`));
    });

    child.once("close", async (code) => {
      if (settled) return;
      const captured = Buffer.concat(output);
      const capturedCanaryMatches = credentialCanaryBytes.filter((value) => captured.includes(value)).length;
      if (capturedCanaryMatches > 0) {
        setDiagnostic(
          summarizePackagedPhaseFailure({
            phase,
            exitCode: code,
            resultReportStatus: "invalid-status",
            reportFailureCode: "credential-canary-output",
            capturedOutput: "",
          }),
        );
        finish(new Error(`Packaged phase ${phase} leaked a credential canary in process output.`));
        return;
      }

      const capturedText = captured.toString("utf8");
      let reportText;
      try {
        reportText = await readReport(reportPath);
      } catch {
        if (settled) return;
        const diagnostic = summarizePackagedPhaseFailure({
          phase,
          exitCode: code,
          resultReportStatus: "missing",
          capturedOutput: capturedText,
        });
        setDiagnostic(diagnostic);
        finish(
          new Error(
            `Packaged phase ${phase} result report missing (exit ${code ?? "unknown"}; class ${diagnostic.failureClass}; code ${diagnostic.failureCode ?? "none"}; output lines ${diagnostic.outputLineCount}).`,
          ),
        );
        return;
      }

      let report;
      try {
        report = JSON.parse(reportText);
      } catch {
        if (settled) return;
        const diagnostic = summarizePackagedPhaseFailure({
          phase,
          exitCode: code,
          resultReportStatus: "invalid-json",
          capturedOutput: capturedText,
        });
        setDiagnostic(diagnostic);
        finish(
          new Error(
            `Packaged phase ${phase} result report invalid (exit ${code ?? "unknown"}; class ${diagnostic.failureClass}; output lines ${diagnostic.outputLineCount}).`,
          ),
        );
        return;
      }

      if (!isPhaseReport(report) || typeof report.status !== "string" || typeof report.phase !== "string") {
        if (settled) return;
        const diagnostic = summarizePackagedPhaseFailure({
          phase,
          exitCode: code,
          resultReportStatus: "invalid-shape",
          capturedOutput: capturedText,
        });
        setDiagnostic(diagnostic);
        finish(
          new Error(
            `Packaged phase ${phase} result report has an invalid shape (exit ${code ?? "unknown"}; class ${diagnostic.failureClass}; output lines ${diagnostic.outputLineCount}).`,
          ),
        );
        return;
      }

      if (code !== 0 || report.status !== "passed" || report.phase !== phase) {
        if (settled) return;
        const diagnostic = summarizePackagedPhaseFailure({
          phase,
          exitCode: code,
          resultReportStatus: report.status,
          reportFailureCode: report.failureCode,
          capturedOutput: capturedText,
        });
        setDiagnostic(diagnostic);
        finish(
          new Error(
            `Packaged phase ${phase} failed (exit ${code ?? "unknown"}; class ${diagnostic.failureClass}; code ${diagnostic.failureCode ?? "none"}; output lines ${diagnostic.outputLineCount}).`,
          ),
        );
        return;
      }

      finish(null, report);
    });
  });
}
