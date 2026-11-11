import { describe, expect, it, vi } from "vitest";
import { createCredentialRegionWaitPage } from "../scripts/credential-region-wait.mjs";

describe("packaged credential region wait", () => {
  it("uses an exact accessible name and waits for one stable region", async () => {
    const locator = { count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValueOnce(1) };
    const page = { getByRole: vi.fn(() => locator), url: vi.fn(() => "file:///ui/index.html") };
    const wrapped = createCredentialRegionWaitPage(page, { timeoutMs: 30, intervalMs: 1, stableSamples: 2 });

    const region = wrapped.getByRole("region", { name: "凭据：https://synthetic.invalid" });
    await expect(region.count()).resolves.toBe(1);

    expect(page.getByRole).toHaveBeenCalledWith("region", {
      name: "凭据：https://synthetic.invalid",
      exact: true,
    });
    expect(locator.count).toHaveBeenCalledTimes(3);
    expect(wrapped.url()).toBe("file:///ui/index.html");
  });

  it("keeps failing when a credential origin is persistently missing or duplicated", async () => {
    const missing = { count: vi.fn().mockResolvedValue(0) };
    const duplicate = { count: vi.fn().mockResolvedValue(2) };
    const page = { getByRole: vi.fn().mockReturnValueOnce(missing).mockReturnValueOnce(duplicate) };
    const wrapped = createCredentialRegionWaitPage(page, { timeoutMs: 5, intervalMs: 1, stableSamples: 2 });

    await expect(wrapped.getByRole("region", { name: "凭据：https://missing.synthetic.invalid" }).count()).resolves.toBe(0);
    await expect(wrapped.getByRole("region", { name: "凭据：https://duplicate.synthetic.invalid" }).count()).resolves.toBe(2);
  });

  it("leaves other page roles unchanged", () => {
    const heading = { count: vi.fn().mockResolvedValue(1) };
    const page = { getByRole: vi.fn(() => heading) };
    const wrapped = createCredentialRegionWaitPage(page);

    expect(wrapped.getByRole("heading", { name: "页面标题" })).toBe(heading);
    expect(page.getByRole).toHaveBeenCalledWith("heading", { name: "页面标题" });
  });
});
