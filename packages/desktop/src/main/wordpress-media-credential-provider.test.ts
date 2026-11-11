import { describe, expect, it, vi } from "vitest";
import { createWordPressMediaCredentialProvider } from "./wordpress-media-credential-provider.js";

describe("main-process WordPress media credential provider", () => {
  it("looks up encrypted credentials only for the configured project origin", async () => {
    const credential = { username: "fixture-user", applicationPassword: "fixture-password" };
    const getForHost = vi.fn(async () => credential);
    const getProject = vi.fn(async () => ({
      config: { base_url: "https://fixture.example.test/shop", edm: { image_host: { type: "wordpress" } } },
    }));
    const provider = createWordPressMediaCredentialProvider({ getProject, vault: { getForHost } });

    await expect(provider("fixture-project")).resolves.toEqual(credential);

    expect(getProject).toHaveBeenCalledWith("fixture-project");
    expect(getForHost).toHaveBeenCalledWith("https://fixture.example.test/shop");
  });

  it("does not read the vault when the project is not configured for WordPress media", async () => {
    const getForHost = vi.fn(async () => ({ username: "fixture-user", applicationPassword: "fixture-password" }));
    const provider = createWordPressMediaCredentialProvider({
      getProject: async () => ({ config: { base_url: "https://fixture.example.test", edm: { image_host: undefined } } }),
      vault: { getForHost },
    });

    await expect(provider("fixture-project")).rejects.toMatchObject({
      code: "WP_NOT_CONFIGURED",
      message: "该项目尚未配置 WordPress 媒体托管。",
    });
    expect(getForHost).not.toHaveBeenCalled();
  });

  it.each([
    ["missing credential", async () => null, "尚未配置此项目的 WordPress 应用程序密码。"],
    ["unavailable vault", async () => { throw new Error("fixture machine path detail"); }, "本机 WordPress 凭据不可用，请在设置中重新保存。"],
  ])("returns a stable local-credential error for a %s", async (_label, read, message) => {
    const provider = createWordPressMediaCredentialProvider({
      getProject: async () => ({
        config: { base_url: "https://fixture.example.test", edm: { image_host: { type: "wordpress" } } },
      }),
      vault: { getForHost: read },
    });

    const error = await provider("fixture-project").then(() => null, (cause: unknown) => cause);
    expect(error).toMatchObject({ code: "WP_NOT_CONFIGURED", message });
    expect(String(error)).not.toContain("fixture machine path detail");
  });

  it("does not expose project lookup errors or machine details", async () => {
    const provider = createWordPressMediaCredentialProvider({
      getProject: async () => { throw new Error("fixture project path detail"); },
      vault: { getForHost: vi.fn(async () => null) },
    });

    const error = await provider("fixture-project").then(() => null, (cause: unknown) => cause);
    expect(error).toMatchObject({ code: "PROJECT_NOT_FOUND", message: "项目配置不可用，无法准备媒体任务。" });
    expect(String(error)).not.toContain("fixture project path detail");
  });
});
