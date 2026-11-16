import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readSchemaFile } from "../src/io/schema-file";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-schema-path-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readSchemaFile", () => {
  it("loads schemas beside a packaged flat CLI bundle", async () => {
    const root = await tempDir();
    const resources = path.join(root, "resources");
    await mkdir(path.join(resources, "schemas"), { recursive: true });
    await writeFile(path.join(resources, "schemas", "probe.schema.json"), "{\"source\":\"resources\"}", "utf8");

    const result = await readSchemaFile("probe", pathToFileURL(path.join(resources, "cli.js")).href, "../../../../schemas");

    expect(result).toBe("{\"source\":\"resources\"}");
  });

  it("loads schemas from the repository root beside a locally built CLI", async () => {
    const root = await tempDir();
    const bundleDir = path.join(root, "packages", "cli", "dist");
    await mkdir(bundleDir, { recursive: true });
    await mkdir(path.join(root, "schemas"), { recursive: true });
    await writeFile(path.join(root, "schemas", "probe.schema.json"), "{\"source\":\"repo\"}", "utf8");

    const result = await readSchemaFile("probe", pathToFileURL(path.join(bundleDir, "cli.js")).href, "../../../../schemas");

    expect(result).toBe("{\"source\":\"repo\"}");
  });
});
