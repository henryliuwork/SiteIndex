import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const nonWizardCases = [
  ["app-settings", "/settings"],
  ["content", "/p/:id/content"],
  ["design", "/p/:id/design"],
  ["edm", "/p/:id/edm"],
  ["inventory", "/p/:id/inventory"],
  ["overview", "/p/:id"],
  ["not-found", "/__ui-check-not-found__"],
  ["products", "/p/:id/products"],
  ["project-center", "/"],
  ["project-settings-categories", "/p/:id/settings/categories"],
  ["project-settings-config", "/p/:id/settings/config"],
  ["project-settings-files", "/p/:id/settings/files"],
  ["project-todos", "/p/:id/todos"],
  ["readme", "/p/:id/readme"],
  ["runs", "/p/:id/runs"],
  ["schedules", "/schedules"],
  ["schedules-system", "/schedules"],
  ["schedules-orphans", "/schedules"],
  ["seo", "/p/:id/seo"],
  ["skills", "/skills"],
];
const wizardCases = [
  "new-project-url", "new-project-woo-detect", "new-project-source", "new-project-woo-source",
  "new-project-brand", "new-project-agent-workspace", "new-project-done",
];
const viewports = [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }];

async function spacingProbe() {
  const source = await readFile(new URL("../../ui/visual/spacing-inspect.ts", import.meta.url), "utf8");
  const raw = source.match(/const probe = String\.raw`([\s\S]*?)`;/u)?.[1];
  if (!raw || !raw.includes("__ROUTE__")) throw new Error("The checked-in S1–S10 DOM probe was not found.");
  const policy = JSON.parse(await readFile(new URL("../../ui/visual/spacing-exceptions.json", import.meta.url), "utf8"));
  const approved = new Set(policy.exceptions.map((item) => `${item.rule}:${item.id}`));
  return { raw, approved };
}

async function capture(page, name, viewport, context) {
  await page.locator(".si-page-frame").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(150);
  const findings = await page.evaluate(context.probe.raw.replace("__ROUTE__", JSON.stringify(name)));
  const violations = findings.filter((item) => !item.exceptionId
    || !context.probe.approved.has(`${item.rule}:${item.exceptionId}`));
  const maskCount = await page.evaluate((values) => {
    let count = 0;
    for (const element of document.querySelectorAll("main input, main textarea, main code, main pre, main span, main dd")) {
      const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value : element.children.length ? "" : element.textContent || "";
      if (values.some((item) => item && value.includes(item))) {
        element.setAttribute("data-siteindex-acceptance-mask", "");
        count += 1;
      }
    }
    return count;
  }, context.sensitiveValues);
  const screenshot = `v082-page-walk/${name}-${viewport.width}x${viewport.height}.png`;
  await mkdir(path.join(context.outputDir, "v082-page-walk"), { recursive: true });
  try {
    await page.screenshot({ path: path.join(context.outputDir, screenshot), fullPage: false,
      mask: [page.locator("[data-siteindex-acceptance-mask]")], maskColor: "#222222" });
  } finally {
    await page.evaluate(() => document.querySelectorAll("[data-siteindex-acceptance-mask]")
      .forEach((element) => element.removeAttribute("data-siteindex-acceptance-mask")));
  }
  const viewportApplied = await page.evaluate(([width, height]) => innerWidth === width && innerHeight === height,
    [viewport.width, viewport.height]);
  return { passed: viewportApplied && violations.length === 0, evidence: {
    route: name, viewport, actualHash: await page.evaluate(() => location.hash),
    screenshot, maskedRunnerValues: maskCount, viewportApplied,
    installedDomRules: "S1–S6,S8–S10", s7: "Gate2 ui:check static CSS scan; not an installed DOM assertion",
    approvedExceptions: findings.length - violations.length, findings: violations,
  } };
}

