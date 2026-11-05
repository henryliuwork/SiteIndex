import { describe, expect, it } from "vitest";
import { createScheduleReconciliationQueue } from "./reconciliation-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("schedule reconciliation queue", () => {
  it("serializes reconciliations and lets callers wait for a project's background registration", async () => {
    const queue = createScheduleReconciliationQueue();
    const firstGate = deferred();
    const events: string[] = [];
    let secondFinished = false;

    const first = queue.enqueueForProject("fictional-shop", async () => {
      events.push("first-start");
      await firstGate.promise;
      events.push("first-end");
    });
    const second = queue.enqueue(async () => {
      events.push("second-start");
      secondFinished = true;
      events.push("second-end");
    });
    let projectWaitFinished = false;
    const projectWait = queue.waitForProject("fictional-shop").then(() => {
      projectWaitFinished = true;
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    expect(secondFinished).toBe(false);
    expect(projectWaitFinished).toBe(false);

    firstGate.resolve();
    await Promise.all([first, second, projectWait]);

    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
    expect(projectWaitFinished).toBe(true);
    await queue.waitForProject("fictional-shop");
  });

  it("continues after a failed reconciliation and does not leave a project stuck pending", async () => {
    const queue = createScheduleReconciliationQueue();
    await expect(
      queue.enqueueForProject("fictional-shop", async () => {
        throw new Error("denied");
      }),
    ).rejects.toThrow("denied");
    await queue.waitForProject("fictional-shop");

    await expect(queue.enqueue(async () => "ready")).resolves.toBe("ready");
  });
});
