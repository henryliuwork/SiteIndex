import { createPageRoute } from "../create-page-route";

export const route = createPageRoute("/new/*", "正在打开新建向导…", () => import("../NewProjectWizardPage").then(({ NewProjectWizardPage }) => ({ default: NewProjectWizardPage })));
