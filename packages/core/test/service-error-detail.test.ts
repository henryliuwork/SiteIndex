import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PATHS, isSiteIndexError, type SiteIndexError } from "@siteindex/shared";
import { createCoreService } from "../src/service";
import { describeOperationError, redactDiagnosticText } from "../src/service/error-detail";

const roots: string[] = [];
const fixture = path.resolve("fixtures/e-v050-w0/projects/legacy");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-error-detail-"));
  roots.push(root);
  return root;
}

function makeService(projectPath: string, logError: (entry: { code: string; operation: string; stack: string }) => void) {
  return createCoreService({
    resolveProject: () => projectPath,
    deviceId: "synthetic-device",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
    logError,
  });
}

async function captureFailure(run: () => Promise<unknown>): Promise<SiteIndexError> {
  try {
    await run();
  } catch (error) {
    if (isSiteIndexError(error)) return error;
    throw error;
  }
  throw new Error("Expected operation to fail");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core operation error details", () => {
  it("adds operation details to config and README errors without returning config content or canaries", async () => {
    const root = await tempRoot();
    const canary = "V085_FAKE_TOKEN_7d2b";
    const projectPath = path.join(root, `synthetic-token=${canary}`);
    await cp(fixture, projectPath, { recursive: true });
    const sitePath = path.join(projectPath, PATHS.site);
    await writeFile(sitePath, `{"token":"${canary}"`, "utf8");

    const logError = vi.fn();
    const api = makeService(projectPath, logError);
    const configFailure = await captureFailure(() => api.projects.updateConfig("synthetic", { brand: { name: "Fixture" } }));
    const readmeGetFailure = await captureFailure(() => api.readme.get("synthetic"));
    const readmeRefreshFailure = await captureFailure(() => api.readme.refresh("synthetic"));

    expect(configFailure).toMatchObject({ code: "CONFIG_INVALID", message: "项目配置文件不是有效 JSON", detail: "项目配置 JSON 解析失败",
      error_detail: { code: "CONFIG_INVALID", operation: "projects.updateConfig" } });
    expect(readmeGetFailure).toMatchObject({ code: "CONFIG_INVALID", error_detail: { operation: "readme.get" } });
    expect(readmeRefreshFailure).toMatchObject({ code: "WRITE_FAILED", error_detail: { operation: "readme.refresh" } });
    expect(configFailure).not.toHaveProperty("stack");
    expect(readmeGetFailure).not.toHaveProperty("stack");
    expect(readmeRefreshFailure).not.toHaveProperty("stack");
    expect(JSON.stringify([configFailure, readmeGetFailure, readmeRefreshFailure])).not.toContain(canary);
    expect(JSON.stringify(logError.mock.calls)).not.toContain(canary);
    expect(logError).toHaveBeenCalledTimes(3);
    expect(logError.mock.calls.every(([entry]) => entry.stack.length > 0)).toBe(true);

    const savedContent = await readFile(sitePath, "utf8");
    expect(savedContent).toContain(canary);
  }, 30_000);

  it("adds diagnostics to README save failures while retaining the existing error code", async () => {
    const root = await tempRoot();
    const canary = "V085_FAKE_CREDENTIAL_91a4";
    const cloudRoot = path.join(root, `token=${canary}`);
    const projectPath = path.join(cloudRoot, "synthetic");
    await cp(fixture, projectPath, { recursive: true });
    vi.stubEnv("OneDrive", cloudRoot);

    const logError = vi.fn();
    const api = makeService(projectPath, logError);
    const failure = await captureFailure(() => api.readme.saveUserBlocks("synthetic", {
      overview: "Fixture overview",
      focus: "Fixture focus",
      rules: "Fixture rules",
    }));

    expect(failure).toMatchObject({
      code: "PROJECT_CLOUD_SYNC_UNSUPPORTED",
      error_detail: { code: "PROJECT_CLOUD_SYNC_UNSUPPORTED", operation: "readme.saveUserBlocks" },
    });
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(JSON.stringify(logError.mock.calls)).not.toContain(canary);
    expect(logError).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("redacts home paths and credential-shaped values in diagnostics", () => {
    const canary = "V085_SYNTHETIC_SECRET";
    const safe = redactDiagnosticText(
      `C:\\Users\\Fixture\\Project\\index\\site.json token=${canary} Authorization: Bearer ${canary}\nCookie: session=${canary}`,
      { homeDirectory: "C:\\Users\\Fixture", projectPath: "C:\\Users\\Fixture\\Project" },
    );

    expect(safe).toContain("~");
    expect(safe).toContain("[REDACTED]");
    expect(safe).not.toContain(canary);
  });

  it("maps native filesystem codes to the registered Core write error code", () => {
    const canary = "V085_FAKE_TOKEN_NATIVE_ERROR";
    const filesystemError = Object.assign(
      new Error(`EISDIR: token=${canary}`),
      { code: "EISDIR", errno: -21 },
    );
    const diagnostic = describeOperationError(filesystemError, "readme.saveUserBlocks", "D:\\synthetic-project");

    expect(diagnostic.error).toMatchObject({ code: "WRITE_FAILED", error_detail: { code: "WRITE_FAILED" } });
    expect(JSON.stringify(diagnostic)).not.toContain(canary);
  });
});
