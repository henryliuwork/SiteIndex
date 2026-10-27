import type { UpdatesApi, UpdateStatus } from "../updates";
import { reply } from "./context";

const NOTES = "修复稳定性问题并改进库存视图加载速度。\n\n此 mock 仅演示更新流程。";

export function createUpdatesMock(): UpdatesApi {
  let current: UpdateStatus = {
    state: "available", current: "0.1.0", latest: "0.1.1", notes: NOTES,
  };
  let downloadTimer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<(status: UpdateStatus) => void>();
  const publish = (next: UpdateStatus) => {
    current = next;
    listeners.forEach((listener) => listener(current));
  };

  return {
    check: () => reply(() => {
      if (current.state === "idle" || current.state === "checking") return current;
      if (current.state === "downloading" || current.state === "ready" || current.state === "unsupported") return current;
      const next = { state: "available" as const, current: "0.1.0", latest: "0.1.1", notes: NOTES };
      publish(next);
      return next;
    }),
    download: () => reply(() => {
      if (downloadTimer) clearInterval(downloadTimer);
      publish({ state: "downloading", current: "0.1.0", latest: "0.1.1", percent: 0, notes: NOTES });
      downloadTimer = setInterval(() => {
        if (current.state !== "downloading") return;
        const percent = Math.min(100, (current.percent ?? 0) + 20);
        if (percent === 100) {
          publish({ state: "ready", current: current.current, latest: current.latest, notes: current.notes });
          if (downloadTimer) clearInterval(downloadTimer);
        } else publish({ ...current, percent });
      }, 1100);
    }),
    install: () => reply(() => {
      if (downloadTimer) clearInterval(downloadTimer);
      publish({ state: "idle", current: "0.1.1", latest: "0.1.1" });
    }),
    onStatus: (callback) => {
      listeners.add(callback);
      callback(current);
      return () => listeners.delete(callback);
    },
  };
}
