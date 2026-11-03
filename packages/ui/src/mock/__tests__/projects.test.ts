import type { ProjectId } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { clone, projectConfigs, projectSummaries, projectsChanged } from "../context";
import { createProjectsMock, mockProjectNonFeedWarnings } from "../projects";

const originalSummary = clone(projectSummaries.demo2);
const originalConfig = clone(projectConfigs.demo2);
const originalNonFeedWarnings = clone(mockProjectNonFeedWarnings.demo2);

afterEach(() => {
  projectSummaries.demo2 = clone(originalSummary);
  projectConfigs.demo2 = clone(originalConfig);
  mockProjectNonFeedWarnings.demo2 = clone(originalNonFeedWarnings);
  projectsChanged.clear();
});

describe("projects mock summary updates", () => {
  it("adds existing project paths to the list and rejects normalized duplicates", async () => {
    const api = createProjectsMock();
    const path = "D:/SiteIndex/Projects/Cedar Shop";
    const added = await api.addExisting(path);

    expect(added.path).toBe(path);
    expect((await api.list()).filter(({ id }) => id === added.id)).toHaveLength(1);
    expect(await api.get(added.id)).toMatchObject({ summary: { id: added.id, path, name: "Cedar Shop" } });
    await expect(api.addExisting("d:\\siteindex\\projects\\cedar shop\\")).rejects.toMatchObject({
      code: "FOLDER_EXISTS",
      message: "该项目已添加到项目中心。",
    });
    expect((await api.list()).filter(({ id }) => id === added.id)).toHaveLength(1);
  });

  it("clears the feed warning and emits a project change after saving a feed", async () => {
    const api = createProjectsMock();
    const feedWarning = "尚未填写 GMC Feed 地址，每日库存同步未启用。";
    expect((await api.list()).find(({ id }) => id === "demo2")?.warnings).toContain(feedWarning);

    const changes: ProjectId[] = [];
    const unsubscribe = api.onChanged((id) => changes.push(id));
    const project = await api.get("demo2");
    await api.updateConfig("demo2", {
      crawl: { ...project.config.crawl, feed_url: "https://feed.example.test/products.xml" },
    });

    const updated = (await api.list()).find(({ id }) => id === "demo2");
    const updatedDetail = await api.get("demo2");
    expect(updated?.warnings).not.toContain(feedWarning);
    expect(updated?.attention).toBe(0);
    expect(updatedDetail.config.crawl.feed_url).toBe("https://feed.example.test/products.xml");
    expect(changes).toEqual(["demo2"]);
    unsubscribe();
  });

  it("preserves unrelated warnings without identifying feed state from warning text", async () => {
    const api = createProjectsMock();
    mockProjectNonFeedWarnings.demo2 = ["最近一次同步失败"];
    projectSummaries.demo2 = { ...projectSummaries.demo2, warnings: ["最近一次同步失败"] };
    const project = await api.get("demo2");

    await api.updateConfig("demo2", {
      crawl: { ...project.config.crawl, feed_url: "https://feed.example.test/products.xml" },
    });

    const updated = (await api.list()).find(({ id }) => id === "demo2");
    expect(updated?.warnings).toEqual(["最近一次同步失败"]);
  });
});
