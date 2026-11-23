import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { createCoreService } from "../src/service";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-config-save-"));
  roots.push(root);
  const projectPath = path.join(root, "synthetic");
  await cp(path.resolve("fixtures/e-v050-w0/projects/legacy"), projectPath, { recursive: true });
  const sitePath = path.join(projectPath, PATHS.site);
  const site = JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig;
  site.seo = { core_keywords: ["old keyword"], competitors: ["rival.example.test"], title_range: [30, 60] };
  await writeFile(sitePath, `${JSON.stringify(site, null, 2)}\n`, "utf8");
  const api = () => createCoreService({ resolveProject: () => projectPath, deviceId: "synthetic-device", cacheDir: path.join(root, "cache") });
  return { api, sitePath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("deep-merges dirty config paths and reads the committed value in a new service", async () => {
  const { api, sitePath } = await setup();
  const initial = await api().projects.get("synthetic");
  expect(initial.config_revision).toMatch(/^[a-f0-9]{64}$/);
  const saved = await api().projects.updateConfig("synthetic", {
    seo: { core_keywords: ["new keyword"] },
  }, { revision: initial.config_revision, dirty_paths: ["seo.core_keywords"] });
  expect(saved.seo).toEqual({ core_keywords: ["new keyword"], competitors: ["rival.example.test"], title_range: [30, 60] });
  expect(saved.brand.tagline).toBe("Fixture data only");
  expect((await api().projects.get("synthetic")).config.seo).toEqual(saved.seo);
  expect((JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig).seo).toEqual(saved.seo);
});

it("rejects stale writes and implicit clears while leaving no-op saves byte-identical", async () => {
  const { api, sitePath } = await setup();
  const stale = await api().projects.get("synthetic");
  const external = JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig;
  external.brand.tagline = "External edit";
  await writeFile(sitePath, `${JSON.stringify(external, null, 2)}\n`, "utf8");
  const externalBytes = await readFile(sitePath, "utf8");
  await expect(api().projects.updateConfig("synthetic", { brand: { name: "Renamed" } }, {
    revision: stale.config_revision, dirty_paths: ["brand.name"],
  })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "配置已在别处更新，请刷新后再保存。" });
  expect(await readFile(sitePath, "utf8")).toBe(externalBytes);

  const fresh = await api().projects.get("synthetic");
  await api().projects.updateConfig("synthetic", { brand: { name: "Renamed", tagline: "Stale draft" } }, {
    revision: fresh.config_revision, dirty_paths: ["brand.name"],
  });
  expect((await api().projects.get("synthetic")).config.brand).toMatchObject({ name: "Renamed", tagline: "External edit" });
  await expect(api().projects.updateConfig("synthetic", { seo: { core_keywords: [] } }, {
    dirty_paths: ["seo.core_keywords"],
  })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  await expect(api().projects.updateConfig("synthetic", { brand: { name: undefined } }, {
    dirty_paths: ["brand.name"],
  })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  await api().projects.updateConfig("synthetic", { seo: { core_keywords: [] } }, {
    dirty_paths: ["seo.core_keywords"], clear: ["seo.core_keywords"],
  });
  expect((await api().projects.get("synthetic")).config.seo?.core_keywords).toEqual([]);

  const beforeNoop = await readFile(sitePath, "utf8");
  await api().projects.updateConfig("synthetic", {}, { dirty_paths: [] });
  expect(await readFile(sitePath, "utf8")).toBe(beforeNoop);
});
