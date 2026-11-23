import { expect, it } from "vitest";
import type { AppSettingsSnapshot, ConfigSaveOptions, ReadmeData, SettingsPatch, SiteConfigPatch } from "../src/api";

it("keeps legacy patches valid and permits optional protected-save metadata", () => {
  const projectPatch: SiteConfigPatch = {
    brand: { tagline: "Synthetic tagline" },
    crawl: { rate_limit_ms: 250 },
    seo: { core_keywords: ["bird feeder"] },
  };
  const settingsPatch: SettingsPatch = {
    browser: { channel: "custom" },
    notify: { on_failure: true },
  };
  const options: ConfigSaveOptions = {
    revision: "synthetic-revision",
    dirty_paths: ["brand.tagline", "seo.core_keywords"],
    clear: ["seo.competitors"],
  };
  const settings: AppSettingsSnapshot = {
    device_id: "synthetic-device", device_name: "Synthetic device", projects_root: "C:/synthetic",
    extra_projects: [], cache_dir: "C:/synthetic/cache", browser: { channel: "custom", executable_path: null },
    notify: { on_failure: true, on_success: false, oos_threshold: null, dingtalk_webhook: null },
    skill_platforms: [], conflict_patterns: [], revision: "synthetic-revision",
  };
  const readme: Pick<ReadmeData, "missing_user_blocks"> = { missing_user_blocks: ["focus"] };

  expect(projectPatch.brand?.tagline).toBe("Synthetic tagline");
  expect(settingsPatch.notify?.on_failure).toBe(true);
  expect(options.clear).toEqual(["seo.competitors"]);
  expect(settings.revision).toBe("synthetic-revision");
  expect(readme.missing_user_blocks).toEqual(["focus"]);
});
