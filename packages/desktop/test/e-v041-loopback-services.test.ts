import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureTest = resolve(repositoryRoot, "fixtures/e-v041-loopback/fake-services.test.mjs");

describe("E v0.4.1 loopback mock fixtures", () => {
  it("runs the reusable service self-tests", () => {
    const result = spawnSync(process.execPath, ["--test", fixtureTest], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/tests 6/u);
    expect(output).toMatch(/fail 0/u);
  }, 40_000);
});
