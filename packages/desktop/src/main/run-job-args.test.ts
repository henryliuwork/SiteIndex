import { describe, expect, it } from "vitest";
import { parseRunJobArguments } from "./run-job-args.js";

describe("headless run-job arguments", () => {
  it("reads a project path and supported job following --run-job", () => {
    expect(parseRunJobArguments(["SiteIndex.exe", "--run-job", "D:\\Projects\\Alpha", "daily"])).toEqual({
      projectPath: "D:\\Projects\\Alpha",
      job: "daily",
    });
  });

  it("rejects missing, unsupported, or trailing arguments", () => {
    expect(parseRunJobArguments(["SiteIndex.exe", "--run-job"])).toBeNull();
    expect(parseRunJobArguments(["SiteIndex.exe", "--run-job", "D:\\Projects\\Alpha", "other"])).toBeNull();
    expect(parseRunJobArguments(["SiteIndex.exe", "--run-job", "D:\\Projects\\Alpha", "daily", "--force"])).toBeNull();
    expect(parseRunJobArguments(["SiteIndex.exe", "daily"])).toBeNull();
  });
});
