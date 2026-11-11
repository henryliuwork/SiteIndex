import { describe, expect, it } from "vitest";
import { runWordPressCredentialsUiSmoke } from "./wordpress-credentials-smoke.mjs";

describe("WordPress credential UI smoke safety gates", () => {
  it("requires the caller to attest temp-profile and vault isolation before packaged Electron", async () => {
    const page = { url: () => "file:///C:/Program%20Files/SiteIndex/index.html" };

    await expect(runWordPressCredentialsUiSmoke(page, {
      runtime: "packaged-electron",
      origin: "https://siteindex-synthetic.invalid",
    })).rejects.toThrow("caller must attest profile and vault isolation before Electron launch");
  });

  it("rejects packaged Electron paths that escape the temporary isolation root", async () => {
    const page = { url: () => "file:///C:/Program%20Files/SiteIndex/index.html" };

    await expect(runWordPressCredentialsUiSmoke(page, {
      runtime: "packaged-electron",
      origin: "https://siteindex-synthetic.invalid",
      electronIsolation: {
        callerConfirmedBeforeLaunch: true,
        root: "C:\\Temp\\siteindex-test-run",
        appDataRoot: "C:\\Users\\Administrator\\AppData\\Roaming",
        localAppDataRoot: "C:\\Temp\\siteindex-test-run\\local-app-data",
        projectRoot: "C:\\Temp\\siteindex-test-run\\projects",
        vaultPath: "C:\\Temp\\siteindex-test-run\\local-app-data\\SiteIndex\\LocalCredentials",
      },
    })).rejects.toThrow("APPDATA must be inside the verified temporary isolation root");
  });
});

class FakeSmokeLocator {
  constructor(page, { role = null, name = null, text = null, origin = null, dialog = false, selector = null } = {}) {
    Object.assign(this, { page, role, name, text, origin, dialog, selector });
  }

  getByRole(role, options = {}) {
    const name = options.name ?? null;
    const regionOrigin = role === "region" ? name?.replace(/^凭据：/, "") : this.origin;
    return new FakeSmokeLocator(this.page, {
      role,
      name,
      origin: regionOrigin,
      dialog: role === "dialog" || this.dialog,
    });
  }

  getByText(text) {
    return new FakeSmokeLocator(this.page, { text, origin: this.origin, dialog: this.dialog });
  }

  first() { return this; }

  async count() {
    if (this.role === "region") return this.page.origins.includes(this.origin) ? 1 : 0;
    if (this.role === "button" && this.name === "关闭通知") return 0;
    if (this.selector === 'input[type="password"]') return this.page.editorOpen ? 1 : 0;
    return 1;
  }

  async isVisible() {
    if (this.role === "heading") return true;
    if (this.role === "region") return this.page.origins.includes(this.origin);
    if (this.role === "dialog") return this.page.pendingDelete !== null;
    if (this.role === "button") {
      if (this.name === "关闭通知") return false;
      if (this.name === "保存到本机") return this.page.editorOpen;
      if (this.name === "删除本机凭据" && this.dialog) return this.page.pendingDelete !== null;
      if (this.name === "配置凭据") return this.page.states.get(this.origin) === "not_configured";
      if (this.name === "替换凭据" || this.name === "删除本机凭据") return this.page.states.get(this.origin) === "configured";
    }
    if (typeof this.text === "string") {
      if (this.text === "浏览器 mock 模式") return true;
      if (this.page.origins.includes(this.text)) return this.page.origins.includes(this.origin ?? this.text);
      if (this.text === "尚未配置") return this.page.states.get(this.origin) === "not_configured";
      if (this.text === "本机凭据已保存") return this.page.states.get(this.origin) === "configured";
    }
    if (this.text instanceof RegExp) return this.page.pendingDelete !== null && this.text.test(this.page.pendingDelete);
    return true;
  }

  async waitFor({ state = "visible" } = {}) {
    if (state === "visible" && !await this.isVisible()) throw new Error(`Expected visible: ${this.name ?? this.text ?? this.role}`);
    if (state === "hidden" && await this.isVisible()) throw new Error(`Expected hidden: ${this.name ?? this.text ?? this.role}`);
  }

  async click() {
    if (this.role !== "button") return;
    if (this.name === "配置凭据" || this.name === "替换凭据") {
      this.page.editingOrigin = this.origin;
      this.page.editorOpen = true;
      this.page.focusedButton = this.page.buttonRef(this.origin, this.name);
      return;
    }
    if (this.name === "保存到本机") {
      const origin = this.page.editingOrigin;
      this.page.operations.push({ type: "save", origin, username: this.page.username, password: this.page.password });
      this.page.states.set(origin, "configured");
      this.page.editorOpen = false;
      this.page.username = "";
      this.page.password = "";
      return;
    }
    if (this.name === "删除本机凭据" && this.dialog) {
      this.page.operations.push({ type: "clear", origin: this.page.pendingDelete });
      this.page.states.set(this.page.pendingDelete, "not_configured");
      this.page.pendingDelete = null;
      return;
    }
    if (this.name === "删除本机凭据") this.page.pendingDelete = this.origin;
  }

  async fill(value) {
    if (this.name === "WordPress 用户名") this.page.username = value;
    if (this.name === "应用程序密码") this.page.password = value;
  }

  async inputValue() {
    return this.name === "WordPress 用户名" ? this.page.username : this.page.password;
  }

  async innerText() {
    if (this.selector !== "body") return "";
    return this.page.origins.map((origin) => `${origin} ${this.page.states.get(origin)}`).join("\n");
  }

  async evaluate(callback) {
    if (this.role === "button") {
      const button = this.page.buttonRef(this.origin, this.name);
      const originalDocument = globalThis.document;
      globalThis.document = { activeElement: this.page.focusedButton };
      try { return callback(button); }
      finally { globalThis.document = originalDocument; }
    }
    return callback({ scrollIntoView() {} });
  }
}

