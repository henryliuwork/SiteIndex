import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFontAssets } from "../scripts/font-resources.mjs";

describe("Desktop font resources", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "siteindex-font-resources-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("copies Geist and Geist Mono web font assets from the UI build", async () => {
    const uiAssets = join(temporaryDirectory, "ui", "assets");
    const resourceFonts = join(temporaryDirectory, "resources", "fonts");
    const geistPath = join(uiAssets, "geist", "Geist-Regular.woff2");
    const geistMonoPath = join(uiAssets, "geist-mono", "GeistMono-Regular.woff2");
    await mkdir(join(uiAssets, "geist"), { recursive: true });
    await mkdir(join(uiAssets, "geist-mono"), { recursive: true });
    await writeFile(geistPath, "geist font bytes");
    await writeFile(geistMonoPath, "geist mono font bytes");
    await writeFile(join(uiAssets, "app.css"), "not a font asset");

    const copiedPaths = await copyFontAssets(join(temporaryDirectory, "ui"), resourceFonts);

    expect(copiedPaths).toEqual([
      join("assets", "geist-mono", "GeistMono-Regular.woff2"),
      join("assets", "geist", "Geist-Regular.woff2"),
    ]);
    await expect(readFile(join(resourceFonts, ...copiedPaths[0].split(/[\\/]/)), "utf8")).resolves.toBe(
      "geist mono font bytes",
    );
    await expect(readFile(join(resourceFonts, ...copiedPaths[1].split(/[\\/]/)), "utf8")).resolves.toBe(
      "geist font bytes",
    );
  });

  it("returns an empty list when no UI font assets are available", async () => {
    await expect(
      copyFontAssets(join(temporaryDirectory, "missing-ui"), join(temporaryDirectory, "fonts")),
    ).resolves.toEqual([]);
  });
});
