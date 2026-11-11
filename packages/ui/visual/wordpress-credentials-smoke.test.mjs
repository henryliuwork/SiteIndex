import { describe, expect, it } from "vitest";
import { runWordPressCredentialsUiSmoke } from "./wordpress-credentials-smoke.mjs";

describe("WordPress credential UI smoke safety gates", () => {
  it("requires the caller to attest temp-profile and vault isolation before packaged Electron", async () => {
    const page = { url: () => "file:///C:/Program%20Files/SiteIndex/index.html" };

    await expect(runWordPressCredentialsUiSmoke(page, {
      runtime: "packaged-electron",
      origin: "https://siteindex-synthetic.invalid",
    })).rejects.toThrow("caller must confirm profile and vault isolation before Electron launch");
  });

  it("rejects packaged Electron paths that escape the temporary isolation root", async () => {
    const page = { url: () => "file:///C:/Program%20Files/SiteIndex/index.html" };

    await expect(runWordPressCredentialsUiSmoke(page, {
      runtime: "packaged-electron",
      origin: "https://siteindex-synthetic.invalid",
      electronIsolation: {
        verifiedBeforeLaunch: true,
        root: "C:\\Temp\\siteindex-test-run",
        appDataRoot: "C:\\Users\\Administrator\\AppData\\Roaming",
        localAppDataRoot: "C:\\Temp\\siteindex-test-run\\local-app-data",
        projectRoot: "C:\\Temp\\siteindex-test-run\\projects",
        vaultPath: "C:\\Temp\\siteindex-test-run\\local-app-data\\SiteIndex\\LocalCredentials",
      },
    })).rejects.toThrow("APPDATA must be inside the verified temporary isolation root");
  });
});
