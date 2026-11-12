import { evaluateCredentialIsolationReport } from "../../../fixtures/e-v041-loopback/credential-isolation-report-oracle.mjs";

export function attachCredentialIsolationOracle(report, canaryValues = []) {
  const evaluation = evaluateCredentialIsolationReport(report, canaryValues);
  const result = { passed: evaluation.passed, failureCodes: [...evaluation.failureCodes] };
  const checks = Array.isArray(report.checks) ? report.checks : [];

  report.credentialIsolationOracle = result;
  report.checks = [
    ...checks,
    {
      name: "E #461 credential isolation report oracle",
      status: result.passed ? "passed" : "failed",
      evidence: { failureCodes: result.failureCodes },
    },
  ];

  return result;
}
