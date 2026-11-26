import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCoreErrorLogger, desktopErrorLogEntry } from "./diagnostic-log.js";

describe("Core application error log", () => {
  it("writes the stack locally after redacting credentials and paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "siteindex-log-test-"));
    try {
      createCoreErrorLogger(directory)({
        code: "WRITE_FAILED",
        operation: "projects.updateConfig",
        stack: "Error: password=CANARY_PASSWORD\nCookie: sid=CANARY_COOKIE\nC:\\Users\\Fixture CANARY_USER\\AppData\\site.json",
      });
      let line = "";
      await vi.waitFor(async () => {
        line = await readFile(join(directory, "siteindex-errors.log"), "utf8");
        expect(line).toContain("projects.updateConfig");
      });
      expect(line).toContain("WRITE_FAILED");
      expect(line).not.toMatch(/CANARY_PASSWORD|CANARY_COOKIE|CANARY_USER|AppData/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts a Desktop settings stack before it reaches the application log", () => {
    const failure = new Error("token=CANARY_TOKEN");
    failure.stack = "Error: token=CANARY_TOKEN\n    at C:\\Users\\Fixture CANARY_USER\\AppData\\settings.js:1:2";
    const entry = desktopErrorLogEntry("settings.set", failure);
    expect(entry.stack).not.toMatch(/CANARY_TOKEN|CANARY_USER|AppData/u);
    expect(entry.operation).toBe("settings.set");
  });
});
