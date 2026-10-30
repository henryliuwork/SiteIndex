import { describe, expect, it, vi } from "vitest";
import { createWindowThenReconcileInBackground } from "./startup-reconciliation.js";

describe("createWindowThenReconcileInBackground", () => {
  it("opens the window first and does not wait for schedule reconciliation", async () => {
    let finishReconcile: (() => void) | undefined;
    const reconcilePromise = new Promise<void>((resolve) => {
      finishReconcile = resolve;
    });
    const order: string[] = [];
    const createWindow = vi.fn(async () => {
      order.push("window");
      return "window-handle";
    });
    const reconcile = vi.fn(() => {
      order.push("reconcile");
      return reconcilePromise;
    });

    await expect(createWindowThenReconcileInBackground(createWindow, reconcile, vi.fn())).resolves.toBe(
      "window-handle",
    );

    expect(order).toEqual(["window", "reconcile"]);
    expect(reconcile).toHaveBeenCalledOnce();
    finishReconcile?.();
  });

  it("reports background reconciliation errors without rejecting window startup", async () => {
    const error = new Error("schedule reconciliation failed");
    const reportError = vi.fn();

    await expect(
      createWindowThenReconcileInBackground(
        async () => "window-handle",
        async () => {
          throw error;
        },
        reportError,
      ),
    ).resolves.toBe("window-handle");
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(error));
  });
});
