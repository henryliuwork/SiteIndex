import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPackagedPlaywright } from "../src/browser/automation";

describe("packaged CLI browser dependency", () => {
  it("resolves playwright-core from resources/app.asar.unpacked/node_modules", async () => {
    const resources = await mkdtemp(path.join(os.tmpdir(), "siteindex-resources-"));
    try {
      const modulePath = path.join(resources, "app.asar.unpacked", "node_modules", "playwright-core");
      await mkdir(modulePath, { recursive: true });
      await writeFile(path.join(modulePath, "package.json"), JSON.stringify({ name: "playwright-core", main: "index.cjs" }));
      await writeFile(path.join(modulePath, "index.cjs"), 'exports.chromium = { packaged: true };\n');
      expect(loadPackagedPlaywright(resources).chromium).toMatchObject({ packaged: true });
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
  });
});
