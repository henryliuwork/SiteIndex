import { describe, expect, it, vi } from "vitest";
import type { CoreService } from "@siteindex/core";
import { PENDING_HANDLERS } from "@siteindex/shared";
import { isMediaPrepareReady } from "./media-readiness.js";

const core = { runJob: vi.fn() } as unknown as Pick<CoreService, "runJob">;

describe("media prepare production readiness", () => {
  it("stays closed before the Core service exists", () => {
    expect(isMediaPrepareReady(null, [])).toBe(false);
  });

  it("stays closed while the shared contract lists media.prepare as pending", () => {
    expect(isMediaPrepareReady(core, ["media.prepare"])).toBe(false);
    expect(isMediaPrepareReady(core)).toBe(!PENDING_HANDLERS.includes("media.prepare"));
  });

  it("opens only after Core is available and the contract pending marker is cleared", () => {
    expect(isMediaPrepareReady(core, [])).toBe(true);
    expect(isMediaPrepareReady(null, [])).toBe(false);
  });
});
