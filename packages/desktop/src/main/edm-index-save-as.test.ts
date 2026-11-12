import { link as createHardLink, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
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

  function saveTo(
    targetPath: string,
    canceled = false,
    createLink?: typeof createHardLink,
  ) {
    const showSaveDialog = vi.fn(async () => ({ canceled, filePath: canceled ? undefined : targetPath }));
    const save = createEdmIndexSaveAs({
      defaultPath: path.join(downloadsDirectory, path.basename(PATHS.edmSkuIndex)),
      showSaveDialog,
      ...(createLink ? { createHardLink: createLink } : {}),
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
  }, 20_000);

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
  }, 20_000);

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
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const competingLink: typeof createHardLink = async (source, destination) => {
      arrivals += 1;
      if (arrivals === 2) {
        const targetMissing = await lstat(targetPath).then(
          () => false,
          (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
        );
        if (!targetMissing) throw new Error("race-target-was-not-absent-before-link");
        releaseBarrier();
      }
      await barrier;
      return createHardLink(source, destination);
    };
    const first = saveTo(targetPath, false, competingLink).save;
    const second = saveTo(targetPath, false, competingLink).save;
    const alternate = { ...rendered, content: "Different generated content\n" };

    const results = await Promise.allSettled([first(projectRoot, rendered), second(projectRoot, alternate)]);
    expect(arrivals).toBe(2);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "WRITE_FAILED", detail: "EDM_INDEX_SAFE_REPLACE_UNAVAILABLE" },
    });
    const saved = await readFile(targetPath, "utf8");
    expect([rendered.content, alternate.content]).toContain(saved);
  });

  it("empties an owned temporary file when the destination directory changes before opening", async () => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    const displacedDirectory = path.join(root, "downloads-before-open");
    const save = createEdmIndexSaveAs({
      defaultPath: path.join(downloadsDirectory, path.basename(PATHS.edmSkuIndex)),
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
      beforeTemporaryOpenForTest: async () => {
        await rename(downloadsDirectory, displacedDirectory);
        await mkdir(downloadsDirectory);
        await writeFile(path.join(downloadsDirectory, "keep-sentinel.txt"), "replacement directory sentinel\n", "utf8");
      },
    });

    await expect(save(projectRoot, rendered)).rejects.toMatchObject({
      code: "WRITE_FAILED",
      detail: "EDM_INDEX_CREATE_FAILED",
    });
    await expect(lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(displacedDirectory)).toEqual([]);
    await expect(readFile(path.join(downloadsDirectory, "keep-sentinel.txt"), "utf8")).resolves.toBe(
      "replacement directory sentinel\n",
    );
    const replacementEntries = await readdir(downloadsDirectory);
    const temporaryNames = replacementEntries.filter((name) => name.startsWith(".siteindex-edm-") && name.endsWith(".tmp"));
    expect(temporaryNames).toHaveLength(1);
    await expect(readFile(path.join(downloadsDirectory, temporaryNames[0]!), "utf8")).resolves.toBe("");
  }, 20_000);

  it.skipIf(process.platform === "win32")("does not write export bytes through a directory link replaced after opening", async ({ skip }) => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    const displacedDirectory = path.join(root, "downloads-before-write");
    const outsideDirectory = path.join(root, "outside-before-write");
    const probeLink = path.join(root, "directory-link-probe");
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, "keep-sentinel.txt"), "outside sentinel\n", "utf8");
    try {
      await symlink(outsideDirectory, probeLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ["EPERM", "ENOTSUP", "EINVAL"].includes(String(error.code))
      ) {
        skip();
      }
      throw error;
    }
    await rm(probeLink, { recursive: true, force: true });

    let releaseWrite!: () => void;
    let temporaryOpened!: () => void;
    const writeBarrier = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const openedBarrier = new Promise<void>((resolve) => {
      temporaryOpened = resolve;
    });
    const save = createEdmIndexSaveAs({
      defaultPath: path.join(downloadsDirectory, path.basename(PATHS.edmSkuIndex)),
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
      beforeTemporaryWriteForTest: async () => {
        temporaryOpened();
        await writeBarrier;
      },
    });
    const pendingSave = save(projectRoot, rendered);
    await openedBarrier;
    try {
      await rename(downloadsDirectory, displacedDirectory);
      await symlink(outsideDirectory, downloadsDirectory, process.platform === "win32" ? "junction" : "dir");
    } finally {
      releaseWrite();
    }

    await expect(pendingSave).rejects.toMatchObject({ code: "WRITE_FAILED" });
    await expect(lstat(path.join(outsideDirectory, path.basename(targetPath)))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(outsideDirectory, "keep-sentinel.txt"), "utf8")).resolves.toBe("outside sentinel\n");
    expect(await readdir(outsideDirectory)).toEqual(["keep-sentinel.txt"]);
    const displacedEntries = await readdir(displacedDirectory);
    const temporaryNames = displacedEntries.filter((name) => name.startsWith(".siteindex-edm-") && name.endsWith(".tmp"));
    expect(temporaryNames).toHaveLength(1);
    await expect(readFile(path.join(displacedDirectory, temporaryNames[0]!), "utf8")).resolves.toBe("");
  }, 20_000);

  it.skipIf(process.platform === "win32")("reports unconfirmed cleanup when truncating a moved temporary file fails", async () => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    const displacedDirectory = path.join(root, "downloads-before-failed-cleanup");
    const save = createEdmIndexSaveAs({
      defaultPath: path.join(downloadsDirectory, path.basename(PATHS.edmSkuIndex)),
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
      beforeTemporaryPublishForTest: async () => {
        await rename(downloadsDirectory, displacedDirectory);
        await mkdir(downloadsDirectory);
        await writeFile(path.join(downloadsDirectory, "keep-sentinel.txt"), "replacement directory sentinel\n", "utf8");
      },
      truncateTemporaryForTest: async () => {
        throw new Error("simulated-truncate-failure");
      },
    });

    await expect(save(projectRoot, rendered)).rejects.toMatchObject({
      code: "WRITE_FAILED",
      detail: "EDM_INDEX_TEMPORARY_CLEANUP_FAILED",
    });
    await expect(lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(downloadsDirectory, "keep-sentinel.txt"), "utf8")).resolves.toBe(
      "replacement directory sentinel\n",
    );
    const temporaryNames = (await readdir(displacedDirectory)).filter(
      (name) => name.startsWith(".siteindex-edm-") && name.endsWith(".tmp"),
    );
    expect(temporaryNames).toHaveLength(1);
    await expect(readFile(path.join(displacedDirectory, temporaryNames[0]!), "utf8")).resolves.toBe(rendered.content);
  });

  it.skipIf(process.platform === "win32")("empties a moved temporary file without following the replacement directory", async () => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    const displacedDirectory = path.join(root, "downloads-before-replacement");
    const replaceDirectoryThenLink: typeof createHardLink = async (source, destination) => {
      await rename(downloadsDirectory, displacedDirectory);
      await mkdir(downloadsDirectory);
      return createHardLink(source, destination);
    };

    await expect(saveTo(targetPath, false, replaceDirectoryThenLink).save(projectRoot, rendered)).rejects.toMatchObject({
      code: "WRITE_FAILED",
      detail: "EDM_INDEX_CREATE_FAILED",
    });
    await expect(lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(downloadsDirectory)).toEqual([]);
    const displacedEntries = await readdir(displacedDirectory);
    expect(displacedEntries).toHaveLength(1);
    expect(displacedEntries[0]).toMatch(/^\.siteindex-edm-[a-f0-9-]+\.tmp$/u);
    await expect(readFile(path.join(displacedDirectory, displacedEntries[0]!), "utf8")).resolves.toBe("");
  });

  it.skipIf(process.platform === "win32")("reports an unknown result and preserves the published hard link if its directory moves", async () => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    const displacedDirectory = path.join(root, "downloads-after-publication");
    const linkThenMoveDirectory: typeof createHardLink = async (source, destination) => {
      await createHardLink(source, destination);
      await rename(downloadsDirectory, displacedDirectory);
      await mkdir(downloadsDirectory);
      await writeFile(path.join(downloadsDirectory, "keep-sentinel.txt"), "replacement directory sentinel\n", "utf8");
    };

    await expect(saveTo(targetPath, false, linkThenMoveDirectory).save(projectRoot, rendered)).rejects.toMatchObject({
      code: "EDM_EXPORT_OUTCOME_UNKNOWN",
      detail: "EDM_INDEX_CREATED_TARGET_CONFIRMATION_FAILED",
    });
    await expect(readFile(path.join(displacedDirectory, path.basename(targetPath)), "utf8")).resolves.toBe(rendered.content);
    await expect(readFile(path.join(downloadsDirectory, "keep-sentinel.txt"), "utf8")).resolves.toBe(
      "replacement directory sentinel\n",
    );
    const displacedEntries = await readdir(displacedDirectory);
    const temporaryNames = displacedEntries.filter((name) => name.startsWith(".siteindex-edm-") && name.endsWith(".tmp"));
    expect(temporaryNames).toHaveLength(1);
    await expect(readFile(path.join(displacedDirectory, temporaryNames[0]!), "utf8")).resolves.toBe(rendered.content);
  });

  it.skipIf(process.platform === "win32")("does not write through a replaced destination symlink", async () => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    const displacedDirectory = path.join(root, "downloads-before-symlink");
    const outsideDirectory = path.join(root, "outside");
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, "keep-sentinel.txt"), "outside sentinel\n", "utf8");
    const replaceDirectoryThenLink: typeof createHardLink = async (source, destination) => {
      await rename(downloadsDirectory, displacedDirectory);
      await symlink(outsideDirectory, downloadsDirectory, "dir");
      return createHardLink(source, destination);
    };

    await expect(saveTo(targetPath, false, replaceDirectoryThenLink).save(projectRoot, rendered)).rejects.toMatchObject({
      code: "WRITE_FAILED",
      detail: "EDM_INDEX_CREATE_FAILED",
    });
    await expect(lstat(path.join(outsideDirectory, path.basename(targetPath)))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(outsideDirectory, "keep-sentinel.txt"), "utf8")).resolves.toBe("outside sentinel\n");
    expect(await readdir(outsideDirectory)).toEqual(["keep-sentinel.txt"]);
    const displacedEntries = await readdir(displacedDirectory);
    const temporaryNames = displacedEntries.filter((name) => name.startsWith(".siteindex-edm-") && name.endsWith(".tmp"));
    expect(temporaryNames).toHaveLength(1);
    await expect(readFile(path.join(displacedDirectory, temporaryNames[0]!), "utf8")).resolves.toBe("");
  });

  it.skipIf(process.platform !== "win32")("rejects a replaced destination junction before payload write", async ({ skip }) => {
    const targetPath = path.join(downloadsDirectory, "sku-index.md");
    const displacedDirectory = path.join(root, "downloads-before-junction");
    const outsideDirectory = path.join(root, "outside-junction");
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, "keep-sentinel.txt"), "junction sentinel\n", "utf8");
    let payloadWriteStarted = false;
    const save = createEdmIndexSaveAs({
      defaultPath: path.join(downloadsDirectory, path.basename(PATHS.edmSkuIndex)),
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
      beforeTemporaryOpenForTest: async () => {
        await rename(downloadsDirectory, displacedDirectory);
        try {
          await symlink(outsideDirectory, downloadsDirectory, "junction");
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && ["EPERM", "ENOTSUP", "EINVAL"].includes(String(error.code))) {
            skip();
          }
          throw error;
        }
      },
      beforeTemporaryWriteForTest: async () => {
        payloadWriteStarted = true;
      },
    });

    await expect(save(projectRoot, rendered)).rejects.toMatchObject({ code: "WRITE_FAILED" });
    expect(payloadWriteStarted).toBe(false);
    await expect(readFile(path.join(outsideDirectory, "keep-sentinel.txt"), "utf8")).resolves.toBe("junction sentinel\n");
    const outsideEntries = await readdir(outsideDirectory);
    const temporaryNames = outsideEntries.filter((name) => name.startsWith(".siteindex-edm-") && name.endsWith(".tmp"));
    expect(temporaryNames).toHaveLength(1);
    await expect(readFile(path.join(outsideDirectory, temporaryNames[0]!), "utf8")).resolves.toBe("");
    await expect(lstat(path.join(outsideDirectory, path.basename(targetPath)))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(displacedDirectory)).toEqual([]);
  }, 20_000);

  it("rejects a path whose parent directory does not exist", async () => {
    const targetPath = path.join(downloadsDirectory, "missing", "sku-index.md");
    const { save } = saveTo(targetPath);

    await expect(save(projectRoot, rendered)).rejects.toMatchObject({
      code: "WRITE_FAILED",
      detail: "EDM_INDEX_UNSAFE_DIRECTORY",
    });
  });
});
