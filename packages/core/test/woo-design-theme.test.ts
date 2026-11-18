import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserSession } from "../src/browser/automation";
import { runDesign } from "../src/jobs/design";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WordPress theme design extraction", () => {
  it("uses literal theme role colors and keeps unrelated or unresolved variables out", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-woo-design-"));
    roots.push(root);
    await mkdir(path.join(root, PATHS.index), { recursive: true });
    const sample = {
      variables: { "--wp--preset--color--primary": "#176b55", "--wp--preset--color--contrast": "#202020",
        "--wp--preset--color--base": "#fafafa", "--wp--preset--color--accent": "var(--missing)" },
      colors: [],
      roles: { primary: null, secondary: null, text: null, text_muted: null, background: null,
        surface: null, border: null, sale: null, link: null },
      fonts: { heading: null, body: null, mono: null }, scale: {}, spacing: [], radius: [], shadow: [],
      buttons: { primary: null, secondary: null, outline: null }, components: {}, logo: null, favicon: null,
    };
    const browser: BrowserSession = {
      newPage: async () => ({
        goto: async () => undefined,
        setViewportSize: async () => undefined,
        screenshot: async ({ path: imagePath }) => {
          await writeFile(imagePath, "synthetic-image");
          return Buffer.from("synthetic-image");
        },
        evaluate: async <T>() => sample as T,
        locator: () => ({ innerText: async () => "", count: async () => 0 }),
        close: async () => undefined,
      }),
      close: async () => undefined,
    };
    const disabled = { enabled: false, time: "00:00" };
    const config: SiteConfig = {
      schema_version: "1.0", domain: "theme.example.test", base_url: "https://theme.example.test/",
      platform: "woocommerce", currency: "USD", locale: "en-US", timezone: "UTC",
      brand: { name: "Demo" }, sitemaps: [],
      crawl: { adapter: "gmc_feed", feed_url: "", rate_limit_ms: 0 },
      categories: { mode: "feed" }, workspace_folders: [],
      schedule: {
        daily: disabled, weekly: disabled, monthly: disabled, validate: disabled, readme: disabled,
        options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false },
      },
    };
    const result = await runDesign({ projectPath: root, config, executablePath: "synthetic-browser",
      launchBrowser: async () => browser, extractedAt: "2026-11-18T00:00:00.000Z" });
    expect(result.tokens.color.roles).toMatchObject({
      primary: { source: "--wp--preset--color--primary", value: "#176b55" },
      text: { source: "--wp--preset--color--contrast", value: "#202020" },
      background: { source: "--wp--preset--color--base", value: "#fafafa" },
    });
    expect(result.tokens.color.roles?.secondary).toBeNull();
    expect(result.tokens.color.roles?.sale).toBeNull();
    expect(result.screenshots).toBe(2);
  }, 20_000);
});
