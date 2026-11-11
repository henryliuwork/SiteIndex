import path from "node:path";

const SYNTHETIC_USERNAME = "siteindex-synthetic-user";
const SYNTHETIC_PASSWORD = "siteindex-synthetic-credential-not-valid";

function validateFixtureOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("WordPress UI smoke 只接受 HTTPS 合成站点 origin。");
  }
  const syntheticHost = [".invalid", ".test"].some((suffix) => parsed.hostname.endsWith(suffix));
  if (parsed.protocol !== "https:" || !syntheticHost || parsed.origin !== value) {
    throw new Error("WordPress UI smoke 只接受无路径的 HTTPS .invalid 或 .test 合成站点 origin。");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`WordPress UI smoke failed: ${message}`);
}

function validateElectronIsolation(isolation) {
  assert(isolation?.verifiedBeforeLaunch === true, "caller must confirm profile and vault isolation before Electron launch");
  const root = isolation.root?.replace(/[\\/]+$/, "");
  assert(root && path.win32.isAbsolute(root), "Electron isolation root must be an absolute Windows path");
  for (const [label, value] of Object.entries({
    APPDATA: isolation.appDataRoot,
    LOCALAPPDATA: isolation.localAppDataRoot,
    projectRoot: isolation.projectRoot,
    vault: isolation.vaultPath,
  })) {
    if (!value || !path.win32.isAbsolute(value)) {
      assert(false, `${label} must be an absolute path inside the verified temporary isolation root`);
    }
    const relative = path.win32.relative(path.win32.resolve(root), path.win32.resolve(value));
    assert(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative),
      `${label} must be inside the verified temporary isolation root`);
  }
}

async function readBrowserStorageLeak(page, values) {
  return page.evaluate((secrets) => {
    try {
      const content = [localStorage, sessionStorage].flatMap((storage) =>
        Array.from({ length: storage.length }, (_, index) => {
          const key = storage.key(index);
          return key ? `${key}=${storage.getItem(key)}` : "";
        }),
      ).join("\n");
      return secrets.some((value) => content.includes(value));
    } catch {
      return null;
    }
  }, values);
}

/**
 * Drives the settings UI using a Playwright Page. This is UI-only: even when
 * invoked against an Electron file renderer, the caller must record packaged
 * IPC evidence separately.
 *
 * @param {import("playwright-core").Page} page
 * @param {{ runtime: "browser-mock" | "packaged-electron"; origin: string; screenshotPath?: string; electronIsolation?: { verifiedBeforeLaunch: true; root: string; appDataRoot: string; localAppDataRoot: string; projectRoot: string; vaultPath: string } }} options
 */
