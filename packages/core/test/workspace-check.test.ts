import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";

const TEMP_DIRS: string[] = [];

function service() {
  return createCoreService({
    resolveProject: () => "",
    deviceId: "workspace-check-test",
    cacheDir: path.join(os.tmpdir(), "siteindex-workspace-check-cache"),
  });
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace.check", () => {
  it("accepts a not-yet-created directory and an empty directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-check-"));
    TEMP_DIRS.push(root);
    const empty = path.join(root, "empty");

    await expect(service().workspace.check(empty)).resolves.toEqual({ ok: true, invalid_entries: [] });
    await mkdir(empty);
    await expect(service().workspace.check(empty)).resolves.toEqual({ ok: true, invalid_entries: [] });
  });

  it("ignores Git and common operating-system metadata entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-ignored-"));
    TEMP_DIRS.push(root);
    const target = path.join(root, "target");
    await mkdir(path.join(target, ".git"), { recursive: true });
    await Promise.all([
      writeFile(path.join(target, ".DS_Store"), ""),
      writeFile(path.join(target, "Thumbs.db"), ""),
      writeFile(path.join(target, "dEsKtOp.InI"), ""),
    ]);

    await expect(service().workspace.check(target)).resolves.toEqual({ ok: true, invalid_entries: [] });
  });

  it("returns only the first ten invalid names in stable order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-invalid-"));
    TEMP_DIRS.push(root);
    const target = path.join(root, "target");
    await mkdir(target);
    const names = Array.from({ length: 12 }, (_, index) => "entry-" + String(index).padStart(2, "0"));
    await Promise.all(names.map((name) => writeFile(path.join(target, name), "")));

    await expect(service().workspace.check(target)).resolves.toEqual({
      ok: false,
      invalid_entries: names.slice(0, 10),
    });
  });
});
