import type { RunnerState, SiteIndexApi } from "@siteindex/shared";
import { notifyProjectChanged, projectKey, projectSummaries, reply, runners } from "./context";

export function createRunnerMock(): SiteIndexApi["runner"] {
  return {
    get: (id) => reply<RunnerState>(() => ({ runner: runners[projectKey(id)], this_device: { device_id: "mock-device", device_name: "Henry-PC" }, is_this_device: projectKey(id) === "kingsyard" })),
    claim: (id) => reply<RunnerState>(() => {
      const key = projectKey(id);
      runners[key] = { device_id: "mock-device", device_name: "本地开发工作站", claimed_at: new Date().toISOString() };
      projectSummaries[key] = { ...projectSummaries[key], runner_device: runners[key].device_name, is_runner: true };
      notifyProjectChanged(id);
      return { runner: runners[key], this_device: { device_id: "mock-device", device_name: "Henry-PC" }, is_this_device: true };
    }),
  };
}
