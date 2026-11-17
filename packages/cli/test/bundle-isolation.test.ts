import { cp, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliDir = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsupCli = fileURLToPath(new URL("../node_modules/tsup/dist/cli-default.js", import.meta.url));

describe("standalone CLI bundle", () => {
  it("runs help and a fictional project query without node_modules", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-cli-standalone-"));
    try {
      const build = spawnSync(process.execPath, [tsupCli, "--config", "tsup.config.ts"], {
        cwd: cliDir, encoding: "utf8", timeout: 60_000,
      });
      expect(build.status, build.stderr || build.stdout).toBe(0);
      const bundle = path.join(root, "cli.js");
      await copyFile(path.join(cliDir, "dist", "cli.js"), bundle);
      await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
      const project = path.join(root, "demo-project");
      await cp(path.join(repositoryRoot, "fixtures", "expected", "project"), project, { recursive: true });
      const run = (...args: string[]) => spawnSync(process.execPath, [bundle, ...args], {
        cwd: root, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, APPDATA: root, XDG_CONFIG_HOME: root },
      });
      const help = run("--help");
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain("用法:");
      const query = run("query", project, "products", "--size", "1", "--json");
      expect(query.status, query.stderr || query.stdout).toBe(0);
      expect(JSON.parse(query.stdout)).toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
