# 界面画板（MVP 设计稿）

- `screens/*.png`：21 个画板的截图（1440 宽）。**开发时以截图为视觉参考**
- `demo/*.dc.html`：画板源码。结构、文案、颜色、间距可直接查阅；它们依赖设计工具的运行时，不能直接在浏览器打开
- 在线可交互版本（需要项目负责人账号权限）：https://claude.ai/artifact/39xeeUg4VrXHuZe7BuxdTF

| # | 画板 | 截图 | 路由 | PRD |
|---|---|---|---|---|
| 1 | Main | [Main.png](screens/Main.png) | `/` | §5.1 |
| 2 | NewProjectUrl | [NewProjectUrl.png](screens/NewProjectUrl.png) | `/new/url` | §5.2 |
| 3 | NewProject | [NewProject.png](screens/NewProject.png) | `/new/source` | §5.2 |
| 4 | NewProjectBrand | [NewProjectBrand.png](screens/NewProjectBrand.png) | `/new/brand` | §5.2 |
| 5 | NewProjectDone | [NewProjectDone.png](screens/NewProjectDone.png) | `/new/done` | §5.2 |
| 6 | Overview | [Overview.png](screens/Overview.png) | `/p/:id` | §5.3 |
| 7 | Inventory | [Inventory.png](screens/Inventory.png) | `/p/:id/inventory` | §5.4 |
| 8 | Products | [Products.png](screens/Products.png) | `/p/:id/products` | §5.5 |
| 9 | SEO | [SEO.png](screens/SEO.png) | `/p/:id/seo` | §5.6 |
| 10 | Content | [Content.png](screens/Content.png) | `/p/:id/content` | §5.7 |
| 11 | Edm | [Edm.png](screens/Edm.png) | `/p/:id/edm` | §5.8 |
| 12 | Design | [Design.png](screens/Design.png) | `/p/:id/design` | §5.9 |
| 13 | Readme | [Readme.png](screens/Readme.png) | `/p/:id/readme` | §5.10 |
| 14 | ProjectSettings | [ProjectSettings.png](screens/ProjectSettings.png) | `/p/:id/settings/config` | §5.11 |
| 15 | Categories | [Categories.png](screens/Categories.png) | `/p/:id/settings/categories` | §5.11 |
| 16 | Folders | [Folders.png](screens/Folders.png) | `/p/:id/settings/folders` | §5.11 |
| 17 | LocalFiles | [LocalFiles.png](screens/LocalFiles.png) | `/p/:id/settings/files` | §5.11 |
| 18 | Runs | [Runs.png](screens/Runs.png) | `/p/:id/runs` | §5.12 |
| 19 | Skills | [Skills.png](screens/Skills.png) | `/skills` | §5.13 |
| 20 | AppSettings | [AppSettings.png](screens/AppSettings.png) | `/settings` | §5.14 |
| 21 | DataSchema | [DataSchema.png](screens/DataSchema.png) | — | 数据表结构说明（对照 DATA_SPEC） |

截图中的点击态（详情面板、弹窗）只展示了默认状态；交互细节以 PRD 与 DESIGN.md §4 为准，画板源码里的 `<script type="text/x-dc">` 段落也描述了各状态的行为。