class FakeSmokePage {
  constructor({ storageMode = "readable", states, operations = [] } = {}) {
    this.currentUrl = "http://127.0.0.1:4178/#/";
    this.origins = ["https://first-store.example.test", "https://second-store.example.test"];
    this.states = states ?? new Map([[this.origins[0], "not_configured"], [this.origins[1], "configured"]]);
    this.storageMode = storageMode;
    this.editorOpen = false;
    this.editingOrigin = null;
    this.pendingDelete = null;
    this.username = "";
    this.password = "";
    this.operations = operations;
    this.buttons = new Map();
    this.keyboard = { press: async (key) => {
      if (key === "Escape" && this.editorOpen) {
        this.editorOpen = false;
        this.focusedButton = this.buttonRef(this.editingOrigin, "替换凭据");
      }
    } };
  }

  url() { return this.currentUrl; }

  async goto(url) { this.currentUrl = url; }

  getByRole(role, options = {}) { return new FakeSmokeLocator(this).getByRole(role, options); }

  getByText(text) { return new FakeSmokeLocator(this, { text }); }

  getByLabel(name) { return new FakeSmokeLocator(this, { name }); }

  locator(selector) { return new FakeSmokeLocator(this, { selector }); }

  async evaluate(callback, values) {
    if (callback.toString().includes("localStorage")) {
      if (this.storageMode === "evaluation-rejected") throw new Error("Storage evaluation rejected");
      return this.storageMode === "unreadable" ? null : false;
    }
    if (callback.toString().includes("window.innerWidth")) return { width: 1100, documentWidth: 1100 };
    return callback();
  }

  async screenshot() {}

  buttonRef(origin, name) {
    const key = `${origin ?? "page"}:${name}`;
    if (!this.buttons.has(key)) this.buttons.set(key, { origin, name });
    return this.buttons.get(key);
  }
}

describe("WordPress credential UI smoke origin scope", () => {
  it("executes configure, replace, and clear only inside the requested origin section", async () => {
    const page = new FakeSmokePage();
    const target = page.origins[0];
    const untouched = page.origins[1];

    const result = await runWordPressCredentialsUiSmoke(page, { runtime: "browser-mock", origin: target });

    expect(result.surface).toBe("ui-only");
    expect(result.replacementSaved).toBe(true);
    expect(page.operations.map(({ type, origin }) => ({ type, origin }))).toEqual([
      { type: "save", origin: target },
      { type: "save", origin: target },
      { type: "clear", origin: target },
    ]);
    expect(page.states.get(target)).toBe("not_configured");
    expect(page.states.get(untouched)).toBe("configured");
  });

  it("supports two-origin configure, replace, delete, and reattached-page status phases", async () => {
    const first = "https://first-store.example.test";
    const second = "https://second-store.example.test";
    const operations = [];
    const page = new FakeSmokePage({
      states: new Map([[first, "not_configured"], [second, "not_configured"]]),
      operations,
    });
    const run = (targetPage, origin, phase, expectedState, otherOrigins) => runWordPressCredentialsUiSmoke(targetPage, {
      runtime: "browser-mock",
      origin,
      phase,
      ...(expectedState ? { expectedState } : {}),
      otherOrigins,
    });

    const firstConfigured = await run(page, first, "configure", undefined, [
      { origin: second, expectedState: "not_configured" },
    ]);
    expect(firstConfigured.surface).toBe("ui-only");
    await run(page, second, "configure", undefined, [
      { origin: first, expectedState: "configured" },
    ]);

    const afterFirstRestart = new FakeSmokePage({ states: new Map(page.states), operations });
    await run(afterFirstRestart, first, "assert-status", "configured", [
      { origin: second, expectedState: "configured" },
    ]);
    await run(afterFirstRestart, second, "assert-status", "configured", [
      { origin: first, expectedState: "configured" },
    ]);

    await run(afterFirstRestart, second, "replace", undefined, [
      { origin: first, expectedState: "configured" },
    ]);
    await run(afterFirstRestart, second, "delete", undefined, [
      { origin: first, expectedState: "configured" },
    ]);

    const afterSecondRestart = new FakeSmokePage({ states: new Map(afterFirstRestart.states), operations });
    await run(afterSecondRestart, second, "assert-status", "not_configured", [
      { origin: first, expectedState: "configured" },
    ]);
    await run(afterSecondRestart, first, "delete", undefined, [
      { origin: second, expectedState: "not_configured" },
    ]);

    const afterFinalRestart = new FakeSmokePage({ states: new Map(afterSecondRestart.states), operations });
    await run(afterFinalRestart, first, "assert-status", "not_configured", [
      { origin: second, expectedState: "not_configured" },
    ]);
    expect(operations.map(({ type, origin }) => ({ type, origin }))).toEqual([
      { type: "save", origin: first },
      { type: "save", origin: second },
      { type: "save", origin: second },
      { type: "clear", origin: second },
      { type: "clear", origin: first },
    ]);
    expect(afterFinalRestart.states.get(first)).toBe("not_configured");
    expect(afterFinalRestart.states.get(second)).toBe("not_configured");
  });

  it.each(["unreadable", "evaluation-rejected"]) ("fails closed when browser storage is %s", async (storageMode) => {
    const page = new FakeSmokePage({ storageMode });

    await expect(runWordPressCredentialsUiSmoke(page, {
      runtime: "browser-mock",
      origin: page.origins[0],
    })).rejects.toThrow("browser storage could not be inspected; credential leak status is unverified");
    expect(page.states.get(page.origins[1])).toBe("configured");
  });
});
