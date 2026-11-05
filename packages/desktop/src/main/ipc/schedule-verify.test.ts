import { describe, expect, it, vi } from "vitest";
import { createScheduleHandlers } from "./schedule.js";
import type { IpcContext } from "./context.js";
import type { ScheduleConfig } from "@siteindex/shared";

const config: ScheduleConfig = {
  daily: { enabled: true, days: [1], time: "02:00" },
  validate: { enabled: false, days: [1], time: "03:00" },
  weekly: { enabled: false, days: [1], time: "04:30" },
  readme: { enabled: false, days: [1], time: "05:00" },
  monthly: { enabled: false, day_of_month: 15, time: "06:15" },
  options: { wake_to_run: true, run_if_missed: true, notify_on_failure: false, validate_after_sync: false },
};

function context(verification: ReturnType<typeof vi.fn>, authorizationRequired = false) {
  const reconcileSchedules = vi.fn(async () => ({
    mode: "system" as const,
    authorization_required: authorizationRequired,
  }));
  const value = {
    core: {
      schedule: { get: vi.fn(async () => ({ config })) },
      runner: { get: vi.fn(async () => ({ is_this_device: true })) },
    },
    projects: { resolveProject: vi.fn(() => "C:\\Synthetic\\project") },
    scheduler: { verify: verification },
    reconcileSchedules,
    waitForProjectScheduleReconciliation: vi.fn(async () => undefined),
    withProject: async <T>(_id: unknown, run: (id: string) => Promise<T>) => run("synthetic-project"),
  } as unknown as IpcContext;
  return { value, reconcileSchedules };
}

describe("schedule.verify IPC", () => {
  it("repairs a mismatched schedule and verifies it again", async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ state: "unregistered" as const, message: "missing" })
      .mockResolvedValueOnce({ state: "ok" as const });
    const { value, reconcileSchedules } = context(verify);
    const handler = createScheduleHandlers(value)["schedule.verify"];

    await expect(handler?.("synthetic-project", { repair: true })).resolves.toEqual({ state: "ok", repaired: true });
    expect(reconcileSchedules).toHaveBeenCalledOnce();
    expect(reconcileSchedules).toHaveBeenCalledWith(true);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("reports when repair needs administrator authorization", async () => {
    const verify = vi.fn(async () => ({ state: "path_mismatch" as const }));
    const { value, reconcileSchedules } = context(verify, true);

    await expect(
      createScheduleHandlers(value)["schedule.verify"]?.("synthetic-project", { repair: true }),
    ).resolves.toMatchObject({
      state: "error",
      repaired: false,
      message: expect.stringContaining("管理员授权"),
    });
    expect(reconcileSchedules).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
  });

  it("waits for background registration before returning verification to the project center", async () => {
    let finishRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    const order: string[] = [];
    const verify = vi.fn(async () => {
      order.push("verify");
      return { state: "ok" as const };
    });
    const { value } = context(verify);
    value.waitForProjectScheduleReconciliation = vi.fn(async () => {
      order.push("registration-start");
      await registration;
      order.push("registration-finished");
    });
    const handler = createScheduleHandlers(value)["schedule.verify"];
    const verification = handler?.("synthetic-project");

    await Promise.resolve();
    expect(order).toEqual(["registration-start"]);
    expect(verify).not.toHaveBeenCalled();

    finishRegistration();
    await expect(verification).resolves.toMatchObject({ state: "ok" });
    expect(order).toEqual(["registration-start", "registration-finished", "verify"]);
  });
});
