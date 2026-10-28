import type { ProjectId } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { clone, projectConfigs, projectSummaries, projectsChanged } from "../context";
import { createProjectsMock } from "../projects";

const originalSummary = clone(projectSummaries.riverstone);
const originalConfig = clone(projectConfigs.riverstone);

afterEach(() => {
  projectSummaries.riverstone = clone(originalSummary);
  projectConfigs.riverstone = clone(originalConfig);
  projectsChanged.clear();
});

describe("projects mock summary updates", () => {
  it("clears the feed warning and emits a project change after saving a feed", async () => {
    const api = createProjectsMock();
    const feedWarning = "尚未填写 GMC feed 地址，每日库存同步未启用。";
    expect((await api.list()).find(({ id }) => id === "riverstone")?.warnings).toContain(feedWarning);

    const changes: ProjectId[] = [];
    const unsubscribe = api.onChanged((id) => changes.push(id));
    const project = await api.get("riverstone");
    await api.updateConfig("riverstone", {
      crawl: { ...project.config.crawl, feed_url: "https://riverstoneoutdoor.com/products.xml" },
    });

    const updated = (await api.list()).find(({ id }) => id === "riverstone");
    expect(updated?.warnings).not.toContain(feedWarning);
    expect(updated?.attention).toBe(0);
    expect(changes).toEqual(["riverstone"]);
    unsubscribe();
  });
});