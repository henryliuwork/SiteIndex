import { afterEach, describe, expect, it } from "vitest";
import { clone, scheduleStates } from "../context";
import { createScheduleMock } from "../schedule";

const originalScheduleStates = clone(scheduleStates);

afterEach(() => {
  scheduleStates.demo = clone(originalScheduleStates.demo);
  scheduleStates.demo2 = clone(originalScheduleStates.demo2);
});

describe("schedule mock verification", () => {
  it("reports a path mismatch and repairs it when requested", async () => {
    const api = createScheduleMock();

    expect(await api.verify?.("demo")).toMatchObject({ state: "path_mismatch" });
    expect(await api.verify?.("demo", { repair: true })).toMatchObject({ state: "ok", repaired: true });
    expect((await api.get("demo")).registered).toBe(true);
  });

  it("lists orphan tasks and removes only the selected task", async () => {
    const api = createScheduleMock();
    const initial = await api.listOrphans?.();
    expect(initial).toHaveLength(1);

    await api.removeOrphan?.("SiteIndex-demo-orphan");

    expect(await api.listOrphans?.()).toEqual([]);
  });
});
