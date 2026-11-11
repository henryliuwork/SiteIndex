import { describe, expect, it } from "vitest";
import type { JobProgress, JobResult } from "@siteindex/shared";
import {
  sanitizeJobProgress,
  sanitizeJobResult,
  sanitizeWorkerText,
  wordpressCredentialSensitiveValues,
} from "./worker-output-sanitizer.js";

describe("utilityProcess output sanitization", () => {
  it("redacts known secrets, HTTP authorization, URL user info, and credential query values", () => {
    const canary = { username: "fictional-user", applicationPassword: "fictional-password-1234" };
    const basicToken = Buffer.from(`${canary.username}:${canary.applicationPassword}`).toString("base64");
    const message = `failed for ${canary.username}:${canary.applicationPassword}; Authorization: Basic ${basicToken}; ${basicToken}; https://name:secret@example.test; ?application_password=private`;
    const safe = sanitizeWorkerText(message, wordpressCredentialSensitiveValues(canary));

    expect(safe).not.toContain("fictional-user");
    expect(safe).not.toContain("fictional-password");
    expect(safe).not.toContain(basicToken);
    expect(safe).not.toContain("name:secret@");
    expect(safe).not.toContain("application_password=private");
    expect(safe).toContain("Authorization: [已隐藏]");
  });

  it("sanitizes worker progress and finished errors before they reach IPC or run history", () => {
    const progress: JobProgress = {
      runId: "fictional-run",
      projectPath: "C:/fictional/project",
      job: "weekly",
      pct: null,
      level: "error",
      message: "Authorization: Bearer fictional-token",
      at: "2026-11-11T00:00:00.000Z",
    };
    const result: JobResult = {
      runId: "fictional-run",
      job: "weekly",
      status: "failed",
      exitCode: 1,
      summary: "请求 https://fictional-user:fictional-password@example.test 失败",
      errors: ["token=fictional-token", "username=fictional-user"],
      steps: [{ key: "upload", status: "failed", message: "fictional-password" }],
    };

    expect(JSON.stringify(sanitizeJobProgress(progress, ["fictional-token"]))).not.toContain("fictional-token");
    const safeResult = JSON.stringify(
      sanitizeJobResult(result, ["fictional-user", "fictional-password", "fictional-token"]),
    );
    expect(safeResult).not.toContain("fictional-user");
    expect(safeResult).not.toContain("fictional-password");
    expect(safeResult).not.toContain("fictional-token");
  });
});