async function captureWizard(page, viewport, context) {
  const loopback = await context.startWooLoopback(`visual-${viewport.width}`);
  const siteUrl = loopback.origin;
  const folderName = `synthetic-visual-${viewport.width}`;
  let nextCase = 0;
  const screenshotStep = async (name) => {
    nextCase += 1;
    await context.attempt(`G8.2-3 ${name} ${viewport.width}×${viewport.height}`, "installed-ui", () =>
      capture(page, name, viewport, context));
  };
  try {
    await context.goTo(page, "/new/url");
    await page.locator(".si-wizard-url-card").waitFor({ state: "visible" });
    await screenshotStep(wizardCases[0]);
    await page.getByRole("textbox", { name: "网站地址" }).fill(siteUrl);
    await page.getByRole("button", { name: "检测", exact: true }).click();
    await page.locator(".si-wizard-detect-list").waitFor({ state: "visible", timeout: 30_000 });
    await screenshotStep(wizardCases[1]);
    await page.getByRole("button", { name: "下一步：数据源" }).click();
    await page.locator(".si-wizard-source-layout").waitFor({ state: "visible" });
    await screenshotStep(wizardCases[2]);
    const prefix = page.getByRole("button", { name: "使用 /shop/{slug}" });
    if (await prefix.count()) await prefix.click();
    const autoCollect = page.getByRole("checkbox", { name: "自动采集商品" });
    await autoCollect.waitFor({ state: "visible" });
    if (!await autoCollect.isChecked()) throw new Error("Synthetic WooCommerce no-Feed collection was not enabled.");
    await screenshotStep(wizardCases[3]);
    await page.getByRole("button", { name: "下一步：品牌配置" }).click();
    await page.locator(".si-wizard-location-card").waitFor({ state: "visible" });
    await page.getByRole("textbox", { name: "项目文件夹名" }).fill(folderName);
    await screenshotStep(wizardCases[4]);
    await page.getByRole("button", { name: "下一步：Agent 工作区" }).click();
    await page.locator(".si-wizard-workspace-layout").waitFor({ state: "visible" });
    await page.getByText("目标目录为空，可以继续。").waitFor({ state: "visible", timeout: 20_000 });
    await screenshotStep(wizardCases[5]);
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await page.locator(".si-wizard-progress-card").waitFor({ state: "visible", timeout: 90_000 });
    await page.waitForFunction(() => !document.querySelector(".si-wizard-progress-heading h1")
      ?.textContent?.startsWith("正在创建"), undefined, { timeout: 90_000 });
    await screenshotStep(wizardCases[6]);
  } catch (error) {
    for (const name of wizardCases.slice(nextCase)) {
      await context.attempt(`G8.2-3 ${name} ${viewport.width}×${viewport.height}`, "installed-ui", () => {
        throw error;
      });
    }
  } finally {
    try { await context.cleanupWizardProject(page, folderName); }
    finally { await loopback.close(); }
  }
}

/** Installed Electron page evidence; the Vite mock ui:check is a separate Gate2 result. */
export async function runV082PackagedFrameWalk(page, context) {
  if (!context.outputDir) throw new Error("G8.2-3 installed page screenshots require an artifact directory.");
  const originalViewport = page.viewportSize();
  const probe = await spacingProbe();
  const captured = { ...context, probe };
  try {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const [name, route] of nonWizardCases) {
        await context.attempt(`G8.2-3 ${name} ${viewport.width}×${viewport.height}`, "installed-ui", async () => {
          const target = route.replace(":id", context.projectId);
          if (name === "inventory") {
            await page.evaluate((next) => { location.hash = `#${next}`; }, target);
            await page.waitForFunction((id) => location.hash === `#/p/${id}/products`, context.projectId);
          } else {
            await context.goTo(page, target);
          }
          if (name === "schedules-system" || name === "schedules-orphans") {
            const system = name === "schedules-system";
            await page.locator(".si-page-frame-header").getByRole("button", {
              name: system ? "系统计划任务" : "孤立任务", exact: true,
            }).click();
            await page.locator(system ? "#si-schedule-system-panel" : "#si-schedule-orphans-panel")
              .waitFor({ state: "visible", timeout: 20_000 });
          }
          if (name === "skills") {
            await page.locator(".si-skill-choice").filter({ hasText: "stock-report" }).click();
            await page.locator(".si-skill-target > .si-button").first().waitFor({ state: "visible" });
          }
          return capture(page, name, viewport, captured);
        });
      }
      await captureWizard(page, viewport, captured);
    }
  } finally {
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
}
