import { describe, expect, it } from "vitest";
import type { JobProgress, JobResult } from "@siteindex/shared";
import {
  sanitizeJobProgress,
  sanitizeJobResult,
  sanitizeWorkerText,
  wordpressCredentialSensitiveValues,
  wordpressCredentialUsernames,
} from "./worker-output-sanitizer.js";

describe("utilityProcess output sanitization", () => {
  it("redacts known secrets, HTTP authorization, URL user info, and credential query values", () => {
    const canary = { username: "fictional-user", applicationPassword: "fictional-password-1234" };
    const basicToken = Buffer.from(`${canary.username}:${canary.applicationPassword}`).toString("base64");
    const message = `failed for ${canary.username}:${canary.applicationPassword}; Authorization: Basic ${basicToken}; ${basicToken}; https://name:secret@example.test; ?application_password=private; ?username=${canary.username}&user=${canary.username}`;
    const safe = sanitizeWorkerText(
      message,
      wordpressCredentialSensitiveValues(canary),
      wordpressCredentialUsernames(canary),
    );

    expect(safe).not.toContain(`${canary.username}:${canary.applicationPassword}`);
    expect(safe).not.toContain("fictional-password");
    expect(safe).not.toContain(basicToken);
    expect(safe).not.toContain("name:secret@");
    expect(safe).not.toContain("application_password=private");
    expect(safe).toContain("Authorization: [已隐藏]");
    expect(safe).toContain("?username=[已隐藏]&user=[已隐藏]");
    expect(sanitizeWorkerText(`operator ${canary.username}`, [], wordpressCredentialUsernames(canary))).toBe(
      "operator [已隐藏]",
    );
    expect(sanitizeWorkerText(`operator ${canary.username}`, wordpressCredentialSensitiveValues(canary))).toBe(
      `operator ${canary.username}`,
    );
  });

  it("sanitizes worker progress and finished errors before they reach IPC or run history", () => {
    const progress: JobProgress = {
      runId: "fictional-run",
      projectPath: "C:/workspace/siteindex",
      job: "weekly",
      pct: null,
      level: "error",
      message: "Authorization: Bearer fictional-token",
      at: "2026-11-11T00:00:00.000Z",
    };
    const result: JobResult & { projectPath: string } = {
      runId: "fictional-run",
      job: "weekly",
      status: "failed",
      exitCode: 1,
      summary: "请求 https://fictional-user:fictional-password@example.test 失败",
      errors: ["token=fictional-token", "login=fictional-user", "fictional-user:fictional-password"],
      steps: [{ key: "upload", status: "failed", message: "fictional-password" }],
      projectPath: "C:/workspace/siteindex",
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
    expect(JSON.parse(safeResult).projectPath).toBe("C:/workspace/siteindex");
  });

  it("redacts a short username only from text fields and preserves structured identifiers", () => {
    const credential = { username: "a", applicationPassword: "fictional-password" };
    const result: JobResult & { projectPath: string } = {
      runId: "fictional-run",
      job: "media",
      status: "failed",
      exitCode: 1,
      summary: "Authentication failed for user a",
      errors: ["Could not authenticate user a", "?username=a&user=a"],
      media_results: [
        {
          sku: "sku-a1",
          status: "failed",
          reason: "Account a was rejected",
          image_url: "https://cdn.example.test/image.jpg?user=a&size=large",
        },
      ],
      projectPath: "C:/workspace/a/siteindex",
    };

    const safe = sanitizeJobResult(
      result,
      wordpressCredentialSensitiveValues(credential),
      wordpressCredentialUsernames(credential),
    ) as JobResult & { projectPath: string };

    expect(safe.projectPath).toBe("C:/workspace/a/siteindex");
    expect(safe.media_results?.[0]?.sku).toBe("sku-a1");
    expect(safe.summary).toBe("Authentication failed for user [已隐藏]");
    expect(safe.errors?.[0]).toBe("Could not authenticate user [已隐藏]");
    expect(safe.errors?.[1]).toBe("?username=[已隐藏]&user=[已隐藏]");
    expect(safe.media_results?.[0]?.reason).toBe("Account [已隐藏] was rejected");
    expect(safe.media_results?.[0]?.image_url).toBe("https://cdn.example.test/image.jpg?user=[已隐藏]&size=large");
  });
});
