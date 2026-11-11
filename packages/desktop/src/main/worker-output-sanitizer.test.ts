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
      errors: ["Could not authenticate user a", "?username=a&user=a", "?username=admin"],
      media_results: [
        {
          sku: "sku-a1",
          status: "failed",
          reason: "Account a was rejected",
          image_url: "https://cdn.example.test/catalog/sku-a1/author/a/image.jpg?user=a&campaign=sku-a1&size=large",
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
    expect(safe.errors?.[2]).toBe("?username=admin");
    expect(safe.media_results?.[0]?.reason).toBe("Account [已隐藏] was rejected");
    expect(safe.media_results?.[0]?.image_url).toBe(
      "https://cdn.example.test/catalog/sku-a1/author/%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D/image.jpg?user=%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D&campaign=sku-a1&size=large",
    );
  });

  it("redacts usernames in URL paths and arbitrary query values, including encoded URLs", () => {
    const credential = { username: "alice@example.test", applicationPassword: "fictional-password" };
    const url =
      "https://alice%40example.test:fictional-password@cdn.example.test/author/alice%40example.test/image.jpg?author=alice%40example.test&user_name=alice%2540example.test&campaign=alice%40example.test";
    const result: JobResult = {
      runId: "fictional-run",
      job: "media",
      status: "failed",
      exitCode: 1,
      summary: `Could not fetch ${url}`,
      errors: [],
      media_results: [
        {
          sku: "sku-alice-1",
          status: "failed",
          image_url: encodeURIComponent(url),
        },
      ],
    };

    const safe = sanitizeJobResult(
      result,
      wordpressCredentialSensitiveValues(credential),
      wordpressCredentialUsernames(credential),
    );
    const safeSummary = safe.summary;
    const safeUrl = safe.media_results?.[0]?.image_url ?? "";

    expect(safeSummary).not.toContain("alice");
    expect(safeSummary).toContain("/author/%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D/");
    expect(safeSummary).toContain("author=%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D");
    expect(safeSummary).toContain("user_name=%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D");
    expect(safeSummary).toContain("campaign=%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D");
    expect(safeUrl).not.toContain("alice");
    expect(safe.media_results?.[0]?.sku).toBe("sku-alice-1");
  });

  it("redacts username tokens inside URL paths, compound query values, and fragments", () => {
    const credential = { username: "alice", applicationPassword: "fictional-password" };
    const url = "https://cdn.example.test/avatars/alice.jpg?author=user%3Aalice&campaign=sku-a1#alice";
    const result: JobResult = {
      runId: "fictional-run",
      job: "media",
      status: "failed",
      exitCode: 1,
      summary: `Could not fetch ${url}`,
      errors: [],
      media_results: [{ sku: "sku-a1", status: "failed", image_url: url }],
    };

    const safe = sanitizeJobResult(
      result,
      wordpressCredentialSensitiveValues(credential),
      wordpressCredentialUsernames(credential),
    );
    const safeUrl = safe.media_results?.[0]?.image_url ?? "";

    expect(safe.summary).not.toContain("/alice");
    expect(safe.summary).toContain("/avatars/%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D.jpg");
    expect(safe.summary).toContain("author=user%3A%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D");
    expect(safe.summary).toContain("campaign=sku-a1");
    expect(safe.summary).toContain("#%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D");
    expect(safeUrl).not.toContain("alice");
    expect(safe.media_results?.[0]?.sku).toBe("sku-a1");
  });

  it("redacts multi-encoded usernames and case-insensitive percent-encoded passwords", () => {
    const credential = { username: "alice", applicationPassword: "a/b" };
    const url = "https://cdn.example.test/avatars/%2561lice.jpg?author=user%253aalice&one=a%2fb&two=a%252fb#%2561lice";
    const result: JobResult = {
      runId: "fictional-run",
      job: "media",
      status: "failed",
      exitCode: 1,
      summary: `Could not fetch ${url}`,
      errors: ["remote returned https://cdn.example.test/?password=a%2fb&nested=a%252fb"],
      media_results: [{ sku: "sku-a1", status: "failed", image_url: encodeURIComponent(url) }],
    };

    const safe = sanitizeJobResult(
      result,
      wordpressCredentialSensitiveValues(credential),
      wordpressCredentialUsernames(credential),
    );
    const serialized = JSON.stringify(safe);

    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("a%2fb");
    expect(serialized).not.toContain("a%2Fb");
    expect(serialized).not.toContain("a%252fb");
    expect(serialized).not.toContain("a%252Fb");
    expect(serialized).toContain("sku-a1");
  });
});
