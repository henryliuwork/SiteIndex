import { describe, expect, it, vi } from "vitest";
import { createCredentialRegionWaitPage } from "../scripts/credential-region-wait.mjs";

describe("packaged credential region wait", () => {
  it("uses an exact accessible name and waits for one stable region", async () => {
    const locator = { count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValueOnce(1) };
    const page = { getByRole: vi.fn(() => locator), url: vi.fn(() => "file:///ui/index.html") };
    let clock = 0;
    const wrapped = createCredentialRegionWaitPage(page, {
      timeoutMs: 30,
      intervalMs: 1,
      stableSamples: 2,
      now: () => clock,
      sleep: async (duration) => {
        clock += duration;
      },
    });

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
    let clock = 0;
    const wrapped = createCredentialRegionWaitPage(page, {
      timeoutMs: 2,
      intervalMs: 1,
      stableSamples: 2,
      now: () => clock,
      sleep: async (duration) => {
        clock += duration;
      },
    });

    await expect(
      wrapped.getByRole("region", { name: "凭据：https://missing.synthetic.invalid" }).count(),
    ).resolves.toBe(-1);
    await expect(
      wrapped.getByRole("region", { name: "凭据：https://duplicate.synthetic.invalid" }).count(),
    ).resolves.toBe(-1);
  });

  it.each([
    { label: "missing", counts: [0, 0, 1] },
    { label: "duplicate", counts: [2, 2, 1] },
  ])("does not accept a single final match after an unstable $label sequence", async ({ counts }) => {
    const locator = {
      count: vi.fn().mockResolvedValueOnce(counts[0]).mockResolvedValueOnce(counts[1]).mockResolvedValueOnce(counts[2]),
    };
    const page = { getByRole: vi.fn(() => locator) };
    let clock = 0;
    const wrapped = createCredentialRegionWaitPage(page, {
      timeoutMs: 2,
      intervalMs: 1,
      stableSamples: 2,
      now: () => clock,
      sleep: async (duration) => {
        clock += duration;
      },
    });

    await expect(wrapped.getByRole("region", { name: "凭据：https://synthetic.invalid" }).count()).resolves.toBe(-1);
    expect(locator.count).toHaveBeenCalledTimes(3);
  });

  it("leaves other page roles unchanged", () => {
    const heading = { count: vi.fn().mockResolvedValue(1) };
    const page = { getByRole: vi.fn(() => heading) };
    const wrapped = createCredentialRegionWaitPage(page);

    expect(wrapped.getByRole("heading", { name: "页面标题" })).toBe(heading);
    expect(page.getByRole).toHaveBeenCalledWith("heading", { name: "页面标题" });
  });
});
