import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyMediaWasmResources, verifyUiResourceTree } from "../scripts/verify-windows-installer.mjs";

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

  it("declares Core media WASM packages as Desktop runtime dependencies and unpacks their WASM assets", async () => {
    const desktopPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
      build: { asarUnpack: string[] };
    };
    const corePackage = JSON.parse(await readFile(new URL("../../core/package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };

    for (const packageName of ["@jsquash/avif", "@jsquash/jpeg", "@jsquash/resize", "@jsquash/webp"]) {
      expect(desktopPackage.dependencies[packageName]).toBe(corePackage.dependencies[packageName]);
    }
    expect(desktopPackage.build.asarUnpack).toContain("node_modules/@jsquash/**/*.wasm");
  });

  it("requires and compiles all media WASM modules in the unpacked installer resources", async () => {
    const resources = await temporaryDirectory();
    const wasmPaths = [
      "@jsquash/avif/codec/dec/avif_dec.wasm",
      "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
      "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm",
      "@jsquash/webp/codec/dec/webp_dec.wasm",
    ];
    const minimalWasm = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
    for (const wasmPath of wasmPaths) {
      const filePath = join(resources, "app.asar.unpacked", "node_modules", ...wasmPath.split("/"));
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, minimalWasm);
    }

    await expect(verifyMediaWasmResources(resources)).resolves.toEqual({ mediaWasmModules: 4 });
  });

  it("fails installer verification when a media WASM module is missing", async () => {
    const resources = await temporaryDirectory();
    await expect(verifyMediaWasmResources(resources)).rejects.toThrow("missing a required media WASM");
  });

  it("accepts the index and every referenced local asset", async () => {
    const resources = await temporaryDirectory();
    const ui = join(resources, "ui");
    const expectedUi = join(resources, "expected-ui");
    await mkdir(join(ui, "assets"), { recursive: true });
    await mkdir(join(expectedUi, "assets"), { recursive: true });
    await writeFile(
      join(ui, "index.html"),
      '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="./assets/app.css">',
    );
    await writeFile(join(ui, "assets", "app.js"), "console.log('fixture');");
    await writeFile(join(ui, "assets", "app.css"), "body { color: #111; }");
    await writeFile(
      join(expectedUi, "index.html"),
      '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="./assets/app.css">',
    );
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