export async function runWordPressCredentialsUiSmoke(page, options) {
  const { runtime, origin, screenshotPath, electronIsolation } = options;
  validateFixtureOrigin(origin);
  assert(runtime === "browser-mock" || runtime === "packaged-electron", "runtime mode is required");

  const startingUrl = new URL(page.url());
  if (runtime === "packaged-electron") {
    assert(startingUrl.protocol === "file:", "packaged-electron mode requires the packaged file renderer");
    validateElectronIsolation(electronIsolation);
  } else {
    assert(
      startingUrl.protocol === "http:" && ["127.0.0.1", "localhost"].includes(startingUrl.hostname),
      "browser-mock mode only accepts a local development server",
    );
  }

  const settingsUrl = new URL(startingUrl.href);
  settingsUrl.hash = "/settings";
  if (page.url() !== settingsUrl.href) await page.goto(settingsUrl.href, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "WordPress 图片托管凭据" }).waitFor({ state: "visible" });
  await page.getByText(origin, { exact: true }).waitFor({ state: "visible" });
  const target = page.getByRole("region", { name: `凭据：${origin}` });
  assert(await target.count() === 1, `expected exactly one credential section for ${origin}`);
  await target.getByText(origin, { exact: true }).waitFor({ state: "visible" });
  const mockDisclosure = page.getByText("浏览器 mock 模式", { exact: true });
  const showsMockDisclosure = await mockDisclosure.isVisible().catch(() => false);
  assert(runtime === "browser-mock" ? showsMockDisclosure : !showsMockDisclosure, "runtime label does not match the selected mode");

  // A configured status indicates the caller did not start with an empty test vault.
  await target.getByText("尚未配置", { exact: true }).waitFor({ state: "visible" });
  await target.getByRole("button", { name: "配置凭据" }).click();
  await page.getByLabel("WordPress 用户名").fill(SYNTHETIC_USERNAME);
  await page.getByLabel("应用程序密码").fill(SYNTHETIC_PASSWORD);
  await page.getByRole("button", { name: "保存到本机" }).click();
  await target.getByText("本机凭据已保存", { exact: true }).waitFor({ state: "visible" });

  const renderedText = await page.locator("body").innerText();
  const credentialValuesEchoed = renderedText.includes(SYNTHETIC_USERNAME) || renderedText.includes(SYNTHETIC_PASSWORD);
  assert(!credentialValuesEchoed, "synthetic values were rendered into page text");
  assert(await page.locator('input[type="password"]').count() === 0, "password field remained after save");

  let browserStorageLeak = await readBrowserStorageLeak(page, [SYNTHETIC_USERNAME, SYNTHETIC_PASSWORD]);
  assert(browserStorageLeak !== null, "browser storage could not be inspected; credential leak status is unverified");
  assert(!browserStorageLeak, "synthetic values were written to browser storage");

  const toastClose = page.getByRole("button", { name: "关闭通知" }).first();
  if (await toastClose.count()) await toastClose.click();

  await target.getByRole("button", { name: "替换凭据" }).click();
  const usernameField = page.getByLabel("WordPress 用户名");
  const passwordField = page.getByLabel("应用程序密码");
  const replacementStartsBlank = (await usernameField.inputValue()) === "" && (await passwordField.inputValue()) === "";
  assert(replacementStartsBlank, "replacement form was not blank");
  await page.keyboard.press("Escape");
  const focusReturned = await target.getByRole("button", { name: "替换凭据" }).evaluate((button) => button === document.activeElement);
  assert(focusReturned, "Escape did not return focus to the replacement button");

  await target.getByRole("button", { name: "替换凭据" }).click();
  await page.getByLabel("WordPress 用户名").fill(`${SYNTHETIC_USERNAME}-replacement`);
  await page.getByLabel("应用程序密码").fill(`${SYNTHETIC_PASSWORD}-replacement`);
  await page.getByRole("button", { name: "保存到本机" }).click();
  await target.getByText("本机凭据已保存", { exact: true }).waitFor({ state: "visible" });
  assert(await page.locator('input[type="password"]').count() === 0, "replacement password field remained after save");
  const replacementRenderedText = await page.locator("body").innerText();
  assert(
    !replacementRenderedText.includes(`${SYNTHETIC_USERNAME}-replacement`) &&
      !replacementRenderedText.includes(`${SYNTHETIC_PASSWORD}-replacement`),
    "replacement values were rendered into page text",
  );
  browserStorageLeak = await readBrowserStorageLeak(page, [
    SYNTHETIC_USERNAME,
    SYNTHETIC_PASSWORD,
    `${SYNTHETIC_USERNAME}-replacement`,
    `${SYNTHETIC_PASSWORD}-replacement`,
  ]);
  assert(browserStorageLeak !== null, "browser storage could not be inspected after replacement; credential leak status is unverified");
  assert(!browserStorageLeak, "credential values were written to browser storage after replacement");
  const replacementToastClose = page.getByRole("button", { name: "关闭通知" }).first();
  if (await replacementToastClose.count()) await replacementToastClose.click();

  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert(layout.documentWidth <= layout.width + 1, "settings page has horizontal overflow");

  if (screenshotPath) {
    await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: screenshotPath, fullPage: false });
  }

  await target.getByRole("button", { name: "删除本机凭据" }).click();
  const confirmation = page.getByRole("dialog", { name: "删除本机凭据？" });
  await confirmation.getByText(new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).waitFor({ state: "visible" });
  await confirmation.getByRole("button", { name: "删除本机凭据" }).click();
  await target.getByText("尚未配置", { exact: true }).waitFor({ state: "visible" });

  return {
    surface: "ui-only",
    runtime,
    configuredStatusVisible: true,
    statusCleared: true,
    credentialValuesEchoed,
    browserStorageLeak,
    replacementStartsBlank,
    replacementSaved: true,
    focusReturned,
    horizontalOverflow: layout.documentWidth > layout.width + 1,
    targetedSectionCount: await target.count(),
    isolationVerifiedBeforeLaunch: runtime === "packaged-electron" ? electronIsolation.verifiedBeforeLaunch : null,
    screenshotPath: screenshotPath ?? null,
  };
}
