import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS } from "@siteindex/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEdmIndexSaveAs, resolveEdmIndexDefaultPath } from "./edm-index-save-as.js";

const rendered = {
  content: "<!-- siteindex:generated:edm-sku-index:v1 -->\n# Synthetic EDM\n",
  sku_count: 2,
  missing_image_count: 1,
};

describe("Desktop EDM SKU index Save As", () => {
  let root = "";
  let projectRoot = "";
  let downloadsDirectory = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "siteindex-edm-save-as-"));
    projectRoot = path.join(root, "project");
    downloadsDirectory = path.join(root, "downloads");
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(downloadsDirectory, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prefers the Downloads special path when available", () => {
    const downloads = path.join(root, "downloads");
    const home = path.join(root, "home");
    expect(
      resolveEdmIndexDefaultPath({
        getDownloadsPath: () => downloads,
        getHomePath: () => home,
        fileName: path.basename(PATHS.edmSkuIndex),
      }),
    ).toBe(path.join(downloads, path.basename(PATHS.edmSkuIndex)));
  });

  it("falls back to the home directory when the Downloads special path is unavailable", () => {
    const home = path.join(root, "home");
    expect(
      resolveEdmIndexDefaultPath({
        getDownloadsPath: () => {
          throw new Error("Downloads path unavailable");
        },
        getHomePath: () => home,
        fileName: path.basename(PATHS.edmSkuIndex),
      }),
    ).toBe(path.join(home, path.basename(PATHS.edmSkuIndex)));
  });

  it("falls back to the file name if neither special path is available", () => {
    const fileName = path.basename(PATHS.edmSkuIndex);
    expect(
      resolveEdmIndexDefaultPath({
        getDownloadsPath: () => {
          throw new Error("Downloads path unavailable");
        },
        getHomePath: () => {
          throw new Error("Home path unavailable");
        },
        fileName,
      }),
    ).toBe(fileName);
  });

  function saveTo(targetPath: string, canceled = false) {
    const showSaveDialog = vi.fn(async () => ({ canceled, filePath: canceled ? undefined : targetPath }));
    const save = createEdmIndexSaveAs({
      defaultPath: path.join(downloadsDirectory, path.basename(PATHS.edmSkuIndex)),
      showSaveDialog,
    });
    return { save, showSaveDialog };
  }

  it("creates a new target with no-clobber semantics and returns only its basename", async () => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    const { save, showSaveDialog } = saveTo(targetPath);

    await expect(save(projectRoot, rendered)).resolves.toEqual({
      status: "created",
      file_name: "sku-index.md",
      sku_count: 2,
      missing_image_count: 1,
    });
    expect(await readFile(targetPath, "utf8")).toBe(rendered.content);
    expect(await readdir(downloadsDirectory)).toEqual(["sku-index.md"]);
    expect(showSaveDialog).toHaveBeenCalledWith({
      title: "另存 EDM SKU 清单",
      defaultPath: path.join(downloadsDirectory, "sku-index.md"),
      properties: ["showOverwriteConfirmation"],
      filters: [{ name: "Markdown 文件", extensions: ["md"] }],
    });
  });

  it("allows a new target inside the project but refuses an existing project file", async () => {
    const newTarget = path.join(projectRoot, "sku-index-copy.md");
    await expect(saveTo(newTarget).save(projectRoot, rendered)).resolves.toMatchObject({ status: "created" });

    const existingProjectTarget = path.join(projectRoot, PATHS.edmSkuIndex);
    await mkdir(path.dirname(existingProjectTarget), { recursive: true });
    await writeFile(existingProjectTarget, "User-owned file\n", "utf8");
    const save = saveTo(existingProjectTarget).save;

    await expect(save(projectRoot, rendered)).rejects.toMatchObject({
      code: "EDM_INDEX_CONFLICT",
      detail: "EDM_INDEX_PROJECT_FILE_EXISTS",
    });
    await expect(readFile(existingProjectTarget, "utf8")).resolves.toBe("User-owned file\n");
  });

  it("resolves cancellation without writing a file", async () => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    const { save } = saveTo(targetPath, true);

    await expect(save(projectRoot, rendered)).resolves.toEqual({
      status: "cancelled",
      sku_count: 2,
      missing_image_count: 1,
    });
    expect(await readdir(downloadsDirectory)).toEqual([]);
  });

  it("returns unchanged for an external file with identical bytes without rewriting it", async () => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    await writeFile(targetPath, rendered.content, "utf8");
    const before = await readFile(targetPath);
    const { save } = saveTo(targetPath);

    await expect(save(projectRoot, rendered)).resolves.toEqual({
      status: "unchanged",
      file_name: "sku-index.md",
      sku_count: 2,
      missing_image_count: 1,
    });
    await expect(readFile(targetPath)).resolves.toEqual(before);
  });

  it("fails closed on a changed external file and preserves the existing bytes", async () => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    await writeFile(targetPath, "User-owned content\n", "utf8");
    const before = await readFile(targetPath);
    const { save } = saveTo(targetPath);

    await expect(save(projectRoot, rendered)).rejects.toMatchObject({
      code: "WRITE_FAILED",
      detail: "EDM_INDEX_SAFE_REPLACE_UNAVAILABLE",
    });
    await expect(readFile(targetPath)).resolves.toEqual(before);
  });

  it("never overwrites when two exports race for the same new target", async () => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    const first = saveTo(targetPath).save;
    const second = saveTo(targetPath).save;
    const alternate = { ...rendered, content: "Different generated content\n" };

    const results = await Promise.allSettled([first(projectRoot, rendered), second(projectRoot, alternate)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const saved = await readFile(targetPath, "utf8");
    expect([rendered.content, alternate.content]).toContain(saved);
  });

  it("rejects a path whose parent directory does not exist", async () => {
    const targetPath = path.join(downloadsDirectory, "missing", "sku-index.md");
    const { save } = saveTo(targetPath);

    await expect(save(projectRoot, rendered)).rejects.toMatchObject({
      code: "WRITE_FAILED",
      detail: "EDM_INDEX_UNSAFE_DIRECTORY",
    });
  });
});
