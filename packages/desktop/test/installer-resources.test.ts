import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyUiResourceTree } from "../scripts/verify-windows-installer.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "siteindex-installer-resources-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("installed UI resources", () => {
  it("includes the UI copy in app.asar as a recovery path", async () => {
    const desktopPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      build: { files: string[] };
    };

    expect(desktopPackage.build.files).toContain("build-resources/ui/**/*");
  });

  it("accepts the index and every referenced local asset", async () => {
    const resources = await temporaryDirectory();
    const ui = join(resources, "ui");
    const expectedUi = join(resources, "expected-ui");
    await mkdir(join(ui, "assets"), { recursive: true });
    await mkdir(join(expectedUi, "assets"), { recursive: true });
    await writeFile(join(ui, "index.html"), '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="./assets/app.css">');
    await writeFile(join(ui, "assets", "app.js"), "console.log('fixture');");
    await writeFile(join(ui, "assets", "app.css"), "body { color: #111; }");
    await writeFile(join(expectedUi, "index.html"), '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="./assets/app.css">');
    await writeFile(join(expectedUi, "assets", "app.js"), "console.log('fixture');");
    await writeFile(join(expectedUi, "assets", "app.css"), "body { color: #111; }");

    await expect(verifyUiResourceTree(resources, expectedUi)).resolves.toEqual({
      referencedAssets: 2,
      assetFiles: 2,
      uiFiles: 3,
    });
  });

  it("fails when installed UI resources differ from the build output", async () => {
    const resources = await temporaryDirectory();
    const ui = join(resources, "ui");
    const expectedUi = join(resources, "expected-ui");
    await mkdir(join(ui, "assets"), { recursive: true });
    await mkdir(join(expectedUi, "assets"), { recursive: true });
    await writeFile(join(ui, "index.html"), '<script src="/assets/app.js"></script>');
    await writeFile(join(ui, "assets", "app.js"), "same");
    await writeFile(join(expectedUi, "index.html"), '<script src="/assets/app.js"></script>');
    await writeFile(join(expectedUi, "assets", "app.js"), "different");

    await expect(verifyUiResourceTree(resources, expectedUi)).rejects.toThrow("incomplete built UI file");
  });

  it("fails when the UI index or one of its assets is missing", async () => {
    const resources = await temporaryDirectory();
    await expect(verifyUiResourceTree(resources)).rejects.toThrow("resources/ui/index.html");

    const ui = join(resources, "ui");
    await mkdir(join(ui, "assets"), { recursive: true });
    await writeFile(join(ui, "index.html"), '<script type="module" src="/assets/missing.js"></script>');
    await expect(verifyUiResourceTree(resources)).rejects.toThrow("assets/missing.js");
  });

  it("rejects asset references that escape the UI resource directory", async () => {
    const resources = await temporaryDirectory();
    const ui = join(resources, "ui");
    await mkdir(join(ui, "assets"), { recursive: true });
    await writeFile(join(ui, "index.html"), '<script type="module" src="../outside.js"></script>');
    await writeFile(join(resources, "outside.js"), "console.log('outside');");

    await expect(verifyUiResourceTree(resources)).rejects.toThrow("outside resources/ui");
  });
});
