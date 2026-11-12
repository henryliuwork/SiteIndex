export function summarizePackagedPhaseFailure({
  phase,
  exitCode,
  resultReportStatus,
  reportFailureCode,
  capturedOutput,
}) {
  const safePhase = /^[a-z0-9-]{1,40}$/u.test(phase) ? phase : "unknown-phase";
  const output = String(capturedOutput ?? "");
  const harnessFailureCode = output.match(
    new RegExp(`media-production:${safePhase}:failed:([a-z0-9-]{1,60})`, "u"),
  )?.[1];
  const safeStages = [
    "bootstrap",
    "contract-ready",
    "electron-ready",
    "renderer-ready",
    "media-rows-ready",
    "media-selection-ready",
    "media-action-ready",
    "job-started",
    "job-finished",
    "report-ready",
    "report-written",
    "retry-history-verified",
    "caught-error",
    "report-write-failed",
  ];
  const stagePattern = new RegExp(`media-production:${safePhase}:stage:(${safeStages.join("|")})`, "gu");
  const phaseStages = [...output.matchAll(stagePattern)].map((match) => match[1]);
  const caughtErrorIndex = phaseStages.lastIndexOf("caught-error");
  const phaseStage = caughtErrorIndex >= 0 ? (phaseStages[caughtErrorIndex - 1] ?? null) : (phaseStages.at(-1) ?? null);
  const safeReportFailureCode = /^[a-z0-9-]{1,60}$/u.test(String(reportFailureCode ?? ""))
    ? String(reportFailureCode)
    : undefined;
  const failureClass = output.includes("The specified module could not be found")
    ? "native-module-load"
    : output.includes("Cannot find module")
      ? "module-resolution"
      : /JavaScript error occurred in the main process|uncaught exception/iu.test(output)
        ? "main-process-exception"
        : output.trim().length > 0
          ? "unclassified-process-output"
          : "no-process-output";

  return {
    phase: safePhase,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    resultReportStatus: ["passed", "failed", "running", "missing", "invalid-json", "invalid-shape"].includes(
      resultReportStatus,
    )
      ? resultReportStatus
      : "invalid-status",
    failureCode: safeReportFailureCode ?? harnessFailureCode ?? null,
    failureClass,
    phaseStage,
    outputLineCount: output.split(/\r?\n/u).filter(Boolean).length,
  };
}
