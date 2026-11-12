import { describe, expect, it } from "vitest";
import { HOSTED_WINDOWS_ACCEPTANCE_ARGUMENT, isHostedWindowsAcceptanceMode } from "./hosted-acceptance-mode.js";

const validOptions = {
  isPackaged: true,
  platform: "win32",
  argv: ["SiteIndex.exe", HOSTED_WINDOWS_ACCEPTANCE_ARGUMENT],
  environment: {
    GITHUB_ACTIONS: "true",
    SITEINDEX_RUNNER_ENVIRONMENT: "github-hosted",
    SITEINDEX_HOSTED_ACCEPTANCE: "1",
  },
};

describe("hosted Windows acceptance mode", () => {
  it("is enabled only by the packaged GitHub-hosted Windows runner opt-in", () => {
    expect(isHostedWindowsAcceptanceMode(validOptions)).toBe(true);
    expect(isHostedWindowsAcceptanceMode({ ...validOptions, isPackaged: false })).toBe(false);
    expect(isHostedWindowsAcceptanceMode({ ...validOptions, platform: "darwin" })).toBe(false);
    expect(isHostedWindowsAcceptanceMode({ ...validOptions, argv: ["SiteIndex.exe"] })).toBe(false);
    expect(isHostedWindowsAcceptanceMode({ ...validOptions, environment: { ...validOptions.environment, GITHUB_ACTIONS: "false" } })).toBe(false);
    expect(isHostedWindowsAcceptanceMode({ ...validOptions, environment: { ...validOptions.environment, SITEINDEX_RUNNER_ENVIRONMENT: "self-hosted" } })).toBe(false);
    expect(isHostedWindowsAcceptanceMode({ ...validOptions, environment: { GITHUB_ACTIONS: "true" } })).toBe(false);
  });
});
