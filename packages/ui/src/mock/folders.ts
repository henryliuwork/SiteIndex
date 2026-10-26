import type { SiteIndexApi } from "@siteindex/shared";
import { folderRows, projectKey, reply } from "./context";

export function createFoldersMock(): SiteIndexApi["folders"] {
  return {
    list: (id) => reply(folderRows[projectKey(id)]),
    create: (id, name, description) => reply(() => {
      const key = projectKey(id);
      folderRows[key] = [...folderRows[key], { name, description, default: false, files: 0, modified_at: null }];
      return folderRows[key];
    }),
    describe: (id, name, description) => reply(() => {
      const key = projectKey(id);
      folderRows[key] = folderRows[key].map((row) => row.name === name ? { ...row, description } : row);
      return folderRows[key];
    }),
    remove: (id, name) => reply(() => {
      const key = projectKey(id);
      folderRows[key] = folderRows[key].filter((row) => row.name !== name || row.default);
      return folderRows[key];
    }),
    open: () => reply(undefined),
  };
}
