import { describe, expect, it } from "vitest";
import { createMockWordPressCredentialsBridge } from "../wordpress-credentials";

describe("WordPress credentials browser mock", () => {
  it("keeps only status by normalized HTTPS origin and never returns credential fields", async () => {
    const bridge = createMockWordPressCredentialsBridge();
    const secret = "synthetic-only-password";
    const siteUrl = "https://demo.example.test/store/";

    await expect(bridge.status("https://demo.example.test/other-path")).resolves.toEqual({ state: "not_configured" });
    await bridge.save({ siteUrl, username: "synthetic-user", applicationPassword: secret });
    const saved = await bridge.status("https://demo.example.test:443/");
    expect(saved).toEqual({ state: "configured" });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(JSON.stringify(saved)).not.toContain("synthetic-user");

    await bridge.clear("https://demo.example.test/");
    await expect(bridge.status(siteUrl)).resolves.toEqual({ state: "not_configured" });
  });

  it("rejects non-HTTPS origins", async () => {
    const bridge = createMockWordPressCredentialsBridge();
    await expect(bridge.status("http://demo.example.test")).rejects.toThrow("HTTPS");
  });
});
