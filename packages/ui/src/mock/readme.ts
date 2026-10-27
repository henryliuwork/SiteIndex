import type { SiteIndexApi } from "@siteindex/shared";
import { beginRun, clone, delay, projectKey, reply, userReadmeBlocks } from "./context";

export function createReadmeMock(): SiteIndexApi["readme"] {
  return {
    get: (id) => reply(() => ({
      user_blocks: userReadmeBlocks[projectKey(id)],
      auto_blocks: [
        { id: "index-summary", title: "网站数据速览", updated_at: "2026-10-19T05:00:00+08:00", schedule: "每日同步后" },
        { id: "task-routing", title: "任务路由", updated_at: null, schedule: "skill 更新后" },
        { id: "data-guide", title: "数据指南", updated_at: null, schedule: "规范升级后" },
        { id: "design-summary", title: "设计规范速览", updated_at: "2026-10-01T04:00:00+08:00", schedule: "每月" },
        { id: "changelog", title: "变更记录", updated_at: "2026-10-22T05:00:00+08:00", schedule: "每次运行" },
      ],
      folder_map: [],
    })),
    saveUserBlocks: (id, blocks) => reply(() => { userReadmeBlocks[projectKey(id)] = clone(blocks); }),
    refresh: async (id) => { await delay(); return { runId: beginRun("C:/SiteIndex/Projects/" + id, "readme") }; },
  };
}
