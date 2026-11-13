import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/p/:id/todos", "正在打开项目待办…", () => import("../ProjectTodosPage").then(({ ProjectTodosPage }) => ({ default: ProjectTodosPage })));
