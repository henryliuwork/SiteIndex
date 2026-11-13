import type { SiteIndexApi } from "@siteindex/shared";
import { createAppMock } from "./app";
import { createUiStateMock } from "./ui-state";
import { createSettingsMock } from "./settings";
import { createProjectsMock } from "./projects";
import { createSkuMock } from "./sku";
import { createOverviewMock } from "./overview";
import { createInventoryMock } from "./inventory";
import { createProductsMock } from "./products";
import { createSeoMock } from "./seo";
import { createContentMock } from "./content";
import { createEdmMock } from "./edm";
import { createDesignMock } from "./design";
import { createReadmeMock } from "./readme";
import { createCategoriesMock } from "./categories";
import { createFoldersMock } from "./folders";
import { createFilesMock } from "./files";
import { createJobsMock } from "./jobs";
import { createScheduleMock } from "./schedule";
import { createRunnerMock } from "./runner";
import { createSkillsMock } from "./skills";
import { createShellMock } from "./shell";
import { createUpdatesMock } from "./updates";
import { createWorkspaceMock } from "./workspace";
import { createGscMock } from "./gsc";

export function createMockApi(options: { seoIssueStatus?: boolean; wordpressImageHostDemo?: boolean } = {}): SiteIndexApi {
  const seo = createSeoMock();
  const workspace = createWorkspaceMock();
  if (!options.seoIssueStatus) delete seo.setIssueStatus;
  return Object.assign({
    app: createAppMock(),
    uiState: createUiStateMock(),
    settings: createSettingsMock(),
    projects: createProjectsMock(workspace, { wordpressImageHostDemo: options.wordpressImageHostDemo }),
    sku: createSkuMock(),
    overview: createOverviewMock(),
    inventory: createInventoryMock(),
    products: createProductsMock(),
    seo,
    content: createContentMock(),
    edm: createEdmMock(),
    design: createDesignMock(),
    readme: createReadmeMock(),
    categories: createCategoriesMock(),
    folders: createFoldersMock(),
    files: createFilesMock(),
    jobs: createJobsMock(),
    schedule: createScheduleMock(),
    runner: createRunnerMock(),
    skills: createSkillsMock(),
    shell: createShellMock(),
    gsc: createGscMock(),
  }, { updates: createUpdatesMock(), workspace: workspace.api });
}
