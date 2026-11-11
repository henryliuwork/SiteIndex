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

/**
 * Drives the settings UI using a Playwright Page. This is UI-only: even when
 * invoked against an Electron file renderer, the caller must record packaged
 * IPC evidence separately.
 *
 * @param {import("playwright-core").Page} page
 * @param {{ runtime: "browser-mock" | "packaged-electron"; origin: string; screenshotPath?: string }} options
 */
export async function runWordPressCredentialsUiSmoke(page, options) {
  const { runtime, origin, screenshotPath } = options;
  validateFixtureOrigin(origin);
  assert(runtime === "browser-mock" || runtime === "packaged-electron", "runtime mode is required");

  const startingUrl = new URL(page.url());
  if (runtime === "packaged-electron") {
    assert(startingUrl.protocol === "file:", "packaged-electron mode requires the packaged file renderer");
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
  const mockDisclosure = page.getByText("浏览器 mock 模式", { exact: true });
  const showsMockDisclosure = await mockDisclosure.isVisible().catch(() => false);
  assert(runtime === "browser-mock" ? showsMockDisclosure : !showsMockDisclosure, "runtime label does not match the selected mode");

  // A configured status indicates the caller did not start with an empty test vault.
  await page.getByText("尚未配置", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "配置凭据" }).click();
  await page.getByLabel("WordPress 用户名").fill(SYNTHETIC_USERNAME);
  await page.getByLabel("应用程序密码").fill(SYNTHETIC_PASSWORD);
  await page.getByRole("button", { name: "保存到本机" }).click();
  await page.getByText("本机凭据已保存", { exact: true }).waitFor({ state: "visible" });

  const renderedText = await page.locator("body").innerText();
  const credentialValuesEchoed = renderedText.includes(SYNTHETIC_USERNAME) || renderedText.includes(SYNTHETIC_PASSWORD);
  assert(!credentialValuesEchoed, "synthetic values were rendered into page text");
  assert(await page.locator('input[type="password"]').count() === 0, "password field remained after save");

  const browserStorageLeak = await page.evaluate((values) => {
    try {
      const content = [localStorage, sessionStorage].flatMap((storage) =>
        Array.from({ length: storage.length }, (_, index) => {
          const key = storage.key(index);
          return key ? `${key}=${storage.getItem(key)}` : "";
        }),
      ).join("\n");
      return values.some((value) => content.includes(value));
    } catch {
      return null;
    }
  }, [SYNTHETIC_USERNAME, SYNTHETIC_PASSWORD]);
  assert(browserStorageLeak !== true, "synthetic values were written to browser storage");

  const toastClose = page.getByRole("button", { name: "关闭通知" }).first();
  if (await toastClose.count()) await toastClose.click();

  await page.getByRole("button", { name: "替换凭据" }).click();
  const usernameField = page.getByLabel("WordPress 用户名");
  const passwordField = page.getByLabel("应用程序密码");
  const replacementStartsBlank = (await usernameField.inputValue()) === "" && (await passwordField.inputValue()) === "";
  assert(replacementStartsBlank, "replacement form was not blank");
  await page.keyboard.press("Escape");
  const focusReturned = await page.evaluate(() => document.activeElement?.textContent?.trim() === "替换凭据");
  assert(focusReturned, "Escape did not return focus to the replacement button");

  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert(layout.documentWidth <= layout.width + 1, "settings page has horizontal overflow");

  if (screenshotPath) {
    await page.locator(".si-wp-credential-origin").evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: screenshotPath, fullPage: false });
  }

  await page.getByRole("button", { name: "删除本机凭据" }).first().click();
  await page.getByText(/不会更改项目文件或其他网站的凭据/).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "删除本机凭据" }).last().click();
  await page.getByText("尚未配置", { exact: true }).waitFor({ state: "visible" });

  return {
    surface: "ui-only",
    runtime,
    configuredStatusVisible: true,
    statusCleared: true,
    credentialValuesEchoed,
    browserStorageLeak,
    replacementStartsBlank,
    focusReturned,
    horizontalOverflow: layout.documentWidth > layout.width + 1,
    screenshotPath: screenshotPath ?? null,
  };
}
