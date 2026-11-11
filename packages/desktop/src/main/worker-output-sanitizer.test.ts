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

    expect(safe).not.toContain(`${canary.username}:${canary.applicationPassword}`);
    expect(safe).not.toContain("fictional-password");
    expect(safe).not.toContain(basicToken);
    expect(safe).not.toContain("name:secret@");
    expect(safe).not.toContain("application_password=private");
    expect(safe).toContain("Authorization: [已隐藏]");
    expect(sanitizeWorkerText(`?username=${canary.username}&user=${canary.username}`)).toBe(
      `?username=${canary.username}&user=${canary.username}`,
    );
    expect(sanitizeWorkerText(`operator ${canary.username}`, wordpressCredentialSensitiveValues(canary))).toBe(
      `operator ${canary.username}`,
    );
  });

  it("sanitizes worker progress and finished errors before they reach IPC or run history", () => {
    const progress: JobProgress = {
      runId: "fictional-run",
      projectPath: "C:/fictional-token/project",
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
      errors: ["token=fictional-token", "login=fictional-user", "fictional-user:fictional-password"],
      steps: [{ key: "upload", status: "failed", message: "fictional-password" }],
    };

    const safeProgress = JSON.stringify(sanitizeJobProgress(progress, ["fictional-token"]));
    expect(safeProgress).not.toContain("fictional-token");
    const safeResult = JSON.stringify(
      sanitizeJobResult(result, [
        ...wordpressCredentialSensitiveValues({
          username: "fictional-user",
          applicationPassword: "fictional-password",
        }),
        "fictional-token",
      ]),
    );
    expect(safeResult).not.toContain("fictional-password");
    expect(safeResult).not.toContain("fictional-token");
    expect(safeResult).toContain("login=fictional-user");
    expect(safeResult).not.toContain("fictional-user:fictional-password");
  });
});
